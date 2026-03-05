import type { Database } from "bun:sqlite";
import { dirname, extname, resolve } from "node:path";
import { normalizePath } from "../utils/paths";
import { detectLanguageFromPath } from "./metadata-index";

export interface SourceFileForImportExtraction {
  path: string;
  content: string;
  language?: string;
}

export interface ExtractedImportRecord {
  sourcePath: string;
  importedPath: string;
  importedNames: string[];
  isReexport: boolean;
}

export interface ExtractImportsOptions {
  knownRepoPaths?: readonly string[];
}

export interface IndexFileImportsOptions extends ExtractImportsOptions {
  wrapInTransaction?: boolean;
}

export interface IndexFileImportsResult {
  indexedFileCount: number;
  importCount: number;
  skippedFileCount: number;
}

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const PYTHON_EXTENSIONS = [".py"];
const GO_EXTENSIONS = [".go"];
const RUST_EXTENSIONS = [".rs"];

function sortImports(records: ExtractedImportRecord[]): ExtractedImportRecord[] {
  return records
    .slice()
    .sort((left, right) => {
      if (left.sourcePath !== right.sourcePath) {
        return left.sourcePath.localeCompare(right.sourcePath);
      }
      if (left.importedPath !== right.importedPath) {
        return left.importedPath.localeCompare(right.importedPath);
      }
      const leftNames = left.importedNames.join(",");
      const rightNames = right.importedNames.join(",");
      if (leftNames !== rightNames) {
        return leftNames.localeCompare(rightNames);
      }
      return Number(left.isReexport) - Number(right.isReexport);
    });
}

function normalizeNames(names: string[]): string[] {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const aliasIndex = name.indexOf(" as ");
      if (aliasIndex >= 0) {
        return name.slice(0, aliasIndex).trim();
      }
      return name;
    })
    .sort((left, right) => left.localeCompare(right));
}

function addRecord(
  records: ExtractedImportRecord[],
  dedupe: Set<string>,
  record: ExtractedImportRecord,
): void {
  const key = `${record.sourcePath}\t${record.importedPath}\t${record.importedNames.join(",")}\t${record.isReexport ? 1 : 0}`;
  if (dedupe.has(key)) {
    return;
  }
  dedupe.add(key);
  records.push(record);
}

function resolveCandidate(
  candidates: readonly string[],
  knownRepoPaths: Set<string>,
): string | null {
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/");
    if (knownRepoPaths.has(normalized)) {
      return normalized;
    }
  }
  return null;
}

function resolveRelativeImportPath(
  sourcePath: string,
  rawImportPath: string,
  knownRepoPaths: Set<string>,
): string | null {
  const sourceDir = dirname(sourcePath);
  const base = normalizePath(resolve(sourceDir, rawImportPath), ".");

  const candidates: string[] = [base];
  for (const ext of JS_EXTENSIONS) {
    candidates.push(`${base}${ext}`);
    candidates.push(`${base}/index${ext}`);
  }
  for (const ext of PYTHON_EXTENSIONS) {
    candidates.push(`${base}${ext}`);
    candidates.push(`${base}/__init__${ext}`);
  }
  for (const ext of GO_EXTENSIONS) {
    candidates.push(`${base}${ext}`);
  }
  for (const ext of RUST_EXTENSIONS) {
    candidates.push(`${base}${ext}`);
    candidates.push(`${base}/mod${ext}`);
  }

  return resolveCandidate(candidates, knownRepoPaths);
}

function resolveNonRelativeImportPath(
  rawImportPath: string,
  language: string,
  knownRepoPaths: Set<string>,
): string | null {
  if (language === "python") {
    const modulePath = rawImportPath.replace(/\./g, "/");
    return (
      resolveCandidate(
        [modulePath, `${modulePath}.py`, `${modulePath}/__init__.py`],
        knownRepoPaths,
      ) ?? null
    );
  }

  if (language === "rust") {
    const modulePath = rawImportPath
      .replace(/^crate::/, "")
      .replace(/^self::/, "")
      .replace(/^super::/, "")
      .replace(/::/g, "/");
    return (
      resolveCandidate(
        [modulePath, `${modulePath}.rs`, `${modulePath}/mod.rs`],
        knownRepoPaths,
      ) ?? null
    );
  }

  if (language === "go") {
    return resolveCandidate([rawImportPath, `${rawImportPath}.go`], knownRepoPaths);
  }

  return resolveCandidate(
    [rawImportPath, `${rawImportPath}.ts`, `${rawImportPath}.js`],
    knownRepoPaths,
  );
}

function resolveImportedPath(
  sourcePath: string,
  rawImportPath: string,
  language: string,
  knownRepoPaths: Set<string>,
): string | null {
  if (!rawImportPath || rawImportPath.startsWith("http://") || rawImportPath.startsWith("https://")) {
    return null;
  }

  if (rawImportPath.startsWith("./") || rawImportPath.startsWith("../")) {
    return resolveRelativeImportPath(sourcePath, rawImportPath, knownRepoPaths);
  }

  return resolveNonRelativeImportPath(rawImportPath, language, knownRepoPaths);
}

function parseJsImports(
  sourcePath: string,
  content: string,
  knownRepoPaths: Set<string>,
  language: string,
): ExtractedImportRecord[] {
  const records: ExtractedImportRecord[] = [];
  const dedupe = new Set<string>();

  const fromRegex = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = fromRegex.exec(content)) !== null) {
    const namesRaw = match[1] ?? "";
    const importPath = match[2] ?? "";
    const names: string[] = [];
    if (namesRaw.includes("{")) {
      const braceMatch = namesRaw.match(/\{([^}]*)\}/);
      if (braceMatch?.[1]) {
        names.push(...braceMatch[1].split(","));
      }
      const prefix = namesRaw.split("{")[0]?.trim().replace(/,$/, "");
      if (prefix) {
        names.push(prefix);
      }
    } else if (namesRaw.trim().length > 0) {
      names.push(namesRaw.trim());
    }

    const resolved = resolveImportedPath(sourcePath, importPath, language, knownRepoPaths);
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames: normalizeNames(names),
      isReexport: false,
    });
  }

  const exportFromRegex = /^\s*export\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm;
  while ((match = exportFromRegex.exec(content)) !== null) {
    const exportSpec = (match[1] ?? "").trim();
    const importPath = match[2] ?? "";
    const names: string[] = [];
    if (exportSpec === "*") {
      names.push("*");
    } else if (exportSpec.includes("{")) {
      const braceMatch = exportSpec.match(/\{([^}]*)\}/);
      if (braceMatch?.[1]) {
        names.push(...braceMatch[1].split(","));
      }
    } else if (exportSpec.length > 0) {
      names.push(exportSpec);
    }

    const resolved = resolveImportedPath(sourcePath, importPath, language, knownRepoPaths);
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames: normalizeNames(names),
      isReexport: true,
    });
  }

  const requireRegex = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const importPath = match[1] ?? "";
    const resolved = resolveImportedPath(sourcePath, importPath, language, knownRepoPaths);
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames: [],
      isReexport: false,
    });
  }

  return sortImports(records);
}

function parsePythonImports(
  sourcePath: string,
  content: string,
  knownRepoPaths: Set<string>,
): ExtractedImportRecord[] {
  const records: ExtractedImportRecord[] = [];
  const dedupe = new Set<string>();

  let match: RegExpExecArray | null;
  const importRegex = /^\s*import\s+([A-Za-z0-9_.,\s]+)$/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const modules = (match[1] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => value.split(/\s+as\s+/i)[0] ?? value);
    for (const moduleName of modules) {
      const resolved = resolveImportedPath(
        sourcePath,
        moduleName,
        "python",
        knownRepoPaths,
      );
      if (!resolved) {
        continue;
      }
      addRecord(records, dedupe, {
        sourcePath,
        importedPath: resolved,
        importedNames: [],
        isReexport: false,
      });
    }
  }

  const fromRegex = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_.*, \t]+)$/gm;
  while ((match = fromRegex.exec(content)) !== null) {
    const moduleName = match[1] ?? "";
    const importedNames = normalizeNames((match[2] ?? "").split(","));
    const resolved = resolveImportedPath(sourcePath, moduleName, "python", knownRepoPaths);
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames,
      isReexport: false,
    });
  }

  return sortImports(records);
}

function parseGoImports(
  sourcePath: string,
  content: string,
  knownRepoPaths: Set<string>,
): ExtractedImportRecord[] {
  const records: ExtractedImportRecord[] = [];
  const dedupe = new Set<string>();
  let match: RegExpExecArray | null;

  const singleRegex = /^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"([^"]+)"\s*$/gm;
  while ((match = singleRegex.exec(content)) !== null) {
    const importPath = match[1] ?? "";
    const resolved = resolveImportedPath(sourcePath, importPath, "go", knownRepoPaths);
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames: [],
      isReexport: false,
    });
  }

  const blockRegex = /import\s*\(([\s\S]*?)\)/g;
  while ((match = blockRegex.exec(content)) !== null) {
    const block = match[1] ?? "";
    const lineRegex = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"([^"]+)"\s*$/gm;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const importPath = lineMatch[1] ?? "";
      const resolved = resolveImportedPath(sourcePath, importPath, "go", knownRepoPaths);
      if (!resolved) {
        continue;
      }
      addRecord(records, dedupe, {
        sourcePath,
        importedPath: resolved,
        importedNames: [],
        isReexport: false,
      });
    }
  }

  return sortImports(records);
}

function parseRustImports(
  sourcePath: string,
  content: string,
  knownRepoPaths: Set<string>,
): ExtractedImportRecord[] {
  const records: ExtractedImportRecord[] = [];
  const dedupe = new Set<string>();
  let match: RegExpExecArray | null;

  const useRegex = /^\s*use\s+([^;]+);/gm;
  while ((match = useRegex.exec(content)) !== null) {
    const usePath = (match[1] ?? "").trim();
    const basePath = usePath.split("::{")[0] ?? usePath;
    const namesMatch = usePath.match(/\{([^}]*)\}/);
    const importedNames = namesMatch ? normalizeNames(namesMatch[1].split(",")) : [];
    const normalizedPath = basePath.startsWith("crate::")
      ? `./${basePath.slice("crate::".length).replace(/::/g, "/")}`
      : basePath.startsWith("self::")
        ? `./${basePath.slice("self::".length).replace(/::/g, "/")}`
        : basePath.startsWith("super::")
          ? `../${basePath.slice("super::".length).replace(/::/g, "/")}`
          : basePath;
    const resolved = resolveImportedPath(
      sourcePath,
      normalizedPath,
      "rust",
      knownRepoPaths,
    );
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames,
      isReexport: false,
    });
  }

  const modRegex = /^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
  while ((match = modRegex.exec(content)) !== null) {
    const moduleName = match[1] ?? "";
    const resolved = resolveImportedPath(
      sourcePath,
      `./${moduleName}`,
      "rust",
      knownRepoPaths,
    );
    if (!resolved) {
      continue;
    }
    addRecord(records, dedupe, {
      sourcePath,
      importedPath: resolved,
      importedNames: [],
      isReexport: false,
    });
  }

  return sortImports(records);
}

export function extractImportsFromContent(
  sourcePath: string,
  content: string,
  options?: ExtractImportsOptions,
): ExtractedImportRecord[] {
  const language = detectLanguageFromPath(sourcePath);
  const knownRepoPaths = new Set(options?.knownRepoPaths ?? []);

  if (
    language === "typescript" ||
    language === "typescriptreact" ||
    language === "javascript" ||
    language === "javascriptreact"
  ) {
    return parseJsImports(sourcePath, content, knownRepoPaths, language);
  }
  if (language === "python") {
    return parsePythonImports(sourcePath, content, knownRepoPaths);
  }
  if (language === "go") {
    return parseGoImports(sourcePath, content, knownRepoPaths);
  }
  if (language === "rust") {
    return parseRustImports(sourcePath, content, knownRepoPaths);
  }
  return [];
}

function loadKnownRepoPaths(db: Database): string[] {
  return db
    .query<{ path: string }>(`SELECT path FROM files ORDER BY path ASC;`)
    .all()
    .map((row) => row.path);
}

function loadFileIdByPath(db: Database): Map<string, number> {
  const rows = db
    .query<{ id: number; path: string }>(`SELECT id, path FROM files ORDER BY path ASC;`)
    .all();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.path, row.id);
  }
  return map;
}

function sortSourceFiles(files: readonly SourceFileForImportExtraction[]): SourceFileForImportExtraction[] {
  return files.slice().sort((left, right) => left.path.localeCompare(right.path));
}

export function indexFileImportsBatch(
  db: Database,
  files: readonly SourceFileForImportExtraction[],
  options?: IndexFileImportsOptions,
): IndexFileImportsResult {
  if (files.length === 0) {
    return {
      indexedFileCount: 0,
      importCount: 0,
      skippedFileCount: 0,
    };
  }

  const knownRepoPaths = options?.knownRepoPaths ?? loadKnownRepoPaths(db);
  const fileIdByPath = loadFileIdByPath(db);
  const deleteByFileId = db.query(`DELETE FROM imports WHERE file_id = ?1;`);
  const insertImport = db.query(
    `INSERT INTO imports (file_id, imported_path, imported_names, is_reexport)
     VALUES (?1, ?2, ?3, ?4);`,
  );

  let indexedFileCount = 0;
  let skippedFileCount = 0;
  let importCount = 0;

  const apply = (): void => {
    for (const file of sortSourceFiles(files)) {
      const fileId = fileIdByPath.get(file.path);
      if (fileId === undefined) {
        skippedFileCount += 1;
        continue;
      }

      indexedFileCount += 1;
      deleteByFileId.run(fileId);
      const imports = extractImportsFromContent(file.path, file.content, {
        knownRepoPaths,
      });
      for (const entry of imports) {
        insertImport.run(
          fileId,
          entry.importedPath,
          JSON.stringify(entry.importedNames),
          entry.isReexport ? 1 : 0,
        );
        importCount += 1;
      }
    }
  };

  if (options?.wrapInTransaction ?? true) {
    const run = db.transaction(apply);
    run();
  } else {
    apply();
  }

  return {
    indexedFileCount,
    importCount,
    skippedFileCount,
  };
}

export function detectSourceLanguageFromPath(pathValue: string): string {
  const extension = extname(pathValue).toLowerCase();
  if (extension.length === 0) {
    return "text";
  }
  return detectLanguageFromPath(pathValue);
}

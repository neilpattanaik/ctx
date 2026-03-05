import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { extname, resolve } from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";

export type CodemapLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "ruby"
  | "swift"
  | "kotlin"
  | "csharp";

export const SUPPORTED_CODEMAP_LANGUAGES: readonly CodemapLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "ruby",
  "swift",
  "kotlin",
  "csharp",
];

const LANGUAGE_EXTENSION_MAP: Record<string, CodemapLanguage> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".cxx": "cpp",
  ".go": "go",
  ".h": "c",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
};

const DEFAULT_GRAMMAR_PACKAGES: Record<CodemapLanguage, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  c: "tree-sitter-c/tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  swift: "tree-sitter-swift/tree-sitter-swift.wasm",
  kotlin: "tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  csharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
};

export type CodemapParserWarningCode =
  | "LANGUAGE_UNSUPPORTED"
  | "GRAMMAR_NOT_FOUND"
  | "GRAMMAR_LOAD_FAILED"
  | "PARSER_RETURNED_NULL";

export interface CodemapParserWarning {
  language: CodemapLanguage;
  code: CodemapParserWarningCode;
  message: string;
  grammarPath?: string;
}

export interface CodemapParseResult {
  language: CodemapLanguage;
  tree: Tree | null;
  parseError: boolean;
  warnings: CodemapParserWarning[];
}

export interface CodemapParserOptions {
  projectRoot?: string;
  treeSitterWasmPath?: string;
  grammarPaths?: Partial<Record<CodemapLanguage, string>>;
  onWarning?: (warning: CodemapParserWarning) => void;
}

interface ResolvedCodemapParserOptions {
  projectRoot: string;
  treeSitterWasmPath: string;
  grammarPaths: Record<CodemapLanguage, string>;
  onWarning?: (warning: CodemapParserWarning) => void;
}

let parserInitPromise: Promise<void> | null = null;
let parserInitWasmPath: string | null = null;

async function ensureParserRuntime(treeSitterWasmPath: string): Promise<void> {
  if (parserInitPromise !== null) {
    await parserInitPromise;
    return;
  }

  parserInitWasmPath = treeSitterWasmPath;
  parserInitPromise = Parser.init({
    locateFile: () => treeSitterWasmPath,
  }).catch((error) => {
    parserInitPromise = null;
    parserInitWasmPath = null;
    throw error;
  });

  await parserInitPromise;
}

function resolveDefaultGrammarPaths(
  projectRoot: string,
): Record<CodemapLanguage, string> {
  return {
    typescript: resolve(
      projectRoot,
      "node_modules",
      DEFAULT_GRAMMAR_PACKAGES.typescript,
    ),
    javascript: resolve(
      projectRoot,
      "node_modules",
      DEFAULT_GRAMMAR_PACKAGES.javascript,
    ),
    python: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.python),
    go: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.go),
    rust: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.rust),
    java: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.java),
    c: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.c),
    cpp: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.cpp),
    ruby: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.ruby),
    swift: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.swift),
    kotlin: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.kotlin),
    csharp: resolve(projectRoot, "node_modules", DEFAULT_GRAMMAR_PACKAGES.csharp),
  };
}

function resolveOptions(options: CodemapParserOptions): ResolvedCodemapParserOptions {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const defaultWasmPath = resolve(
    projectRoot,
    "node_modules",
    "web-tree-sitter",
    "web-tree-sitter.wasm",
  );
  const defaultGrammarPaths = resolveDefaultGrammarPaths(projectRoot);

  return {
    projectRoot,
    treeSitterWasmPath: options.treeSitterWasmPath ?? defaultWasmPath,
    grammarPaths: {
      ...defaultGrammarPaths,
      ...options.grammarPaths,
    },
    onWarning: options.onWarning,
  };
}

function createWarning(
  language: CodemapLanguage,
  code: CodemapParserWarningCode,
  message: string,
  grammarPath?: string,
): CodemapParserWarning {
  return {
    language,
    code,
    message,
    grammarPath,
  };
}

async function isReadableFile(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectCodemapLanguage(pathValue: string): CodemapLanguage | null {
  const extension = extname(pathValue).toLowerCase();
  return LANGUAGE_EXTENSION_MAP[extension] ?? null;
}

export class TreeSitterCodemapParser {
  private readonly parser: Parser;
  private readonly languageCache = new Map<CodemapLanguage, Promise<Language | null>>();
  private readonly languageFailures = new Map<CodemapLanguage, CodemapParserWarning>();

  private constructor(private readonly options: ResolvedCodemapParserOptions) {
    this.parser = new Parser();
  }

  static async create(
    options: CodemapParserOptions = {},
  ): Promise<TreeSitterCodemapParser> {
    const resolved = resolveOptions(options);
    await ensureParserRuntime(resolved.treeSitterWasmPath);

    if (parserInitWasmPath !== null && parserInitWasmPath !== resolved.treeSitterWasmPath) {
      throw new Error(
        `Tree-sitter runtime already initialized with a different wasm path: ${parserInitWasmPath}`,
      );
    }

    return new TreeSitterCodemapParser(resolved);
  }

  getCachedLanguages(): CodemapLanguage[] {
    return [...this.languageCache.keys()];
  }

  dispose(): void {
    this.parser.delete();
  }

  async parse(
    content: string,
    language: CodemapLanguage,
    oldTree: Tree | null = null,
  ): Promise<CodemapParseResult> {
    const warnings: CodemapParserWarning[] = [];
    const loadedLanguage = await this.getOrLoadLanguage(language, warnings);
    if (!loadedLanguage) {
      return {
        language,
        tree: null,
        parseError: false,
        warnings,
      };
    }

    this.parser.setLanguage(loadedLanguage);
    const tree = this.parser.parse(content, oldTree);
    if (tree === null) {
      warnings.push(
        createWarning(
          language,
          "PARSER_RETURNED_NULL",
          "Tree-sitter parser returned null tree",
        ),
      );
      return {
        language,
        tree: null,
        parseError: false,
        warnings,
      };
    }

    return {
      language,
      tree,
      parseError: tree.rootNode.hasError,
      warnings,
    };
  }

  private async getOrLoadLanguage(
    language: CodemapLanguage,
    warnings: CodemapParserWarning[],
  ): Promise<Language | null> {
    let pending = this.languageCache.get(language);
    if (!pending) {
      pending = this.loadLanguage(language);
      this.languageCache.set(language, pending);
    }

    const loadedLanguage = await pending;
    if (!loadedLanguage) {
      const failure = this.languageFailures.get(language);
      if (failure) {
        warnings.push(failure);
      }
    }
    return loadedLanguage;
  }

  private async loadLanguage(language: CodemapLanguage): Promise<Language | null> {
    const grammarPath = this.options.grammarPaths[language];
    if (!grammarPath) {
      return this.recordLanguageFailure(
        createWarning(
          language,
          "LANGUAGE_UNSUPPORTED",
          `No grammar mapping configured for language: ${language}`,
        ),
      );
    }

    const hasGrammar = await isReadableFile(grammarPath);
    if (!hasGrammar) {
      return this.recordLanguageFailure(
        createWarning(
          language,
          "GRAMMAR_NOT_FOUND",
          `Grammar wasm file is not readable: ${grammarPath}`,
          grammarPath,
        ),
      );
    }

    try {
      const languageGrammar = await Language.load(grammarPath);
      this.languageFailures.delete(language);
      return languageGrammar;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.recordLanguageFailure(
        createWarning(
          language,
          "GRAMMAR_LOAD_FAILED",
          `Failed to load grammar: ${detail}`,
          grammarPath,
        ),
      );
    }
  }

  private recordLanguageFailure(
    warning: CodemapParserWarning,
  ): null {
    this.languageFailures.set(warning.language, warning);
    this.options.onWarning?.(warning);
    return null;
  }
}

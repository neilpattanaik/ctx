import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeIndexSchema } from "../../src/index-manager/schema";
import { runOfflineDiscovery } from "../../src/discovery/offline-runner";
import type { FileEntry, SymbolInfo } from "../../src/types";

function seedIndex(db: Database): void {
  initializeIndexSchema(db, { rebuildOnSchemaChange: true });

  const insertFile = db.query(
    `INSERT INTO files (id, path, size, mtime, content_hash, language, line_count, indexed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);`,
  );
  const now = "2026-03-05T00:00:00.000Z";
  insertFile.run(1, "package.json", 120, 1, "h1", "json", 10, now);
  insertFile.run(2, "src/main.ts", 600, 1, "h2", "typescript", 80, now);
  insertFile.run(3, "src/auth/login.ts", 900, 1, "h3", "typescript", 120, now);
  insertFile.run(4, "src/auth/session.ts", 700, 1, "h4", "typescript", 90, now);
  insertFile.run(5, "src/config.ts", 500, 1, "h5", "typescript", 60, now);
  insertFile.run(6, "test/auth/login.test.ts", 650, 1, "h6", "typescript", 70, now);
  insertFile.run(7, "docs/readme.md", 200, 1, "h7", "markdown", 40, now);

  const insertSymbol = db.query(
    `INSERT INTO symbols (file_id, kind, name, signature, line_number, end_line)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6);`,
  );
  insertSymbol.run(3, "function", "loginUser", "function loginUser()", 10, 50);
  insertSymbol.run(4, "function", "createSession", "function createSession()", 8, 42);
  insertSymbol.run(5, "variable", "AUTH_TIMEOUT", "const AUTH_TIMEOUT = 3000", 4, 4);

  const insertImport = db.query(
    `INSERT INTO imports (file_id, imported_path, imported_names, is_reexport)
     VALUES (?1, ?2, ?3, ?4);`,
  );
  insertImport.run(2, "src/auth/login.ts", `["loginUser"]`, 0);
  insertImport.run(3, "src/auth/session.ts", `["createSession"]`, 0);
  insertImport.run(3, "src/config.ts", `["AUTH_TIMEOUT"]`, 0);
  insertImport.run(6, "src/auth/login.ts", `["loginUser"]`, 0);
}

function repoFiles(): FileEntry[] {
  return [
    {
      path: "package.json",
      size: 120,
      mtime: 1,
      hash: "",
      language: "json",
      isText: true,
    },
    {
      path: "src/main.ts",
      size: 600,
      mtime: 1,
      hash: "",
      language: "typescript",
      isText: true,
    },
    {
      path: "src/auth/login.ts",
      size: 900,
      mtime: 1,
      hash: "",
      language: "typescript",
      isText: true,
    },
    {
      path: "src/auth/session.ts",
      size: 700,
      mtime: 1,
      hash: "",
      language: "typescript",
      isText: true,
    },
    {
      path: "src/config.ts",
      size: 500,
      mtime: 1,
      hash: "",
      language: "typescript",
      isText: true,
    },
    {
      path: "test/auth/login.test.ts",
      size: 650,
      mtime: 1,
      hash: "",
      language: "typescript",
      isText: true,
    },
    {
      path: "docs/readme.md",
      size: 200,
      mtime: 1,
      hash: "",
      language: "markdown",
      isText: true,
    },
  ];
}

describe("runOfflineDiscovery", () => {
  test("assembles deterministic offline DiscoveryResult with ranking, slices, and handoff summary", () => {
    const db = new Database(":memory:");
    seedIndex(db);

    const fileTextByPath: Record<string, string> = {
      "package.json": `{"main":"src/main.ts"}`,
      "src/main.ts": `import { loginUser } from "./auth/login";\nexport function bootstrap() {}\n`,
      "src/auth/login.ts": `export function loginUser() {\n  const token = "abc";\n  return token;\n}\n`,
      "src/auth/session.ts": `export function createSession() {\n  return { ok: true };\n}\n`,
      "src/config.ts": `export const AUTH_TIMEOUT = 3000;\n`,
      "test/auth/login.test.ts": `import { loginUser } from "../../src/auth/login";\n`,
      "docs/readme.md": "notes",
    };
    const symbolsByPath: Record<string, SymbolInfo[]> = {
      "src/auth/login.ts": [
        { kind: "function", signature: "function loginUser()", line: 1, endLine: 4 },
      ],
      "src/auth/session.ts": [
        {
          kind: "function",
          signature: "function createSession()",
          line: 1,
          endLine: 3,
        },
      ],
    };

    const options = {
      db,
      task: "Investigate login session failures and AUTH_TIMEOUT config in auth pipeline",
      repoFiles: repoFiles(),
      readFileText: (path: string) => fileTextByPath[path] ?? null,
      symbolsByPath,
      gitChangedPaths: ["src/auth/login.ts"],
      reviewMode: true,
      maxFullFiles: 1,
      maxSliceFiles: 2,
      maxCodemapOnlyFiles: 2,
      maxSlicesPerFile: 3,
      sliceFallbackContextLines: 20,
    } as const;

    const first = runOfflineDiscovery(options);
    const second = runOfflineDiscovery(options);

    expect(second).toEqual(first);
    expect(first.openQuestions).toEqual([]);
    expect(first.selection.length).toBeGreaterThan(0);
    expect(first.selection.filter((entry) => entry.mode === "full")).toHaveLength(1);
    expect(first.selection.filter((entry) => entry.mode === "slices").length).toBeLessThanOrEqual(2);
    expect(first.selection.filter((entry) => entry.mode === "codemap_only").length).toBeLessThanOrEqual(2);

    const sliceEntry = first.selection.find((entry) => entry.mode === "slices");
    expect(sliceEntry).toBeDefined();
    expect(
      sliceEntry && sliceEntry.mode === "slices" ? sliceEntry.slices.length : 0,
    ).toBeGreaterThan(0);
    expect(first.handoffSummary.entrypoints.length).toBeGreaterThan(0);
    expect(first.handoffSummary.configKnobs.some((entry) => entry.key === "AUTH_TIMEOUT")).toBe(
      true,
    );
    expect(first.handoffSummary.dataFlows.some((flow) => flow.name.includes("->"))).toBe(
      true,
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { FileEntry } from "../../src/types";
import {
  extractImportsFromContent,
  indexFileImportsBatch,
  indexFileMetadataBatch,
  openSqliteIndex,
} from "../../src/index-manager";

function fileEntry(path: string, overrides?: Partial<FileEntry>): FileEntry {
  return {
    path,
    size: 100,
    mtime: 1700000000,
    hash: `hash:${path}`,
    language: "text",
    isText: true,
    ...overrides,
  };
}

describe("import/export extraction", () => {
  test("extracts JS/TS imports, require, and re-exports with best-effort path resolution", () => {
    const sourcePath = "src/app/main.ts";
    const content = [
      "import foo, { bar as baz } from '../lib/util';",
      "export { qux } from '../lib/reexp';",
      "const req = require('../lib/req');",
      "import 'external-package';",
    ].join("\n");

    const extracted = extractImportsFromContent(sourcePath, content, {
      knownRepoPaths: ["src/lib/util.ts", "src/lib/reexp.ts", "src/lib/req.ts"],
    });

    expect(extracted).toEqual([
      {
        sourcePath: "src/app/main.ts",
        importedPath: "src/lib/reexp.ts",
        importedNames: ["qux"],
        isReexport: true,
      },
      {
        sourcePath: "src/app/main.ts",
        importedPath: "src/lib/req.ts",
        importedNames: [],
        isReexport: false,
      },
      {
        sourcePath: "src/app/main.ts",
        importedPath: "src/lib/util.ts",
        importedNames: ["bar", "foo"],
        isReexport: false,
      },
    ]);
  });

  test("extracts python, go, and rust import relationships", () => {
    const python = extractImportsFromContent(
      "pkg/worker.py",
      "from pkg.mod import A, B as C\nimport pkg.other",
      {
        knownRepoPaths: ["pkg/mod.py", "pkg/other.py"],
      },
    );
    expect(python).toEqual([
      {
        sourcePath: "pkg/worker.py",
        importedPath: "pkg/mod.py",
        importedNames: ["A", "B"],
        isReexport: false,
      },
      {
        sourcePath: "pkg/worker.py",
        importedPath: "pkg/other.py",
        importedNames: [],
        isReexport: false,
      },
    ]);

    const go = extractImportsFromContent(
      "cmd/main.go",
      'import "internal/db"\nimport (\n  "internal/log"\n)',
      {
        knownRepoPaths: ["internal/db.go", "internal/log.go"],
      },
    );
    expect(go).toEqual([
      {
        sourcePath: "cmd/main.go",
        importedPath: "internal/db.go",
        importedNames: [],
        isReexport: false,
      },
      {
        sourcePath: "cmd/main.go",
        importedPath: "internal/log.go",
        importedNames: [],
        isReexport: false,
      },
    ]);

    const rust = extractImportsFromContent(
      "src/lib.rs",
      "use crate::core::{A, B};\nmod parser;",
      {
        knownRepoPaths: ["src/core/mod.rs", "src/parser.rs"],
      },
    );
    expect(rust).toEqual([
      {
        sourcePath: "src/lib.rs",
        importedPath: "src/core/mod.rs",
        importedNames: ["A", "B"],
        isReexport: false,
      },
      {
        sourcePath: "src/lib.rs",
        importedPath: "src/parser.rs",
        importedNames: [],
        isReexport: false,
      },
    ]);
  });

  test("indexes imports into sqlite and replaces previous rows per file", () => {
    const handle = openSqliteIndex({
      dbPath: ":memory:",
      rebuildOnSchemaChange: true,
    });

    indexFileMetadataBatch(
      handle.db,
      [
        fileEntry("src/app/main.ts"),
        fileEntry("src/lib/util.ts"),
        fileEntry("src/lib/reexp.ts"),
      ],
      { nowIso: () => "2026-03-05T00:00:00.000Z" },
    );

    const first = indexFileImportsBatch(handle.db, [
      {
        path: "src/app/main.ts",
        content:
          "import { foo } from '../lib/util';\nexport { bar } from '../lib/reexp';",
      },
    ]);

    expect(first).toEqual({
      indexedFileCount: 1,
      importCount: 2,
      skippedFileCount: 0,
    });

    const firstRows = handle.db
      .query<{
        imported_path: string;
        imported_names: string;
        is_reexport: number;
      }>(
        `SELECT imported_path, imported_names, is_reexport
         FROM imports
         ORDER BY imported_path ASC;`,
      )
      .all();
    expect(firstRows).toEqual([
      {
        imported_path: "src/lib/reexp.ts",
        imported_names: '["bar"]',
        is_reexport: 1,
      },
      {
        imported_path: "src/lib/util.ts",
        imported_names: '["foo"]',
        is_reexport: 0,
      },
    ]);

    const second = indexFileImportsBatch(handle.db, [
      {
        path: "src/app/main.ts",
        content: "import { foo } from '../lib/util';",
      },
    ]);

    expect(second.importCount).toBe(1);
    const secondRows = handle.db
      .query<{ imported_path: string }>(
        `SELECT imported_path
         FROM imports
         ORDER BY imported_path ASC;`,
      )
      .all();
    expect(secondRows).toEqual([{ imported_path: "src/lib/util.ts" }]);
    handle.close();
  });
});

import { describe, expect, test } from "bun:test";
import {
  evaluateFileSizeLimit,
  partitionFilesBySize,
} from "../../src/scanner/size-limit";

describe("file size limit enforcement", () => {
  test("allows files at or below the max-file-bytes threshold", () => {
    expect(
      evaluateFileSizeLimit("src/main.ts", 1_500_000, {
        maxFileBytes: 1_500_000,
      }),
    ).toEqual({
      allowFullRead: true,
      exceedsLimit: false,
      bypassedByInclude: false,
    });
  });

  test("excludes oversized files with manifest-compatible reason", () => {
    expect(
      evaluateFileSizeLimit("dist/bundle.js", 1_500_001, {
        maxFileBytes: 1_500_000,
      }),
    ).toEqual({
      allowFullRead: false,
      exceedsLimit: true,
      bypassedByInclude: false,
      reason: "exceeds max_file_bytes",
    });
  });

  test("bypasses size limit when include globs explicitly match", () => {
    expect(
      evaluateFileSizeLimit("vendor/generated.ts", 2_000_000, {
        maxFileBytes: 1_500_000,
        includeGlobs: ["vendor/**"],
      }),
    ).toEqual({
      allowFullRead: true,
      exceedsLimit: true,
      bypassedByInclude: true,
    });
  });

  test("partitions files and reports oversized entries deterministically", () => {
    const partition = partitionFilesBySize(
      [
        { path: "a.ts", size: 10 },
        { path: "big.dump", size: 2_000_000 },
        { path: "keep.log", size: 2_000_000 },
      ],
      {
        maxFileBytes: 1_500_000,
        includeGlobs: ["*.log"],
      },
    );

    expect(partition.allowed).toEqual([
      { path: "a.ts", size: 10 },
      { path: "keep.log", size: 2_000_000 },
    ]);
    expect(partition.excluded).toEqual([
      {
        path: "big.dump",
        size: 2_000_000,
        reason: "exceeds max_file_bytes",
      },
    ]);
  });

  test("throws on invalid maxFileBytes values", () => {
    expect(() =>
      evaluateFileSizeLimit("src/main.ts", 100, {
        maxFileBytes: Number.NaN,
      }),
    ).toThrow("maxFileBytes must be a finite number greater than or equal to 0");
  });
});

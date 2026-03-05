import { describe, expect, test } from "bun:test";
import {
  containsNullByte,
  hasBinaryExtension,
  isBinaryFile,
} from "../../src/scanner/binary-detect";

describe("binary detection", () => {
  test("detects binary by extension using fast path", () => {
    expect(hasBinaryExtension("image.PNG")).toBe(true);
    expect(hasBinaryExtension("archive.tar")).toBe(true);
    expect(hasBinaryExtension("src/index.ts")).toBe(false);
  });

  test("detects binary by null-byte sniff for unknown extensions", () => {
    const result = isBinaryFile("unknown.custom", {
      readChunk: () => new Uint8Array([1, 2, 0, 3]),
    });

    expect(result).toBe(true);
  });

  test("classifies text as non-binary when no extension match and no null bytes", () => {
    const result = isBinaryFile("notes.custom", {
      readChunk: () => new Uint8Array([65, 66, 67, 68]),
    });

    expect(result).toBe(false);
  });

  test("does not sniff content when extension already identifies binary", () => {
    let invoked = false;
    const result = isBinaryFile("document.pdf", {
      readChunk: () => {
        invoked = true;
        return new Uint8Array([65, 66, 67]);
      },
    });

    expect(result).toBe(true);
    expect(invoked).toBe(false);
  });

  test("passes configured sniff-byte limit to reader", () => {
    let observedSniffBytes = 0;
    isBinaryFile("file.custom", {
      sniffBytes: 123,
      readChunk: (_path, maxBytes) => {
        observedSniffBytes = maxBytes;
        return new Uint8Array([65, 66]);
      },
    });

    expect(observedSniffBytes).toBe(123);
  });

  test("containsNullByte helper detects null bytes deterministically", () => {
    expect(containsNullByte(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(containsNullByte(new Uint8Array([1, 0, 3]))).toBe(true);
  });
});

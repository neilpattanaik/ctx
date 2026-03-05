import { closeSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

export const DEFAULT_BINARY_EXTENSIONS = [
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
] as const;

const DEFAULT_SNIFF_BYTES = 8 * 1024;
const DEFAULT_EXTENSION_SET = new Set<string>(DEFAULT_BINARY_EXTENSIONS);

export interface BinaryDetectOptions {
  sniffBytes?: number;
  binaryExtensions?: readonly string[];
  readChunk?: (pathValue: string, maxBytes: number) => Uint8Array;
}

function readFileChunk(pathValue: string, maxBytes: number): Uint8Array {
  const fd = openSync(pathValue, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function hasBinaryExtension(
  pathValue: string,
  binaryExtensions: readonly string[] = DEFAULT_BINARY_EXTENSIONS,
): boolean {
  const extension = extname(pathValue).toLowerCase();
  if (extension.length === 0) {
    return false;
  }

  if (binaryExtensions === DEFAULT_BINARY_EXTENSIONS) {
    return DEFAULT_EXTENSION_SET.has(extension);
  }

  const customSet = new Set(binaryExtensions.map((value) => value.toLowerCase()));
  return customSet.has(extension);
}

export function containsNullByte(bytes: Uint8Array): boolean {
  for (const value of bytes) {
    if (value === 0x00) {
      return true;
    }
  }
  return false;
}

export function isBinaryFile(
  pathValue: string,
  options?: BinaryDetectOptions,
): boolean {
  const binaryExtensions = options?.binaryExtensions ?? DEFAULT_BINARY_EXTENSIONS;
  if (hasBinaryExtension(pathValue, binaryExtensions)) {
    return true;
  }

  const sniffBytes = Math.max(1, Math.floor(options?.sniffBytes ?? DEFAULT_SNIFF_BYTES));
  const readChunk = options?.readChunk ?? readFileChunk;
  const bytes = readChunk(pathValue, sniffBytes);

  return containsNullByte(bytes);
}

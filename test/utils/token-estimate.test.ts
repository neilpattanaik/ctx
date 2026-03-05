import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokensFromFile,
  estimateTokensFromSelection,
  estimateTokensFromText,
} from "../../src/utils/token-estimate";

describe("token estimation", () => {
  test("estimates tokens from raw text with default ratio", () => {
    const input = "abcd";
    expect(estimateTokensFromText(input)).toBe(2);
  });

  test("supports custom chars-per-token ratio", () => {
    const input = "abcdefgh";
    expect(estimateTokensFromText(input, { charsPerToken: 4 })).toBe(2);
  });

  test("estimates tokens from a file", () => {
    const path = "test/fixtures/token-sample.txt";
    const content = "token estimation sample";
    const expected = Math.ceil(content.length / DEFAULT_CHARS_PER_TOKEN);

    expect(estimateTokensFromFile(path)).toBe(expected);
  });

  test("sums token estimates across selection modes", () => {
    const selection = [
      { mode: "full" as const, text: "abcd" },
      {
        mode: "slices" as const,
        slices: [{ text: "abc" }, { text: "abcdef" }],
      },
      { mode: "codemap_only" as const, text: "abcde" },
    ];

    expect(estimateTokensFromSelection(selection)).toBe(7);
  });

  test("rejects invalid chars-per-token values", () => {
    expect(() => estimateTokensFromText("abc", { charsPerToken: 0 })).toThrow(
      "charsPerToken must be a finite number greater than 0",
    );
  });
});

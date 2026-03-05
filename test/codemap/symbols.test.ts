import { describe, expect, test } from "bun:test";
import { extractSymbolsFromTree, TreeSitterCodemapParser } from "../../src/codemap";

describe("extractSymbolsFromTree", () => {
  test("extracts TypeScript symbols with deterministic ordering and top-level constant filtering", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    const source = [
      "export interface AuthContext {",
      "  userId: string;",
      "}",
      "export type AuthToken = string;",
      "export class AuthService {",
      "  login(userId: string) {",
      "    return userId;",
      "  }",
      "}",
      "export function signIn(token: string) {",
      "  const inner = token;",
      "  return inner;",
      "}",
      "const TOP_LEVEL_TOKEN = \"abc\";",
    ].join("\n");

    const parsed = await parser.parse(source, "typescript");
    expect(parsed.tree).not.toBeNull();
    const tree = parsed.tree!;

    const symbols = extractSymbolsFromTree(tree, "typescript", {
      detail: "complete",
      maxSignatureChars: 48,
    });

    const ordered = [...symbols].sort((left, right) => {
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.signature.localeCompare(right.signature);
    });
    expect(symbols).toEqual(ordered);

    expect(symbols.some((symbol) => symbol.kind === "interface")).toBe(true);
    expect(symbols.some((symbol) => symbol.kind === "type")).toBe(true);
    expect(symbols.some((symbol) => symbol.kind === "class")).toBe(true);
    expect(symbols.some((symbol) => symbol.kind === "method")).toBe(true);
    expect(symbols.some((symbol) => symbol.kind === "function")).toBe(true);
    expect(
      symbols.some(
        (symbol) =>
          symbol.kind === "variable" &&
          symbol.signature.includes("TOP_LEVEL_TOKEN"),
      ),
    ).toBe(true);

    expect(
      symbols.some(
        (symbol) =>
          symbol.kind === "variable" && symbol.signature.includes("inner"),
      ),
    ).toBe(false);

    expect(symbols.every((symbol) => symbol.signature.length <= 48)).toBe(true);
    expect(symbols.every((symbol) => (symbol.endLine ?? 0) >= symbol.line)).toBe(true);

    tree.delete();
    parser.dispose();
  });

  test("classifies Python class methods as method and module functions as function", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    const source = [
      "class UserRepo:",
      "  def find(self, user_id):",
      "    return user_id",
      "",
      "def read_user(user_id):",
      "  return user_id",
      "",
      "TOKEN = 'abc'",
    ].join("\n");

    const parsed = await parser.parse(source, "python");
    expect(parsed.tree).not.toBeNull();
    const tree = parsed.tree!;

    const symbols = extractSymbolsFromTree(tree, "python");
    const completeSymbols = extractSymbolsFromTree(tree, "python", {
      detail: "complete",
    });

    expect(
      completeSymbols.some((symbol) => symbol.kind === "class" && symbol.line === 1),
    ).toBe(true);
    expect(
      completeSymbols.some((symbol) => symbol.kind === "method" && symbol.line === 2),
    ).toBe(true);
    expect(
      completeSymbols.some((symbol) => symbol.kind === "function" && symbol.line === 5),
    ).toBe(true);
    expect(
      completeSymbols.some((symbol) => symbol.kind === "variable" && symbol.line === 8),
    ).toBe(true);
    expect(symbols.some((symbol) => symbol.kind === "method" && symbol.line === 2)).toBe(
      false,
    );

    tree.delete();
    parser.dispose();
  });

  test("classifies Rust impl functions as methods and keeps top-level functions separate", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    const source = [
      "struct Repo;",
      "impl Repo {",
      "  fn connect(&self) {}",
      "}",
      "fn boot() {}",
    ].join("\n");

    const parsed = await parser.parse(source, "rust");
    expect(parsed.tree).not.toBeNull();
    const tree = parsed.tree!;

    const symbols = extractSymbolsFromTree(tree, "rust", {
      detail: "complete",
    });

    expect(
      symbols.some(
        (symbol) => symbol.kind === "method" && symbol.signature.includes("connect"),
      ),
    ).toBe(true);
    expect(
      symbols.some(
        (symbol) => symbol.kind === "function" && symbol.signature.includes("boot"),
      ),
    ).toBe(true);

    tree.delete();
    parser.dispose();
  });

  test("uses summary mode by default and applies deterministic maxSymbols cap", async () => {
    const parser = await TreeSitterCodemapParser.create({
      projectRoot: process.cwd(),
    });

    const source = [
      "export class AuthService {",
      "  login() {}",
      "}",
      "export function createAuth() {}",
      "export function readAuth() {}",
      "const TOKEN = \"x\";",
    ].join("\n");

    const parsed = await parser.parse(source, "typescript");
    expect(parsed.tree).not.toBeNull();
    const tree = parsed.tree!;

    const summary = extractSymbolsFromTree(tree, "typescript");
    expect(summary.some((symbol) => symbol.kind === "method")).toBe(false);
    expect(
      summary.some((symbol) => symbol.kind === "function" && symbol.signature.includes("createAuth")),
    ).toBe(true);

    const capped = extractSymbolsFromTree(tree, "typescript", {
      maxSymbols: 2,
    });
    expect(capped).toHaveLength(2);

    const complete = extractSymbolsFromTree(tree, "typescript", {
      detail: "complete",
    });
    expect(complete.some((symbol) => symbol.kind === "method")).toBe(true);
    expect(complete.length).toBeGreaterThan(summary.length);

    tree.delete();
    parser.dispose();
  });
});

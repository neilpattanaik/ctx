import type { Node, Tree } from "web-tree-sitter";
import { stableSort, truncateStable } from "../utils/deterministic";
import type { SymbolInfo, SymbolKind } from "../types";
import type { CodemapLanguage } from "./parser";

const DEFAULT_MAX_SIGNATURE_CHARS = 160;
const DEFAULT_MAX_SYMBOLS_SUMMARY = 200;
const DEFAULT_MAX_SYMBOLS_COMPLETE = 1000;

interface SymbolRule {
  nodeType: string;
  kind: SymbolKind;
  topLevelOnly?: boolean;
  kindResolver?: (node: Node) => SymbolKind;
}

export interface ExtractSymbolsOptions {
  detail?: "summary" | "complete";
  maxSymbols?: number;
  maxSignatureChars?: number;
}

const TOP_LEVEL_ROOT_TYPES = new Set([
  "program",
  "module",
  "source_file",
  "compilation_unit",
]);

const NESTED_SCOPE_TYPES = new Set([
  "block",
  "statement_block",
  "declaration_list",
  "class_body",
  "object",
  "array",
  "arguments",
  "parameter_list",
  "lambda",
  "arrow_function",
  "for_statement",
  "while_statement",
  "if_statement",
  "switch_statement",
]);

const LANGUAGE_SYMBOL_RULES: Record<CodemapLanguage, readonly SymbolRule[]> = {
  typescript: [
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "type_alias_declaration", kind: "type" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "method_definition", kind: "method" },
    { nodeType: "export_statement", kind: "module", topLevelOnly: true },
    { nodeType: "lexical_declaration", kind: "variable", topLevelOnly: true },
    { nodeType: "variable_declaration", kind: "variable", topLevelOnly: true },
  ],
  javascript: [
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "method_definition", kind: "method" },
    { nodeType: "export_statement", kind: "module", topLevelOnly: true },
    { nodeType: "lexical_declaration", kind: "variable", topLevelOnly: true },
    { nodeType: "variable_declaration", kind: "variable", topLevelOnly: true },
  ],
  python: [
    { nodeType: "class_definition", kind: "class", topLevelOnly: true },
    {
      nodeType: "function_definition",
      kind: "function",
      kindResolver: (node) =>
        hasAncestor(node, new Set(["class_definition"])) ? "method" : "function",
    },
    { nodeType: "assignment", kind: "variable", topLevelOnly: true },
  ],
  go: [
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "method_declaration", kind: "method" },
    { nodeType: "type_declaration", kind: "type", topLevelOnly: true },
    { nodeType: "const_declaration", kind: "variable", topLevelOnly: true },
    { nodeType: "var_declaration", kind: "variable", topLevelOnly: true },
  ],
  rust: [
    {
      nodeType: "function_item",
      kind: "function",
      kindResolver: (node) =>
        hasAncestor(node, new Set(["impl_item", "trait_item"])) ? "method" : "function",
    },
    { nodeType: "struct_item", kind: "type", topLevelOnly: true },
    { nodeType: "enum_item", kind: "enum", topLevelOnly: true },
    { nodeType: "trait_item", kind: "interface", topLevelOnly: true },
    { nodeType: "type_item", kind: "type", topLevelOnly: true },
    { nodeType: "const_item", kind: "variable", topLevelOnly: true },
  ],
  java: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "record_declaration", kind: "type" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "method_declaration", kind: "method" },
    { nodeType: "field_declaration", kind: "variable" },
  ],
  c: [
    { nodeType: "function_definition", kind: "function" },
    { nodeType: "struct_specifier", kind: "type", topLevelOnly: true },
    { nodeType: "enum_specifier", kind: "enum", topLevelOnly: true },
    { nodeType: "declaration", kind: "variable", topLevelOnly: true },
  ],
  cpp: [
    { nodeType: "function_definition", kind: "function" },
    { nodeType: "class_specifier", kind: "class" },
    { nodeType: "enum_specifier", kind: "enum", topLevelOnly: true },
    { nodeType: "field_declaration", kind: "variable" },
    { nodeType: "declaration", kind: "variable", topLevelOnly: true },
  ],
  ruby: [
    { nodeType: "class", kind: "class" },
    { nodeType: "module", kind: "module" },
    {
      nodeType: "method",
      kind: "function",
      kindResolver: (node) =>
        hasAncestor(node, new Set(["class", "singleton_class"])) ? "method" : "function",
    },
    { nodeType: "assignment", kind: "variable", topLevelOnly: true },
  ],
  swift: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "protocol_declaration", kind: "interface" },
    { nodeType: "typealias_declaration", kind: "type" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "property_declaration", kind: "variable", topLevelOnly: true },
  ],
  kotlin: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "type_alias", kind: "type" },
    { nodeType: "enum_class_declaration", kind: "enum" },
    { nodeType: "function_declaration", kind: "function" },
    { nodeType: "property_declaration", kind: "variable", topLevelOnly: true },
  ],
  csharp: [
    { nodeType: "class_declaration", kind: "class" },
    { nodeType: "interface_declaration", kind: "interface" },
    { nodeType: "record_declaration", kind: "type" },
    { nodeType: "struct_declaration", kind: "type" },
    { nodeType: "enum_declaration", kind: "enum" },
    { nodeType: "method_declaration", kind: "method" },
    { nodeType: "field_declaration", kind: "variable" },
  ],
};

function hasAncestor(node: Node, ancestorTypes: ReadonlySet<string>): boolean {
  let current: Node | null = node.parent;
  while (current) {
    if (ancestorTypes.has(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isTopLevelNode(node: Node): boolean {
  let current: Node | null = node.parent;
  while (current) {
    if (TOP_LEVEL_ROOT_TYPES.has(current.type)) {
      return true;
    }
    if (NESTED_SCOPE_TYPES.has(current.type)) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function normalizeSignature(node: Node, maxSignatureChars: number): string {
  const firstLine = node.text
    .replace(/\r\n/g, "\n")
    .split("\n", 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();

  if (!firstLine || firstLine.length === 0) {
    return truncateStable(node.type, maxSignatureChars);
  }

  return truncateStable(firstLine, maxSignatureChars);
}

function compareSymbols(left: SymbolInfo, right: SymbolInfo): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  const signatureCompare = left.signature.localeCompare(right.signature);
  if (signatureCompare !== 0) {
    return signatureCompare;
  }

  const endLeft = left.endLine ?? left.line;
  const endRight = right.endLine ?? right.line;
  if (endLeft !== endRight) {
    return endLeft - endRight;
  }

  return left.kind.localeCompare(right.kind);
}

export function extractSymbolsFromTree(
  tree: Tree,
  language: CodemapLanguage,
  options: ExtractSymbolsOptions = {},
): SymbolInfo[] {
  const detail = options.detail ?? "summary";
  const maxSignatureChars =
    Number.isInteger(options.maxSignatureChars) &&
    (options.maxSignatureChars as number) > 0
      ? (options.maxSignatureChars as number)
      : DEFAULT_MAX_SIGNATURE_CHARS;
  const maxSymbols =
    Number.isInteger(options.maxSymbols) && (options.maxSymbols as number) > 0
      ? (options.maxSymbols as number)
      : detail === "summary"
        ? DEFAULT_MAX_SYMBOLS_SUMMARY
        : DEFAULT_MAX_SYMBOLS_COMPLETE;

  const rules = LANGUAGE_SYMBOL_RULES[language];
  if (!rules || rules.length === 0) {
    return [];
  }

  const nodeTypes = [...new Set(rules.map((rule) => rule.nodeType))];
  const candidateNodes = tree.rootNode.descendantsOfType(nodeTypes);

  const byNodeType = new Map<string, SymbolRule[]>();
  for (const rule of rules) {
    const existing = byNodeType.get(rule.nodeType);
    if (existing) {
      existing.push(rule);
    } else {
      byNodeType.set(rule.nodeType, [rule]);
    }
  }

  const seen = new Set<string>();
  const extracted: SymbolInfo[] = [];

  for (const node of candidateNodes) {
    const matchingRules = byNodeType.get(node.type);
    if (!matchingRules || matchingRules.length === 0) {
      continue;
    }

    for (const rule of matchingRules) {
      if (rule.topLevelOnly && !isTopLevelNode(node)) {
        continue;
      }

      const kind = rule.kindResolver ? rule.kindResolver(node) : rule.kind;
      if (detail === "summary") {
        if (!isTopLevelNode(node)) {
          continue;
        }
        if (kind === "method") {
          continue;
        }
      }

      const symbol: SymbolInfo = {
        kind,
        signature: normalizeSignature(node, maxSignatureChars),
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      };

      const dedupeKey = `${symbol.kind}|${symbol.line}|${symbol.endLine ?? symbol.line}|${symbol.signature}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      extracted.push(symbol);
      break;
    }
  }

  return stableSort(extracted, compareSymbols).slice(0, maxSymbols);
}

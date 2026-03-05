const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "toml",
  "yaml",
  "yml",
  "md",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "sh",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "that",
  "to",
  "with",
]);

const TOKEN_PATTERN = /[A-Za-z0-9_./:-]+/g;

export interface ExtractedTaskTerms {
  identifiers: string[];
  paths: string[];
  configKeys: string[];
  endpoints: string[];
  searchTerms: string[];
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function addLowercasedUnique(target: string[], value: string): void {
  const normalized = value.toLowerCase();
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function hasCodeExtension(token: string): boolean {
  const maybeExtension = token.split(".").pop();
  if (!maybeExtension) {
    return false;
  }
  return CODE_EXTENSIONS.has(maybeExtension.toLowerCase());
}

function isEndpoint(token: string): boolean {
  return /^\/[A-Za-z0-9/_\-.:{}]*$/.test(token);
}

function isLikelyPath(token: string): boolean {
  if (token.startsWith("./") || token.startsWith("../")) {
    return true;
  }
  if (token.includes("/") && !token.startsWith("/")) {
    return true;
  }
  return token.includes(".") && hasCodeExtension(token);
}

function isConfigKey(token: string): boolean {
  const isEnvStyle = /^[A-Z][A-Z0-9_]*$/.test(token) && token.includes("_");
  const isDotted = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(token);
  return isEnvStyle || isDotted;
}

function isIdentifier(token: string): boolean {
  const hasCamelOrPascal = /[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*/.test(token);
  const hasSnake = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(token);
  const hasDottedIdentifier = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(
    token,
  );
  return hasCamelOrPascal || hasSnake || hasDottedIdentifier;
}

function splitTokenIntoTerms(token: string): string[] {
  const camelSeparated = token.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const fragments = camelSeparated
    .split(/[\s/._:-]+/g)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 1);

  const terms: string[] = [];
  for (const fragment of fragments) {
    if (!STOP_WORDS.has(fragment)) {
      addUnique(terms, fragment);
    }
  }
  return terms;
}

export function extractTaskTerms(task: string): ExtractedTaskTerms {
  const identifiers: string[] = [];
  const paths: string[] = [];
  const configKeys: string[] = [];
  const endpoints: string[] = [];
  const searchTerms: string[] = [];

  const tokens = task.match(TOKEN_PATTERN) ?? [];

  for (const rawToken of tokens) {
    const token = rawToken
      .replace(/^[("'`]+/g, "")
      .replace(/[)"'`,.;:!?]+$/g, "");

    if (token.length < 2) {
      continue;
    }

    if (isEndpoint(token)) {
      addUnique(endpoints, token);
      for (const term of splitTokenIntoTerms(token)) {
        addLowercasedUnique(searchTerms, term);
      }
      continue;
    }

    if (isLikelyPath(token)) {
      addUnique(paths, token);
      for (const term of splitTokenIntoTerms(token)) {
        addLowercasedUnique(searchTerms, term);
      }
      continue;
    }

    if (isConfigKey(token)) {
      addUnique(configKeys, token);
      for (const term of splitTokenIntoTerms(token)) {
        addLowercasedUnique(searchTerms, term);
      }
    }

    if (isIdentifier(token)) {
      addUnique(identifiers, token);
    }

    for (const term of splitTokenIntoTerms(token)) {
      addLowercasedUnique(searchTerms, term);
    }
  }

  return {
    identifiers,
    paths,
    configKeys,
    endpoints,
    searchTerms,
  };
}

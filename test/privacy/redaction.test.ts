import { describe, expect, test } from "bun:test";
import {
  compileExtraRedactPatterns,
  redactText,
  type SecretPatternEntry,
} from "../../src/privacy";

function countLines(value: string): number {
  return value.split("\n").length;
}

describe("redaction engine", () => {
  test("replaces detected secrets with deterministic markers and tracks counts", () => {
    const aws = `AKIA${"A".repeat(16)}`;
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const input = `api=${aws}\ntoken=${jwt}`;

    const result = redactText(input);

    expect(result.text).toContain("api=‹REDACTED:aws_access_key_id›");
    expect(result.text).toContain("token=‹REDACTED:jwt_token›");
    expect(result.redactionCount).toBe(2);
    expect(result.categoryCounts.api_key).toBe(1);
    expect(result.categoryCounts.token).toBe(1);
    expect(result.reasonCounts.aws_access_key_id).toBe(1);
    expect(result.reasonCounts.jwt_token).toBe(1);
  });

  test("preserves line structure and surrounding context", () => {
    const aws = `AKIA${"B".repeat(16)}`;
    const input = `prefix ${aws} suffix\nline2`;

    const result = redactText(input);

    expect(result.text.startsWith("prefix ")).toBe(true);
    expect(result.text.includes(" suffix")).toBe(true);
    expect(countLines(result.text)).toBe(countLines(input));
  });

  test("supports disabled redaction mode", () => {
    const aws = `AKIA${"C".repeat(16)}`;
    const input = `value=${aws}`;

    const result = redactText(input, { enabled: false });

    expect(result.redactionEnabled).toBe(false);
    expect(result.text).toBe(input);
    expect(result.redactionCount).toBe(0);
  });

  test("does not re-redact existing markers", () => {
    const jwt = `eyJ${"x".repeat(10)}.${"y".repeat(10)}.${"z".repeat(10)}`;
    const input = `existing=‹REDACTED:jwt_token›\nraw=${jwt}`;

    const result = redactText(input);

    expect(result.redactionCount).toBe(1);
    expect(result.text).toContain("existing=‹REDACTED:jwt_token›");
    expect(result.text).toContain("raw=‹REDACTED:jwt_token›");
  });

  test("can include entropy markers in the same single-pass replacement flow", () => {
    const highEntropy = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA";
    const input = `candidate=${highEntropy}`;

    const result = redactText(input, {
      includeEntropyMarkers: true,
      entropy: {
        minLength: 20,
        minEntropy: 4.0,
      },
    });

    expect(result.redactionCount).toBe(1);
    expect(result.text).toContain("candidate=‹REDACTED:entropy_marker›");
    expect(result.categoryCounts.entropy_marker).toBe(1);
  });

  test("handles overlapping candidates by selecting a deterministic non-overlapping set", () => {
    const oauthToken = `access_token="${"Ab3".repeat(10)}"`;
    const bearer = `Bearer ${"Ab3".repeat(10)}`;
    const input = `${oauthToken}\nheader=${bearer}`;

    const result = redactText(input);

    expect(result.redactionCount).toBe(2);
    expect(result.text).toContain('access_token="‹REDACTED:oauth_token_assignment›"');
    expect(result.text).toContain("header=Bearer ‹REDACTED:bearer_token›");
  });

  test("redacts multiple independent secrets on one line", () => {
    const aws = `AKIA${"D".repeat(16)}`;
    const github = `ghp_${"a".repeat(36)}`;
    const input = `line=${aws} + ${github}`;

    const result = redactText(input);

    expect(result.redactionCount).toBe(2);
    expect(result.text).toContain("‹REDACTED:aws_access_key_id›");
    expect(result.text).toContain("‹REDACTED:github_token›");
    expect(result.categoryCounts.api_key).toBe(2);
  });

  test("redacts private key blocks and credentialed URIs with deterministic markers", () => {
    const privateKeyBlock = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAx1x2x3x4x5x6x7x8x9x0",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const input = `${privateKeyBlock}\nurl=postgres://alice:supersecret@db.internal:5432/app`;

    const result = redactText(input);

    expect(result.text).toContain("‹REDACTED:private_key_block›");
    expect(result.text).toContain("url=‹REDACTED:postgres_uri_with_credentials›");
    expect(result.reasonCounts.private_key_block).toBe(1);
    expect(result.reasonCounts.postgres_uri_with_credentials).toBe(1);
    expect(countLines(result.text)).toBe(countLines(input));
  });

  test("supports custom redaction patterns passed at runtime", () => {
    const customPattern: SecretPatternEntry = {
      id: "custom-token",
      category: "token",
      severity: "medium",
      falsePositiveLikelihood: "medium",
      regex: /\bCUSTOM_[A-Z0-9]{8}\b/g,
    };
    const input = "token=CUSTOM_ABC12345";

    const result = redactText(input, {
      extraPatterns: [customPattern],
    });

    expect(result.redactionCount).toBe(1);
    expect(result.text).toContain("token=‹REDACTED:custom_token›");
    expect(result.reasonCounts.custom_token).toBe(1);
  });

  test("compiles CLI string patterns and reports invalid regex entries", () => {
    const compiled = compileExtraRedactPatterns([
      "SECRET_[A-Z0-9]{8}",
      "/TOKEN_[0-9]{4}/i",
      "(",
    ]);

    expect(compiled.patterns).toHaveLength(2);
    expect(compiled.invalidPatterns).toEqual(["("]);

    const result = redactText("a=SECRET_ABC12345 b=token_1234", {
      extraPatterns: compiled.patterns,
    });
    expect(result.redactionCount).toBe(2);
    expect(result.text).toContain("‹REDACTED:custom_pattern_1›");
    expect(result.text).toContain("‹REDACTED:custom_pattern_2›");
  });

  test("resists false positives for normal code-like literals", () => {
    const input = [
      "const DATA_URL = \"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA\";",
      "const SHA256 = \"e3b0c44298fc1c149afbf4c8996fb924\";",
      "const HEX_ID = \"deadbeefcafebabe0123456789abcdef\";",
    ].join("\n");

    const result = redactText(input);

    expect(result.redactionCount).toBe(0);
    expect(result.text).toBe(input);
  });
});

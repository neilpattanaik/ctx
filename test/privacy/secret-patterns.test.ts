import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECRET_PATTERNS,
  ENTROPY_MARKER_ID,
  calculateShannonEntropy,
  detectSecrets,
  findEntropyMarkers,
  findSecretPatternMatches,
  type SecretPatternEntry,
} from "../../src/privacy";

describe("secret pattern detection", () => {
  test("exports deterministic default pattern ids", () => {
    expect(DEFAULT_SECRET_PATTERNS.map((entry) => entry.id)).toEqual([
      "aws-access-key-id",
      "github-token",
      "stripe-secret-key",
      "google-api-key",
      "slack-token",
      "jwt-token",
      "bearer-token",
      "oauth-token-assignment",
      "private-key-block",
      "postgres-uri-with-credentials",
      "mysql-uri-with-credentials",
      "mongodb-uri-with-credentials",
      "redis-uri-with-credentials",
    ]);
  });

  test("detects core API key patterns", () => {
    const text = [
      `aws=${"AKIA"}${"A".repeat(16)}`,
      `github=${"ghp_"}${"a".repeat(36)}`,
      `stripe=${"sk_live_"}${"b".repeat(24)}`,
      `google=${"AIza"}${"C".repeat(35)}`,
      `slack=${"xoxb-"}${"d".repeat(24)}`,
    ].join("\n");

    const matches = findSecretPatternMatches(text);
    const ids = new Set(matches.map((entry) => entry.id));

    expect(ids).toEqual(
      new Set([
        "aws-access-key-id",
        "github-token",
        "stripe-secret-key",
        "google-api-key",
        "slack-token",
      ]),
    );
  });

  test("detects token patterns", () => {
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const bearer = `Bearer ${"Ab3".repeat(10)}`;
    const oauth = `access_token = "${"t0".repeat(12)}"`;
    const text = `${jwt}\n${bearer}\n${oauth}`;

    const matches = findSecretPatternMatches(text);
    const ids = new Set(matches.map((entry) => entry.id));

    expect(ids).toEqual(
      new Set(["jwt-token", "bearer-token", "oauth-token-assignment"]),
    );
  });

  test("detects private key blocks and credentialed connection strings", () => {
    const privateKeyBlock = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAx1x2x3x4x5x6x7x8x9x0",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const text = [
      privateKeyBlock,
      "postgres://alice:pw@localhost:5432/app",
      "mysql://root:pw@db.internal/service",
      "mongodb://mongo:pw@mongo.internal:27017/app",
      "redis://cache:pw@redis.internal:6379/0",
    ].join("\n");

    const matches = findSecretPatternMatches(text);
    const ids = new Set(matches.map((entry) => entry.id));

    expect(ids).toEqual(
      new Set([
        "private-key-block",
        "postgres-uri-with-credentials",
        "mysql-uri-with-credentials",
        "mongodb-uri-with-credentials",
        "redis-uri-with-credentials",
      ]),
    );
  });

  test("supports caller-provided extra patterns", () => {
    const customPattern: SecretPatternEntry = {
      id: "custom-token",
      category: "token",
      severity: "medium",
      falsePositiveLikelihood: "medium",
      regex: /\bCUSTOM_[A-Z0-9]{8}\b/g,
    };

    const matches = findSecretPatternMatches("CUSTOM_ABC12345", {
      extraPatterns: [customPattern],
    });

    expect(matches.map((entry) => entry.id)).toContain("custom-token");
  });

  test("finds entropy markers conservatively", () => {
    const highEntropy = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA";
    const text = `prefix ${highEntropy} suffix`;
    const matches = findEntropyMarkers(text, {
      minLength: 20,
      minEntropy: 4.0,
    });

    expect(matches.length).toBe(1);
    expect(matches[0]?.id).toBe(ENTROPY_MARKER_ID);
    expect(matches[0]?.markerOnly).toBe(true);
  });

  test("skips entropy markers that overlap known pattern matches", () => {
    const googleKey = `AIzaAbCdEfGhIjKlMnOpQrStUvWxYz012345678`;
    const matches = detectSecrets(googleKey, {
      includeEntropyMarkers: true,
      entropy: { minLength: 20, minEntropy: 3.8 },
    });

    expect(matches.map((entry) => entry.id)).toEqual(["google-api-key"]);
  });

  test("calculateShannonEntropy is deterministic", () => {
    const lowEntropy = calculateShannonEntropy("aaaaaaaaaaaaaaaaaaaa");
    const highEntropy = calculateShannonEntropy("Ab3dE5fG7hJ9kL1mN2pQ4rS6");

    expect(lowEntropy).toBeLessThan(highEntropy);
    expect(calculateShannonEntropy("")).toBe(0);
  });
});

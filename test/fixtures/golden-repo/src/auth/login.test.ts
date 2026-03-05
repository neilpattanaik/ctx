import { describe, expect, test } from "bun:test";
import { authenticateUser } from "./login";

describe("authenticateUser", () => {
  test("accepts demo credentials", () => {
    expect(authenticateUser("demo", "demo-password")).toBe(true);
  });

  test("rejects empty credentials", () => {
    expect(authenticateUser("", "")).toBe(false);
  });
});

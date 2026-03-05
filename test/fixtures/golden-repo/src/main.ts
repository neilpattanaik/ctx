import { authenticateUser } from "./auth/login";

export function runApp(): string {
  const result = authenticateUser("demo", "demo-password");
  return result ? "ok" : "denied";
}

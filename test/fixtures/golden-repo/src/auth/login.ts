export function authenticateUser(username: string, password: string): boolean {
  if (username.length === 0 || password.length === 0) {
    return false;
  }
  return username === "demo" && password === "demo-password";
}

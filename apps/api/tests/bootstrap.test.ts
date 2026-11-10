import { describe, expect, it } from "vitest";
import { checkBootstrapAdmin, isLoginableEmail } from "../src/bootstrap.js";

// Regression tests for the first-run admin bootstrap: these values are written
// straight to the users table, but sign-in validates the same fields, so a bad
// ADMIN_EMAIL used to create an account that could never log in.

describe("checkBootstrapAdmin", () => {
  it("rejects an address the login route would refuse (no TLD)", () => {
    const result = checkBootstrapAdmin("admin@localhost", "RadioHost123!", "Alex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/email/i);
  });

  it("rejects a password shorter than the signup minimum", () => {
    const result = checkBootstrapAdmin("admin@example.com", "short", "Alex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/password/i);
  });

  it("rejects a blank admin name", () => {
    expect(checkBootstrapAdmin("admin@example.com", "RadioHost123!", "").ok).toBe(false);
  });

  it("accepts a valid address and a proper password", () => {
    const result = checkBootstrapAdmin("Admin@Example.com", "RadioHost123!", "Alex");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBe("Admin@Example.com");
      expect(result.name).toBe("Alex");
    }
  });
});

describe("isLoginableEmail", () => {
  it("flags the addresses login rejects", () => {
    expect(isLoginableEmail("admin@localhost")).toBe(false);
    expect(isLoginableEmail("not-an-email")).toBe(false);
  });

  it("accepts a normal address", () => {
    expect(isLoginableEmail("admin@example.com")).toBe(true);
  });
});

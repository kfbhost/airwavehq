import { emailSchema, registerSchema } from "@airwavehq/shared";

export type BootstrapCheck =
  | { ok: true; email: string; password: string; name: string }
  | { ok: false; reason: string };

/**
 * Validates the first-run ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME triple.
 *
 * These values are written straight into the users table, but sign-in runs the
 * same fields through `loginSchema`. An address login rejects — `admin@localhost`
 * has no TLD — used to create an account that could never sign in, and the only
 * symptom was a "wrong email or password" on a brand-new install. Validate here
 * so a bad bootstrap fails immediately with a message that says what to change.
 */
export function checkBootstrapAdmin(email: string, password: string, name: string): BootstrapCheck {
  const parsed = registerSchema.safeParse({ email, password, name });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: detail };
  }
  return { ok: true, email: parsed.data.email, password: parsed.data.password, name: parsed.data.name };
}

/** True when an existing account's stored address would be accepted by login. */
export function isLoginableEmail(email: string): boolean {
  return emailSchema.safeParse(email).success;
}

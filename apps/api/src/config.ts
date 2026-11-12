function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env("PORT", "8080")),
  databaseUrl: env("DATABASE_URL", "postgres://airwavehq:airwavehq@localhost:5432/airwavehq"),
  dataDir: env("DATA_DIR", "../../data"),
  jwtSecret: env("JWT_SECRET", "dev-secret-change-me"),
  engineSecret: env("ENGINE_SECRET", "dev-engine-secret-change-me"),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8080"),
  geoipDb: env("GEOIP_DB", ""),
  logLevel: env("LOG_LEVEL", "info"),
  mail: {
    from: env("MAIL_FROM", ""),
    // "smtp" | "sendmail" | "" (auto: smtp if SMTP_HOST set, else sendmail if MAIL_TRANSPORT=sendmail)
    transport: env("MAIL_TRANSPORT", ""),
    smtpHost: env("SMTP_HOST", ""),
    smtpPort: Number(env("SMTP_PORT", "587")),
    smtpSecure: env("SMTP_SECURE", "0") === "1",
    smtpUser: env("SMTP_USER", ""),
    smtpPass: env("SMTP_PASS", ""),
    sendmailPath: env("MAIL_SENDMAIL_PATH", "/usr/sbin/sendmail"),
  },
};

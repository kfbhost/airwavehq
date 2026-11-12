# Security

## This is early software

AirwaveHQ is **not production-hardened yet**. Please read the status section in
the [README](README.md) before using it for a station you care about. Treat any
deployment as a test.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Include:

- what the issue is and what an attacker could do
- steps to reproduce
- the version (bottom of the sidebar) and how it was installed
- any suggested fix

## Things that are expected in early versions

- The **local development** setup ships default credentials and fixed ports.
  Never reuse those on a public server.
- The VPS installer generates every secret for you. **Change the admin password
  after the first login**, and keep `.env` private (it is gitignored).
- There is no CI or security review process yet, so treat the code accordingly.

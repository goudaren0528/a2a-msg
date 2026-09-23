# Security policy

## Deployment boundary

The current legacy server identifies members by source IP and is intended for a controlled private LAN. **Do not expose this legacy IP-based endpoint to the public Internet.** Planned Agent credentials/TLS and independent-client features are not a claim that the current implementation is Internet-safe. Do not use a real database or private messages as a public reproduction.

## Reporting vulnerabilities

**Private reporting channel not yet configured or published; this blocks a formal public release.** A GitHub private vulnerability-reporting feature may or may not be enabled; do not assume it is available. The maintainer must enable and verify a protected private channel and publish its instructions before accepting sensitive reports. We do not have a verified security email address to provide.

Until then, do not disclose exploit steps, sensitive request/response bodies, credentials, attachments, or database contents in a public Issue or PR. If you need to flag a concern without an established private channel, share only non-sensitive metadata (e.g. affected component, version/commit range, broad impact category, and that a confidential channel is needed) without enough detail to reproduce or exploit it; wait for a verified private channel before sending details. Never send secrets or production data through an unverified channel. There is no promised response SLA or supported-version policy yet.

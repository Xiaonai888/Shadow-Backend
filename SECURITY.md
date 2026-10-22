# Shadow Backend Security Policy

## Purpose

This repository implements trusted server-side logic for Shadow. Security changes must protect reader accounts, author accounts, Admin access, Diamonds, Coins, gifts, PDF/Book purchases, uploads, and payment operations without disabling existing functionality.

## Reporting a Vulnerability

Report suspected vulnerabilities privately to repository maintainers. If GitHub's **Report a vulnerability** option is enabled under this repository's Security tab, use it. Otherwise use a private maintainer contact channel already established for the project. Do not disclose working exploits, access tokens, credentials, or identifiable user/payment information in public issues or pull requests.

When reporting, provide the affected component, reproducible steps using test data, security impact, and the latest affected commit when known. Never include actual user secrets or financial information.

## Required Protections

- **Authentication and authorization:** Validate credentials, permissions, ownership, and admin roles on the backend, not only in frontend controls.
- **Database access:** Use parameterized queries and least privilege; coordinate Supabase GRANT permissions and RLS policies. Never expose service_role secrets to client-side code.
- **User input and output:** Validate type, length, range, file size, MIME type, and allowed values. Escape/encode output for its destination. Never generate HTML from untrusted content without an approved sanitization strategy.
- **URL, upload, and network safety:** Restrict unsafe URL schemes, untrusted redirects, remote fetch destinations, and unexpected file types. Keep upload size and authorization checks in place.
- **Payments and balances:** Verify webhooks and payment references server-side, prevent duplicate credits, use idempotent processing, and preserve anti-fraud limits and audit records.
- **Secrets and privacy:** Keep keys, tokens, signing credentials, payment details, and private reader data out of source control, client responses, and logs.
- **Feature gates:** Never re-enable a disabled feature, bypass a kill switch, remove security middleware, or weaken account restrictions as a shortcut to fixing another problem.

## Automated Checks

Existing GitHub Actions include `.github/workflows/secret-scan.yml` for secret scanning on pushes and pull requests to `main`, and `.github/workflows/pre-deploy-check.yml` for manually triggered release verification. Preserve these workflows.

CodeQL may be configured through GitHub's default code scanning setup or a workflow. Check the repository's **Settings → Advanced Security** and **Security → Code scanning** before adding another workflow. When supported, enable CodeQL analysis for pushes, pull requests, and periodic scans; avoid duplicate analyses and unnecessary workflow changes.

Use dependency alerts and updates where enabled. Review the scan against the commit being deployed, not only the number of open alerts. An empty CodeQL alert list is not proof of a complete security audit.

## Safe Security-Fix Workflow

1. Reproduce and locate the real source-to-sink or trust-boundary issue.
2. Read `AGENTS.md`, inspect the latest code, and identify affected API consumers in `Web-React-2` and `AdminDashboard`.
3. Apply the smallest effective change while retaining existing features, routes, middleware, payment rules, and database permissions.
4. Verify input validation, unauthorized-access denial, and important existing behavior using available tests and checks.
5. Confirm new security scan results against the updated commit. Do not hide, dismiss, or disable valid alerts to reach zero.

## Scope of This Document

This file documents required security practices. It does not automatically change GitHub settings, enable CodeQL, or guarantee that an application has no vulnerabilities.

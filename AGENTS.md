# Shadow Backend Development Rules

## Scope
These rules apply to the entire `Shadow-Backend` repository.

## Mandatory Change Isolation & Regression Gate (2026-11-25)

These rules are mandatory for all AI-assisted development, bug fixes, security updates, dependency upgrades, performance optimization, refactoring, and maintenance.

This section takes precedence over any instruction that could permit broad, rushed, or grouped changes. Existing security and protected-feature rules remain mandatory.

### Strict Change Isolation

- Work on ONE confirmed problem or ONE requested feature at a time.
- Never combine independent bug fixes, features, optimizations, or security updates into a single patch or deployment.
- Never upgrade multiple major dependencies at the same time.
- Never sacrifice application stability to finish work faster or reduce security alert counts.
- Modify only the files and direct dependencies required for the current task.
- Multiple files may be changed together only when strictly necessary for the same functionality. Do not create broken intermediate states.
- Do not modify unrelated working code or perform unnecessary cleanup, refactoring, or repository-wide changes.
- Never remove existing functions, imports, exports, routes, middleware, callbacks, or fallback behavior without verifying their purpose and obtaining explicit owner approval when removal is required.

### Mandatory Before Editing

- Read the latest AGENTS.md and current source files.
- Identify the exact problem and verify its real cause. Never modify code based solely on assumptions or automated warnings.
- Inspect affected dependencies and existing consumers.
- Identify potential regressions before implementing changes.
- Record a known-good commit or rollback point and keep the change isolated in a reviewable branch or commit.
- Establish a functional baseline for the affected feature.
- Preserve existing business logic, security controls, API contracts, UI behavior, and working features.

### Dependency and Security Updates

- Review one dependency group at a time.
- Verify installed versions, official advisories, actual usage, and compatibility.
- Major dependency upgrades require explicit owner approval and migration review.
- Never blindly run npm audit fix, npm audit fix --force, or mass npm update.
- Never blindly merge Dependabot pull requests.
- Never regenerate the entire lockfile without a verified reason.
- Preserve unrelated dependency versions and existing overrides.
- Keep package.json and package-lock.json synchronized.
- Never prioritize zero security alerts over actual application functionality.
- Prioritize urgent confirmed vulnerabilities using isolated, reviewed fixes. Document any temporary mitigation and remaining risk.
- Never suppress genuine security alerts or weaken security controls.

### Mandatory Regression Testing

- Test the affected existing functionality before and after each isolated change.
- Test normal behavior, error handling, and relevant edge cases.
- Verify affected shared components, routes, services, and API consumers.
- Run relevant syntax, build, security, and functional regression checks.
- Use isolated or staging environments for testing whenever available.
- Never perform tests that unintentionally modify production payments, user data, or storage.
- Passing syntax checks or production build does NOT prove application functionality.
- Zero npm audit, Dependabot, or CodeQL alerts does NOT prove application functionality.
- Isolated dependency tests do NOT replace real application regression tests.
- Never report 100% completion while required functional or runtime tests remain unverified.

### Backend-Specific Regression Gate

- Preserve every explicitly protected route, including the Public Story Detail route documented below.
- Verify actual route registration, HTTP methods, middleware order, authentication, authorization, rate limits, and API response contracts before and after changes.
- Inspect affected Web-React-2 and AdminDashboard consumers. Test affected navigation and API workflows rather than assuming a successful server startup proves compatibility.
- For affected cache paths, test cold cache, warm cache, and invalidation without increasing unnecessary requests.
- For affected payments, wallets, purchases, unlocks, recovery, and webhooks, verify authorization, idempotency, existing balance rules, and failure handling with isolated test data.
- For affected media uploads, verify existing direct Cloudflare upload, client-side compression, server fallback, size limits, and temporary-file cleanup without changing unrelated upload behavior.
- For affected workers, native dependencies, or resource-sensitive paths, verify runtime compatibility and compare relevant RAM, CPU, request volume, Disk IO, and bandwidth against the baseline. Do not introduce uncontrolled workers or retry loops.
- Do not change production database records, RLS, GRANT permissions, financial data, or storage as a testing shortcut.

### Mandatory Step-by-Step Workflow

1. Inspect the current code.
2. Verify the actual problem.
3. Identify the smallest safe change.
4. Record the rollback point.
5. Implement only the current change.
6. Review the complete diff.
7. Run relevant automated checks.
8. Verify affected existing functionality.
9. Report actual results and remaining risks.
10. Stop and wait for owner approval and required verification before starting the next independent change.

The owner's "Done, next" confirms that the previous instruction was carried out. It does not prove regression tests passed or authorize skipping verification.

### Regression and Rollback Protection

- If an existing feature breaks, immediately stop subsequent changes.
- Identify the exact commit and code difference responsible for the regression.
- Compare against the last known-good implementation.
- Restore or repair only the responsible change with owner approval.
- Never blindly roll back unrelated working changes.
- Never introduce additional speculative fixes while investigating a regression.
- Never merge or deploy an unverified candidate.
- If staging is unavailable, disclose the limitation and obtain explicit approval for a controlled release with a rollback plan.

### Mandatory Reporting

For every change, report:

- Exact file paths.
- Reason for the change.
- What was changed.
- Existing functionality that must remain unchanged.
- Tests actually performed.
- Tests passed, failed, or not performed.
- Remaining risks.
- Rollback point.

Never invent test results or claim that untested functionality works.

If required source code, verification, or approval is unavailable, STOP and report the blocker.

Application stability, data integrity, security, and preservation of existing functionality always take priority over development speed.

## Critical Protected Route — Public Story Detail

The following block in `src/routes/publicStories.routes.js` is production-critical and MUST remain unchanged.

```js
router.get(
  '/stories/:storyId',
  compressEpisodeJsonResponse,
  cachePublicStoryDataResponse('detail'),
  getPublicStoryById
)
```

- MUST NOT modify, remove, replace, move, reorder, or refactor this block.
- MUST preserve `getPublicStoryById`, its import, middleware order, route registration, and API contract.
- MUST NOT indirectly break `GET /api/public/stories/:storyId`.
- This restriction applies to all maintenance, security fixes, CodeQL fixes, performance optimization, caching, compression, and resource-cost reduction.
- Any exception requires explicit authorization from the repository owner.
- Before completing related changes, inspect the diff and verify that the protected block remains identical.
- Test story detail access on both cold and warm cache. A successful story list request does not prove story detail access works.
- If verification is unavailable, report it. Do not claim the endpoint is working.

### Known Production Regression (2026-11-25)

Commit: `dd20771751b7befcba07055b6bd9058b53093724`

Accidental removal of `getPublicStoryById` caused HTTP 404 "Route not found" and prevented readers from opening stories.

Never repeat this regression.

## Mandatory AI Startup Rule
Before creating, modifying, or reviewing backend code:
1. Read this `AGENTS.md`.
2. Inspect the target route, controller, service, middleware, and database query involved in the task.
3. Identify known frontend consumers when practical.
4. For Reader Website consumers, inspect the related code in `Xiaonai888/Web-React-2`.
5. For Admin consumers, inspect the related code in `Xiaonai888/AdminDashboard`.
6. Preserve existing API contracts unless the task explicitly requires changing them.
7. Do not mark work complete after checking only UI, Dark Mode, or translations.

## Data Fetch / API Efficiency Standard

Every endpoint that returns data which can grow over time must have an explicit data-size strategy.

This includes:
- libraries
- subscriptions
- comments
- replies
- notifications
- posts
- feeds
- histories
- logs
- orders
- users
- followers
- reactions
- episodes
- search results
- admin tables
- analytics rows
- any other growing collection

### Pagination and Limit Rules
- Never return an unbounded growing collection by default.
- Use pagination, cursor pagination, `.range()`, `.limit()`, or an equivalent bounded query.
- Normal default page size should be about 30 items.
- Normal maximum page size should be no more than 100 items unless the feature has a documented reason.
- Validate and clamp client-supplied `page`, `limit`, `offset`, or cursor values.
- Return enough pagination metadata for the frontend to know whether more data exists.
- Do not download the full dataset and slice it later in Node.

### Database Select Rules
- Avoid `select('*')` for list endpoints.
- Avoid nested `relation(*)` for growing list endpoints.
- Select only fields required by the API response or business logic.
- Large nested collections must have their own limit or pagination strategy.
- Prefer database-side filtering, sorting, counting, and aggregation.
- Do not fetch hundreds of rows into Node only to count, filter, or aggregate them when the database can do it.

### Count Rules
- Use database count queries when possible.
- Do not fetch rows only to calculate `.length`.
- Counts used in navigation badges, notifications, dashboards, or summaries must be computed efficiently.

### Bulk Action Rules
- Provide one backend endpoint for bulk actions when the frontend may act on many records.
- Bulk clear, bulk delete, bulk update, bulk approve, bulk archive, and similar operations should not require one request per item.
- Avoid API designs that force frontend code into unbounded `Promise.all(items.map(fetch...))`.
- Bulk operations must still validate ownership, permission, and scope.

### GET Request Rules
- GET endpoints should be read-only.
- Do not run unrelated cleanup, delete, archive, or update operations on every GET request.
- Periodic cleanup should use an intentional maintenance strategy, scheduled process, admin action, or another bounded mechanism.
- A read request may update state only when that behavior is intentionally part of the endpoint contract.

### Cache Rules
- Consider caching for read-heavy data that does not require immediate freshness.
- Do not cache private, security-sensitive, or highly dynamic data blindly.
- Reuse existing cache utilities and patterns before creating another cache system.
- Choose TTL based on the feature's freshness requirement.
- Mutations must invalidate or bypass affected cache when needed.
- Do not use cache as a replacement for proper database limits or pagination.

### Nested Data Rules
For comments/replies, stories/episodes, posts/reactions, users/followers, orders/items, or similar parent-child structures:
- Do not automatically return all child rows.
- Load a bounded child preview when needed.
- Provide a separate paginated endpoint for additional child rows when the collection can grow.
- Avoid multiplicative payloads caused by deeply nested unrestricted relations.

## API Compatibility Rule
Before changing an existing response shape:
1. Search for every known frontend consumer when practical.
2. Preserve existing fields unless removal is intentional.
3. Add pagination metadata without silently breaking existing clients.
4. Coordinate frontend changes when request parameters or response structure change.
5. Keep authentication and authorization behavior unchanged unless explicitly required.

## Query Review Checklist
For every new or modified collection endpoint, AI must check:
1. Is the query bounded?
2. Is the default limit safe?
3. Is the maximum limit safe?
4. Are only necessary columns selected?
5. Are nested relations bounded?
6. Is counting done in the database?
7. Could this endpoint cause N frontend requests?
8. Should a bulk endpoint exist?
9. Does the GET endpoint mutate data unnecessarily?
10. Is cache appropriate?
11. Are ownership and permissions preserved?
12. Are existing consumers still compatible?

## Cross-Repo Inspection Rule
If backend work changes an endpoint consumed by Reader Website:
- inspect the matching request code in `Xiaonai888/Web-React-2`.

If backend work changes an endpoint consumed by Admin Dashboard:
- inspect the matching request code in `Xiaonai888/AdminDashboard`.

If both consume it:
- inspect both.

Do not assume a backend change is safe without checking the consumer when the API contract or pagination behavior changes.

## Completion Rule
A backend data feature is NOT complete if:
- a growing collection is unbounded,
- a list endpoint uses unnecessary `select('*')`,
- nested growing data is unrestricted,
- the frontend must send one request per item for a bulk action,
- rows are fetched only to count them,
- a GET endpoint performs unnecessary cleanup mutations,
- pagination breaks an existing consumer,
- authorization/ownership checks are weakened,
- or the application fails its existing checks/build/startup validation.

## AI Mandatory Workflow
When asked to create or modify backend data behavior:
1. Read `AGENTS.md`.
2. Inspect the target backend route.
3. Inspect the target controller/service.
4. Inspect the database query.
5. Identify and inspect the relevant frontend consumer when practical.
6. Check limit/pagination.
7. Check selected fields.
8. Check nested collection size.
9. Check request count and bulk behavior.
10. Check count/aggregation strategy.
11. Check cache suitability.
12. Preserve API compatibility and authorization.
13. Implement the smallest safe change.
14. Run the relevant existing checks before calling the task complete.

## Supabase Public Table Access Standard (Effective 2026-10-30)

- From October 30, 2026, existing Supabase projects will not automatically expose newly created `public` tables to the Data API (`supabase-js`, PostgREST, GraphQL). Existing tables retain their existing grants.
- Every migration that creates or recreates a `public` table must explicitly decide whether the Data API needs access. When it does, include the required table `GRANT` statements in that same migration, instead of relying on implicit defaults.
- Grant only necessary operations (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) to the roles actually used (`anon`, `authenticated`, `service_role`). Do not copy blanket full-access grants to every table.
- `anon` must have only deliberately public permissions. Restrict reader-private, Diamonds, payments, gifts, income, admin, and security-related data to appropriate roles and ownership rules.
- Enable RLS and define appropriate per-operation policies for tables accessed by non-privileged roles. `GRANT` controls table operations while RLS controls permitted rows; one never replaces the other.
- Keep `service_role` and all privileged credentials exclusively in trusted server environments. Remember that Supabase service-role access bypasses RLS; enforce authorization in Backend endpoints.
- For new tables with identity/serial or other sequence-backed operations, inspect whether explicit sequence privileges are required; never grant more than necessary.
- Recreated schemas in new projects, preview branches, and `supabase db reset` must work without relying on legacy default grants. Do not retroactively alter existing tables unless the task explicitly calls for it.
- When encountering PostgREST error `42501 permission denied`, inspect the API role and the error hint, then add the smallest correct grant in the migration; also verify applicable RLS policies.
- Before completion, test intended operations using the same roles as production clients, reject unauthorized access, and preserve existing API behavior.
- Source: https://github.com/orgs/supabase/discussions/45329

## Mandatory Request Rate Limiting Standard (2026-10-24)

This rule applies to every new or modified Backend HTTP route, including routes intended to be mounted later. An existing global API limiter is a defense-in-depth layer, not proof that a sensitive route is correctly protected.

### Rate Limit Is Different from Data Limit
- Request rate limiting bounds requests per client and time window to prevent denial of service and abuse.
- Pagination, database `.limit()`/`.range()`, upload byte limits, batch limits, and caching bound work per request. They do not replace request rate limiting.
- Every new or modified route must pass BOTH checks when applicable.

### Required Express Route Pattern
1. Inspect the current route file, controller, authentication and permission middleware, any inherited limiter in `server.js`, and the actual route mount. Never assume a new router is already registered.
2. For expensive or privileged routes, apply an appropriate IP-based limiter BEFORE JWT verification, device/session checks, database queries, file operations, or other expensive middleware.
3. After authentication, keep the existing per-account/per-admin limiter and any stricter write, review, payment, upload, fraud, or action-specific limiter. Do not replace one tier with another.
4. Prefer explicit, auditable per-route ordering: IP limiter, authentication, authorization/permission, per-identity or action limiter, then controller. Shared `router.use()` guards may be valid at runtime, but must be confirmed to run before expensive operations; if CodeQL cannot recognize the protection, establish clearly ordered route-level protection and verify the new scan.
5. Apply protection to GET, POST, PUT, PATCH, DELETE, and other relevant handlers. Include each new endpoint, not only the first endpoint in a router.
6. Never move or remove existing `requireUser`, `requireAdmin`, permission checks, ownership validation, anti-fraud controls, audit logging, or response cache controls as a shortcut.
7. Reuse the repository's `express-rate-limit` package and working patterns. Choose and document limits based on endpoint cost, legitimate traffic, and existing clients; DO NOT blindly copy 600/min, 240/min, 90/min, 20/min, or 10/min to unrelated endpoints.
8. Use `req.ip` or the package's supported IP key generation for pre-authentication clients. Use verified `req.user`/`req.admin` identity only after auth has populated it. Never trust an arbitrary `X-Forwarded-For` header or change Express `trust proxy` without verifying Render/proxy topology and abuse implications.
9. Return HTTP 429 with a stable JSON error and sensible rate-limit headers where appropriate. Avoid caching private responses. Ensure OPTIONS preflight, retries, mobile clients, shared-network users, and normal polling are not broken.
10. Webhooks, payment callbacks, health checks, and trusted machine-to-machine routes need an explicit threat-specific plan. Preserve signatures, idempotency, source validation, and delivery/retry behavior; do not insert a generic limiter that silently rejects legitimate callbacks.
11. If a route genuinely cannot use a normal limiter, document the reason and alternative protection in that route's review. An exemption is not permission to ignore abuse risk.

### Mandatory Route Review Before Delivery
For EACH new or changed Backend route, verify:
1. Is there a request-rate limit before expensive authentication, database or filesystem work?
2. Are the correct post-auth user/admin and write limits retained?
3. Are page size, offsets, payload size, nested data and bulk work independently bounded?
4. Are all handlers and HTTP methods covered, and is the router mounted only when the feature is intended to be active?
5. Does a normal authorized request succeed, while missing/invalid auth is rejected and excessive requests receive 429?
6. Do proxy/IP handling, shared users, legitimate traffic, error shape, cache behavior and existing frontend callers remain compatible?
7. Have syntax/runtime tests, the relevant diff, and the CodeQL result for the new commit been checked?

Do not claim a Missing rate limiting alert is fixed just because a limiter variable exists. Verify that execution passes through the limiter before the reported expensive route action. Do not dismiss, silence, or disable the CodeQL rule. If these checks cannot be performed, report what is unverified.

  ## Security and CodeQL Rules (2026-10-22)

- Before a security fix, read this AGENTS.md and inspect the latest related routes, middleware, controllers, services, SQL, and the affected Reader/Admin callers. Do not replace a full file from an outdated copy.
- Treat request bodies, query strings, route parameters, headers, file metadata, webhook payloads, remote API responses, and database content as untrusted. Validate type, size, format, allowed values, and ownership at the server boundary.
- Keep authentication, role checks, user ownership, rate limits, anti-fraud thresholds, payment verification, audit history, and Supabase RLS and grants intact. Apply least privilege to every database role and endpoint.
- Use parameterized queries. Never interpolate untrusted text into SQL, shell commands, server-side templates, paths, redirects, or HTML. Escape output for its actual context and use JSON/plain-text content types when HTML is not required.
- Validate outbound request hosts and protocols before network access to avoid SSRF. Validate redirect destinations and file/media URLs; reject dangerous URL schemes and unapproved hosts.
- Never expose, log, commit, or return private API keys, tokens, service_role credentials, signed upload URLs, or sensitive payment details. Check logs and error responses for inadvertent disclosure.
- Preserve payment webhook signature verification, reference uniqueness, authorization, and idempotency. Never credit Diamonds, Coins, gifts, or author income from an unverified client-supplied status.
- Do not enable previously disabled features, bypass a kill switch, remove middleware, weaken upload validation, or silently change existing API contracts without an explicit and reviewed request.
- Fix CodeQL findings by tracing the real untrusted source to the dangerous sink. Never silence a query, disable a scanner, dismiss a live finding, or make a cosmetic rewrite only to obtain zero open alerts.
- Retain existing GitHub security workflows, including .github/workflows/secret-scan.yml. Do not install a duplicate CodeQL workflow without first checking repository CodeQL Default Setup or existing scanning configuration.
- After changing code, review the complete diff and run applicable syntax checks, tests, build/startup validation, and affected consumer checks. Verify the security scan covers the new commit before claiming the alert is closed. Zero open CodeQL alerts does not guarantee complete application security.


## Safe Maintenance & Security Update Standard

- Verify the actual problem before modifying code.
- Treat automated security alerts as findings that require investigation, not automatic instructions to modify code.
- Verify installed dependency versions, official advisories, actual usage, exploit conditions, and production exposure.
- Prioritize confirmed risks and document reasons for deferring valid security alerts.
- Inspect affected routes, controllers, services, middleware, database functions, and API consumers before editing.
- Apply the smallest effective change for one confirmed problem at a time. Follow the Mandatory Change Isolation & Regression Gate. Never batch independent fixes.
- Prefer compatible security patches. Major dependency upgrades require compatibility review and explicit approval.
- Never blindly merge Dependabot updates or run forced audit fixes.
- Keep package.json and package-lock.json synchronized.
- Do not introduce unnecessary dependencies, services, background workers, or infrastructure costs.
- Do not replace working systems or refactor unrelated code without a demonstrated need.
- Never weaken security controls or dismiss valid alerts merely to reduce alert counts.
- Verify affected functionality, compatibility, and available tests before deployment.
- Report test results, remaining risks, and rollback requirements.
- Stop and report uncertainty when required source code or verification is unavailable.

## Backend & Data Integrity Protection

- Preserve existing API contracts and compatibility with Web-React-2 and AdminDashboard.
- Preserve authentication, authorization, sessions, Passkey verification, and access controls.
- Preserve payment verification, wallet balances, purchases, rewards, and episode unlocking rules.
- Protect financial operations against duplicate execution, race conditions, and unauthorized modifications.
- Preserve database integrity, transactions, RLS policies, GRANT permissions, and existing data.
- Never execute destructive database migrations without explicit approval, backup, and rollback preparation.
- Avoid unnecessary database queries, polling, retry loops, and repeated API requests.
- Reuse existing caching, rate limits, and background processing mechanisms when appropriate.
- Evaluate changes affecting RAM, CPU, Disk IO, bandwidth, and infrastructure costs.
- Prefer bounded processing and prevent uncontrolled concurrency.
- Preserve client-side processing and direct storage uploads where appropriate.
- Never expose credentials, access tokens, payment secrets, or sensitive user data in logs or API responses.
- Verify affected routes, controllers, services, and database operations before marking changes complete.
- Never deploy unverified changes directly to production.



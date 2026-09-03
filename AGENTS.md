# Shadow Backend Development Rules

## Scope
These rules apply to the entire `Shadow-Backend` repository.

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

# Codebase Audit & Improvement Plan

**Auditor:** Senior Tech Lead (automated deep audit)
**Date:** 2026-02-20
**Scope:** Full codebase — server, client, shared, Python services, config, migrations, docs
**Codebase:** AI Sales Operator — B2B SaaS for AI-powered customer support automation

---

## Section 1: Critical Issues

Issues that can cause data breaches, crashes, or data loss. **Fix immediately.**

### CRIT-01: ~~WebSocket server has ZERO authentication~~ — FIXED

- **File:** `server/services/websocket-server.ts`
- **Lines:** 19–36, 58–66
- **Problem:** Any client can connect to `/ws`, send `{"type":"set_tenant","tenantId":"<any-uuid>"}`, and receive all real-time messages (customer data, AI suggestions, conversation updates) for any tenant. There is no session/token verification on the upgrade request or on `set_tenant` messages. This is a full cross-tenant data breach vector.
- **Solution:** Verify the session cookie on the HTTP `upgrade` request before accepting the WebSocket connection. Validate that the `tenantId` set by the client matches the user's authenticated tenant. Reject unauthorized connections with `socket.destroy()`.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Session cookie is now verified on WebSocket upgrade via `authenticateAndUpgrade()`. Tenant is resolved from the authenticated user's session and bound to the connection. Clients cannot override `tenantId`. Unauthenticated connections are rejected with 401 in production. Client updated to no longer send `set_tenant`.

### CRIT-02: ~~No tenant isolation on entity lookups — cross-tenant data access~~ — FIXED

- **File:** `server/routes.ts`
- **Lines:** 171–181 (customers), 570–593 (conversations), and many more
- **Problem:** `GET /api/customers/:id`, `PATCH /api/customers/:id`, `GET /api/customers/:id/notes`, `DELETE /api/customers/:id/data`, `PATCH /api/conversations/:id`, and other endpoints fetch entities by UUID without verifying the entity belongs to the requesting user's tenant. An authenticated user from tenant A can read and modify data from tenant B by guessing UUIDs.
- **Solution:** Add `AND tenantId = :userTenantId` to all single-entity queries, or add a middleware that verifies ownership after fetching.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — All single-entity route handlers now verify `entity.tenantId === user.tenantId` after fetch. Affected endpoints: `GET/PATCH /api/customers/:id`, `GET/POST/DELETE /api/customers/:id/notes`, `GET/PATCH/POST /api/customers/:id/memory`, `PATCH /api/conversations/:id`, `POST /api/conversations/:id/messages`, `POST /api/conversations/:id/generate-suggestion`, `POST /api/suggestions/:id/{approve,edit,reject,escalate}`, `PATCH /api/escalations/:id`, `PATCH/DELETE /api/products/:id`, `PATCH/DELETE /api/knowledge-docs/:id`. All return 404 (not 403) on cross-tenant access to avoid leaking entity existence.

### CRIT-03: ~~Error handler re-throws, crashing the process~~ — FIXED

- **File:** `server/index.ts`
- **Lines:** 97–103
- **Problem:** After sending the error response to the client, the global error handler calls `throw err`. This re-throws into the Node.js event loop as an unhandled exception, which crashes the process.
- **Solution:** Remove `throw err`. Log the error instead (e.g., `console.error(err)` or use a structured logger). If you want crash-on-unknown, do it only for programmer errors, not for all errors.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Replaced the broken inline error handler (which sent a response then re-threw) with `app.use(errorHandler)` from `server/middleware/error-handler.ts`. The existing middleware already logs errors as structured JSON, handles `ZodError` → 400, operational errors → their status code, and unknown errors → 500, without re-throwing. Removed the now-unused `Request`, `Response`, `NextFunction` imports from `server/index.ts`.

### CRIT-04: ~~SESSION_SECRET can be undefined in production~~ — FIXED

- **File:** `server/config.ts` line 14; session setup uses `process.env.SESSION_SECRET!`
- **Lines:** 14, and wherever session is configured
- **Problem:** `SESSION_SECRET` is defined as `z.string().min(32).optional()`. In production, if the env var is missing, sessions are signed with `undefined` as the secret, making session cookies trivially forgeable.
- **Solution:** Make `SESSION_SECRET` required in production. Change the schema to conditionally require it, or add a startup check that aborts if `NODE_ENV=production && !SESSION_SECRET`.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — `envSchema` now includes a `.superRefine()` that adds a Zod validation issue when `NODE_ENV` is `production` or `staging` and `SESSION_SECRET` is absent. `validateConfig()` already throws on any Zod failure in non-development environments, so the process aborts at startup with a clear error message before any route or session middleware can be mounted. `server/session.ts` no longer uses the `!` non-null assertion; it reads the secret through `getConfig()` and applies a clearly-labelled dev-only fallback string (so local dev still starts without the variable set). `checkRequiredServices()` updated: the production hard-fail is now schema-level; it emits a soft warning only in development.

### CRIT-05: ~~RBAC `extractUserRole()` always returns `"operator"` in production~~ — FIXED

- **File:** `server/middleware/rbac.ts`
- **Lines:** 92–97
- **Problem:** The function has a TODO comment saying "extract from session/JWT" but falls through to `return "operator"` for all production requests. This means every authenticated user (including guests, viewers, or even someone who should be banned) gets `operator` permissions. The `session.role` field IS set on login (line 109), but `extractUserRole` ignores it when there's no `session.userId`.
- **Solution:** Read role from `req.session.role` (which is already set by auth). The `_requireAuth` middleware at line 109 does `req.userRole = session.role || extractUserRole(req)` — so for logged-in users this works. But the fallback in `extractUserRole` should return `"guest"` (least privilege), not `"operator"`.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — In production, `extractUserRole()` now reads `req.session.role` (set by the auth service at login) and validates it against the list of known roles before returning it. When no authenticated session role is present, the function returns `"guest"` (least privilege) instead of `"operator"`. The dev/staging behavior (X-Debug-Role header → operator fallback) is unchanged.

### CRIT-06: ~~`PATCH /api/tenant` accepts raw body without validation~~ — FIXED

- **File:** `server/routes/routes.ts`
- **Lines:** ~77
- **Problem:** `req.body` is passed directly to `storage.updateTenant()` with no Zod validation and no field whitelist. An attacker could overwrite arbitrary tenant fields including `status`, `id`, `planId`, etc.
- **Solution:** Define a Zod schema for allowed tenant update fields. Validate and whitelist before passing to storage.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Added `patchTenantSchema` to `server/middleware/validation.ts` that explicitly whitelists only the 16 user-editable tenant fields (`name`, `language`, `tone`, `addressStyle`, `currency`, `timezone`, `workingHoursStart`, `workingHoursEnd`, `workingDays`, `autoReplyOutsideHours`, `escalationEmail`, `escalationTelegram`, `allowDiscounts`, `maxDiscountPercent`, `templates`). Security-sensitive fields (`id`, `status`, `createdAt`) are excluded from the schema — Zod strips unknown keys by default, so any attempt to send them is silently dropped. `validateBody(patchTenantSchema)` middleware is applied to `PATCH /api/tenant` before the handler; invalid payloads receive a structured 400 response.

### CRIT-07: ~~`drizzle-kit push --force` runs in production startup~~ — FIXED

- **File:** `start.sh` line 3, `package.json` line 9
- **Lines:** start.sh:3, package.json:9
- **Problem:** The production start command runs `drizzle-kit push --force` which auto-applies schema changes to the production database without review, approval, or backup. This can cause data loss (column drops, type changes) silently.
- **Solution:** Remove `--force`. Implement a proper migration strategy: generate SQL migrations, review them, apply manually or via CI with rollback capability.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Removed `drizzle-kit push --force` from all production entry points. `npm run start` (`package.json`) now only starts the server (`NODE_ENV=production node dist/index.cjs`) — no schema mutations at startup. A dedicated `npm run db:migrate` script runs `drizzle-kit migrate`, which applies only the reviewed, version-controlled SQL files in `./migrations/`. All deployment entry points updated: `start.sh` calls `npx drizzle-kit migrate` then starts the server directly; `Dockerfile` CMD uses `drizzle-kit migrate`; `nixpacks.toml` start command runs `npm run db:migrate && npm run start`. `server/scripts/migrate.ts` updated to invoke `drizzle-kit migrate`. `.cursorrules` updated to document the correct migration workflow and prohibit `push --force` in production.

### CRIT-08: ~~Routes use `getDefaultTenant()` instead of user's tenant~~ — FIXED

- **File:** `server/routes/routes.ts`
- **Lines:** ~150–167
- **Problem:** Multiple routes (customer list, onboarding setup, etc.) call `storage.getDefaultTenant()` instead of resolving the authenticated user's actual tenant. In a multi-tenant system, all users see the same "default" tenant's data, breaking tenant isolation.
- **Solution:** Resolve tenant from `req.user.tenantId` (available via the session). Never use `getDefaultTenant()` in tenant-scoped routes.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Eliminated all 22 calls to `storage.getDefaultTenant()` in `server/routes.ts`. Each route now resolves the tenant from the authenticated user's session via `storage.getUser(req.userId)` and uses `user.tenantId`. Routes that already had a fetched user variable (`genUser`, `approveUser`, `editUser`, `rejectUser`) now use that variable's `tenantId` directly. Routes that only needed `tenant.id` use `user.tenantId` directly (no redundant full-tenant fetch). The `POST /api/onboarding/setup` route no longer creates new tenants as a fallback — it updates the authenticated user's own tenant and returns 403 if none is associated. The training-samples routes had a partial "fallback to default" pattern that is now removed entirely: a missing `tenantId` returns 403, not a cross-tenant default. The WhatsApp Personal IIFE inside `GET /api/channels/status` resolves tenantId from the authenticated user instead of querying the first tenant in the DB.

### CRIT-09: ~~Impersonation doesn't update `tenantId` in session~~ — FIXED

- **File:** `server/routes/admin.ts`
- **Lines:** ~1215–1222 (start), ~1262–1269 (exit)
- **Problem:** When a platform admin impersonates a user, the session sets `userId` and `role` but never updates `tenantId`. Subsequent requests may use the admin's original `tenantId`, causing cross-tenant data access or broken impersonation.
- **Solution:** Set `session.tenantId = targetUser.tenantId` during impersonation.
- **Priority:** CRITICAL
- **Status:** ✅ FIXED — Impersonation start now saves `session.originalTenantId = adminUser.tenantId ?? null` and sets `session.tenantId = user.tenantId`. Impersonation exit restores `session.tenantId = session.originalTenantId ?? null` and deletes `session.originalTenantId`. All subsequent requests made during an impersonation session now operate under the impersonated user's tenant, preventing the admin's `tenantId` from leaking into tenant-scoped queries.

---

## Section 2: Technical Debt

### ~~DEBT-01: Audit log is in-memory only — all events lost on restart~~ — FIXED

- **File:** `server/services/audit-log.ts`
- **Lines:** 13, 49
- **Problem:** Despite having an `auditEvents` table in the database schema (`shared/schema.ts`), audit events are stored only in a JavaScript `Map`. All audit history is lost on every server restart. The Map also grows unboundedly (no eviction, no size limit), creating a memory leak.
- **Solution:** Write events to PostgreSQL via `storage.createAuditEvent()`. Add batch-insert for performance. Remove the in-memory Map.
- **Effort:** Medium
- **Status:** ✅ FIXED — Removed the in-memory `Map` entirely. `audit-log.ts` now imports `db` and the `auditEvents` table directly and buffers insert rows in memory (`_buffer: AuditEventInsertRow[]`). A `setInterval` timer flushes the buffer to PostgreSQL every 500 ms using a single batch `db.insert(auditEvents).values(batch)`. When the buffer reaches 50 events a fire-and-forget eager flush is also triggered. Failed batches are re-queued at the front of the buffer (capped at 500 to bound memory). The timer calls `.unref()` so the Node.js event loop can exit cleanly. All three query methods (`getEventsByEntity`, `getEventsByConversation`, `getRecentEvents`, `getAllEvents`) now issue Drizzle ORM queries against the `audit_events` table instead of filtering the in-memory Map. `getEventsByConversation` uses a JSONB `->>'conversationId'` expression to match events for related entities (suggestions, messages) that store the conversation reference in metadata.

### ~~DEBT-02: Shared audit context across concurrent requests~~ — FIXED

- **File:** `server/services/audit-log.ts`
- **Lines:** 14–18
- **Problem:** The audit log service is a singleton with a single `context` object. Concurrent requests overwrite each other's context (requestId, IP, tenantId), causing audit events to be attributed to the wrong request/user.
- **Solution:** Pass context per-call instead of setting it on the singleton. Or use AsyncLocalStorage (Node.js) for request-scoped context.
- **Effort:** Medium
- **Status:** ✅ FIXED — Replaced the shared `context: AuditContext` object with `AsyncLocalStorage<AuditContext>`. Added `runWithContext(ctx, fn)` that calls `this._als.run({ ...ctx }, fn)` to create an isolated store per request. Updated `requestContextMiddleware` (`server/middleware/request-context.ts`) to call `auditLog.runWithContext({ requestId, ipAddress, userAgent }, () => next())` instead of `setContext` + `clearContext`; every async operation triggered by `next()` inherits the per-request ALS store automatically. `setContext` now merges into the current store via `Object.assign(store, ctx)` (called from route handlers to add `tenantId`) and is a no-op outside a request. `clearContext` resets the current store's fields. Concurrent requests each have their own independent ALS store, so no cross-request contamination of audit context is possible.

### DEBT-03: ~~`MemStorage` class — ~1,400 lines of dead code~~ — FIXED

- **File:** `server/storage.ts`
- **Lines:** ~269–1697
- **Problem:** The export at the end creates `DatabaseStorage`. The entire `MemStorage` class is unused in production. It must be maintained in sync with the `IStorage` interface, doubling the maintenance burden.
- **Solution:** Delete `MemStorage` or move it to a test utility file if needed for unit testing.
- **Effort:** Low
- **Status:** ✅ FIXED — `MemStorage` class (~1,400 lines) removed from `server/storage.ts`. `server/storage.ts` now contains only the `IStorage` interface and the `DatabaseStorage` export (~230 lines). The class was moved to `server/__tests__/helpers/mem-storage.ts` (a test-only module) since 4 integration tests depended on it. All test imports updated to the new path. No production code imports `MemStorage`. Four pre-existing type errors in the class body were also fixed during the move.

### DEBT-04: ~~`routes.ts` is a monolithic 4,800+ line file~~ — FIXED

- **File:** `server/routes.ts`
- **Lines:** 1–4800+
- **Problem:** A single file registers 100+ endpoints with inline business logic. Extremely difficult to navigate, review, maintain, or test.
- **Solution:** Split into domain-specific route files (already partially done with `auth.ts`, `admin.ts`, etc.). Move remaining routes: `customer-routes.ts`, `conversation-routes.ts`, `product-routes.ts`, `knowledge-base-routes.ts`, `analytics-routes.ts`, `onboarding-routes.ts`, `billing-routes.ts`, `vehicle-lookup-routes.ts`.
- **Effort:** High
- **Status:** ✅ FIXED — Split into 8 domain-specific route modules under `server/routes/`: `customer.routes.ts`, `conversation.routes.ts`, `product.routes.ts`, `knowledge-base.routes.ts`, `analytics.routes.ts`, `onboarding.routes.ts`, `billing.routes.ts`, `vehicle-lookup.routes.ts`. Each exports a single Express Router with all original middleware, validation, and tenant isolation preserved. The main `server/routes.ts` is now a thin index that only imports and mounts these routers alongside existing auth, admin, webhook, and phase-0 sub-routers. Pure structural refactor — no business logic changes.

### DEBT-05: 100+ `as any` type casts across server code

- **File:** Multiple (46+ server files)
- **Lines:** Scattered — notable: `admin.ts` (28 casts), `auth-service.ts` (9 casts)
- **Problem:** Bypasses TypeScript safety. The most common pattern is `(req as any).user` — Express request is not properly typed.
- **Solution:** Extend Express `Request` type via declaration merging (partially done in `rbac.ts` lines 64–71). Apply consistently. Replace remaining `as any` with proper types.
- **Effort:** Medium

### DEBT-06: ~~Duplicate batch utils~~ — FIXED

- **File:** `server/batch/utils.ts` AND `server/replit_integrations/batch/utils.ts`
- **Lines:** Entire files
- **Problem:** Near-identical files. The `replit_integrations` copy is a legacy artifact from the Replit platform.
- **Solution:** Delete `server/replit_integrations/` entirely.
- **Effort:** Low
- **Status:** ✅ FIXED — Deleted `server/replit_integrations/batch/utils.ts` and the entire `server/replit_integrations/` directory. No code imported from this path; it was a completely orphaned legacy artifact.

### DEBT-07: Email provider only logs to console

- **File:** `server/services/email-provider.ts` (inferred from audit)
- **Lines:** Entire file
- **Problem:** Only `ConsoleEmailProvider` is implemented. Verification emails, password resets, and invite emails are never actually sent. Users cannot complete these flows.
- **Solution:** Implement a real email provider (SendGrid, Postmark, or SMTP). Make it configurable via env vars.
- **Effort:** Medium

### ~~DEBT-08: Message send worker has stub implementations~~ — FIXED

- **File:** `server/workers/message-send.worker.ts`
- **Lines:** 13–31
- **Problem:** `isMessageStillValid()` always returns `{valid: true}` — delayed messages are sent even if the conversation was resolved or the suggestion rejected. `markMessageAsSent()` and `markMessageAsFailed()` only log to console — delivery status is never persisted.
- **Solution:** Implement actual validity checks (conversation status, suggestion status). Update message status in the database.
- **Effort:** Medium
- **Status:** ✅ FIXED — `isMessageStillValid()` now queries `storage.getConversation()` and rejects when `status` is in `{"resolved", "closed"}`; if the job carries a `suggestionId`, it also queries `storage.getAiSuggestion()` and rejects when `status` is in `{"rejected", "cancelled"}`. `markMessageAsSent()` fetches the existing message, merges `{deliveryStatus: "sent", deliveredAt, externalMessageId}` into the metadata JSONB, then persists via the new `storage.updateMessage()`. `markMessageAsFailed()` does the same with `{deliveryStatus: "failed", failedAt, lastError}`. Added `updateMessage(id, Partial<InsertMessage>): Promise<Message | undefined>` to `IStorage`, `DatabaseStorage`, and `MemStorage` (test helper) following the same pattern as the existing `updateAiSuggestion`.

### DEBT-09: Hardcoded business values throughout codebase

- **File:** Multiple files
- **Lines:** Various
- **Problem:**
  - Price: `50` USDT/month hardcoded in `admin.ts`, `cryptobot-billing.ts`
  - Trial: `72` hours in `cryptobot-billing.ts`
  - Telegram account limit: `5` per tenant in `telegram-client-manager.ts`
  - Average response time: always `12ms` mock in `database-storage.ts:793`
  - `resolvedToday`: always `0` in `database-storage.ts:791`
- **Solution:** Move business constants to a config file or database-backed settings per tenant.
- **Effort:** Low

### DEBT-10: `deleteProduct` always returns true

- **File:** `server/database-storage.ts`
- **Lines:** ~504–507
- **Problem:** Returns `true` regardless of whether the product existed. Callers cannot distinguish between successful deletion and no-op.
- **Solution:** Check `result.rowCount` and return `false` if 0 rows affected.
- **Effort:** Low

### DEBT-11: `settings.tsx` is ~3,000+ lines

- **File:** `client/src/pages/settings.tsx`
- **Lines:** 1–3000+
- **Problem:** Massive single-file page containing all settings tabs, forms, channel configuration, decision engine config, human delay config, etc. Extremely hard to maintain.
- **Solution:** Extract each tab into its own component: `ChannelSettings.tsx`, `DecisionEngineSettings.tsx`, `HumanDelaySettings.tsx`, `TenantSettings.tsx`, etc.
- **Effort:** Medium

### DEBT-12: ~~`@types/*` packages in production dependencies~~ — FIXED

- **File:** `package.json`
- **Lines:** 48–52 (`@types/bcrypt`, `@types/ioredis-mock`, `@types/memoizee`, `@types/multer`, `@types/qrcode`, `@types/supertest`)
- **Problem:** Type definition packages are in `dependencies` instead of `devDependencies`. They're included in the production bundle unnecessarily.
- **Solution:** Move all `@types/*` packages to `devDependencies`.
- **Effort:** Low
- **Status:** ✅ FIXED — Moved `@types/bcrypt`, `@types/ioredis-mock`, `@types/memoizee`, `@types/multer`, `@types/qrcode`, and `@types/supertest` from `dependencies` to `devDependencies`. Type-only packages are never bundled at runtime; they are stripped by TypeScript and have no production footprint.

### DEBT-13: ~~Test dependencies in production dependencies~~ — FIXED

- **File:** `package.json`
- **Lines:** 94 (`supertest`), 101 (`vitest`), 71 (`ioredis-mock`)
- **Problem:** `supertest`, `vitest`, and `ioredis-mock` are test-only packages but listed in `dependencies`.
- **Solution:** Move to `devDependencies`.
- **Effort:** Low
- **Status:** ✅ FIXED — Moved `supertest`, `vitest`, and `ioredis-mock` from `dependencies` to `devDependencies`. All three are exclusively imported in `*.test.ts` files under `server/__tests__/` and `server/tests/`; no production source file imports them. They are excluded from production builds when `NODE_ENV=production` and `npm install --omit=dev` is used (e.g., in Docker).

---

## Section 3: Architectural Improvements

### ARCH-01: ~~Extract route handlers from monolithic routes.ts~~ — DONE

- **Current state:** 100+ endpoints with inline business logic in a single `routes.ts` (4,800+ lines). Some routes already extracted (`auth.ts`, `admin.ts`, `health.ts`, webhooks).
- **Proposed change:** Split into domain-specific route modules: `customer.routes.ts`, `conversation.routes.ts`, `product.routes.ts`, `knowledge-base.routes.ts`, `analytics.routes.ts`, `onboarding.routes.ts`, `billing.routes.ts`, `vehicle-lookup.routes.ts`. Each file < 300 lines. Central `routes.ts` only imports and mounts.
- **Benefits:** Easier navigation, code review, testing, and onboarding. Enables per-route-group middleware.
- **Risks:** Large diff, potential merge conflicts. Mitigate by doing it in one focused PR.
- **Status:** ✅ DONE — All 8 domain route modules created and mounted. See DEBT-04 for details.

### ARCH-02: Move audit log to database-backed implementation

- **Current state:** In-memory `Map` with unbounded growth. Shared mutable context across concurrent requests. All data lost on restart.
- **Proposed change:** Use the existing `auditEvents` table in the schema. Write events via `DatabaseStorage`. Use `AsyncLocalStorage` for per-request context. Add background flush for performance.
- **Benefits:** Persistent audit trail, compliance-ready, no memory leak, correct attribution.
- **Risks:** Slight increase in DB write load. Mitigate with batched inserts.

### ARCH-03: Implement proper multi-tenancy throughout

- **Current state:** Many routes use `getDefaultTenant()` or skip tenant ownership checks on entity lookups. WebSocket allows arbitrary tenant impersonation.
- **Proposed change:** Create a middleware that resolves `req.tenantId` from the authenticated session. Add tenant scoping to all storage methods. Add ownership verification on all entity lookups.
- **Benefits:** True multi-tenancy, data isolation, security compliance.
- **Risks:** Requires touching many routes and storage methods. Thorough testing needed.

### ~~ARCH-04: Replace in-memory rate limiting with Redis-backed~~ — FIXED

- **Current state:** Rate limiters use in-memory `Map` (`server/middleware/rate-limiter.ts`). Auth rate limiter uses `express-rate-limit` (also in-memory). PM2 cluster mode means each worker has separate limits.
- **Proposed change:** Use `ioredis` (already a dependency) for rate limit state. Adopt `rate-limit-redis` store for `express-rate-limit`.
- **Benefits:** Correct rate limiting across all workers. Survives restarts.
- **Risks:** Redis becomes a harder dependency. Already required for BullMQ, so minimal additional risk.
- **Status:** ✅ FIXED — Added `server/redis-client.ts` (shared ioredis singleton); `rate-limiter.ts` now uses atomic Redis INCR+PEXPIRE Lua script for all custom limiters with transparent in-memory fallback when Redis is unavailable; `server/routes/auth.ts` `express-rate-limit` instances use `rate-limit-redis` `RedisStore` with `passOnStoreError: true` for graceful fallback; `server/index.ts` eagerly initialises the Redis client at startup and closes it in the graceful shutdown sequence.

### ~~ARCH-05: Implement graceful shutdown~~ — FIXED

- **Current state:** `SIGTERM` handler only kills the Python child process. No HTTP server drain, no DB pool close, no BullMQ worker shutdown.
- **Proposed change:** On `SIGTERM`: stop accepting new connections, drain in-flight requests (with timeout), close BullMQ workers, close DB pool, close WebSocket server, then exit.
- **Benefits:** Zero-downtime deployments. No lost messages or orphaned connections.
- **Risks:** Low. Standard Node.js pattern.
- **Status:** ✅ FIXED — `server/index.ts` now exports a single `gracefulShutdown(signal)` function registered on both `SIGTERM` and `SIGINT`. Teardown order: (1) kill Max Personal Python subprocess, (2) `httpServer.close()` with a 5-second forced-drain timeout, (3) close all three BullMQ queue connections in parallel via `Promise.allSettled` (`closeQueue`, `closeVehicleLookupQueue`, `closePriceLookupQueue`), (4) `realtimeService.close()` (new `close()` method added to `RealtimeService` in `websocket-server.ts`), (5) `pool.end()` (`pool` exported from `server/db.ts`), (6) `process.exit(0)`. An `isShuttingDown` guard prevents re-entry if a second signal arrives mid-sequence.

### ARCH-06: Introduce service layer between routes and storage

- **Current state:** Route handlers directly call `storage.*` methods and contain business logic (validation, authorization checks, side effects like WebSocket broadcasts).
- **Proposed change:** Introduce service classes (e.g., `CustomerService`, `ConversationService`) that encapsulate business logic. Routes only handle HTTP concerns (parsing, responding). Storage only handles data access.
- **Benefits:** Testable business logic without HTTP. Single responsibility. Reusable logic across routes and workers.
- **Risks:** Significant refactor. Do incrementally, starting with the most complex domains (conversations, customers).

---

## Section 4: Security

### 4.1 Secret Storage Practices

| Aspect | Status | Notes |
|--------|--------|-------|
| Integration secrets (API keys) | ✅ AES-256-GCM encryption | Via `secret-store.ts` with `INTEGRATION_SECRETS_MASTER_KEY` |
| Session secret | ✅ Required in production/staging | `envSchema.superRefine` aborts startup if missing (CRIT-04 fixed) |
| OpenAI API key | ⚠️ `"sk-placeholder"` fallback | Hardcoded in 4 files — misleading, looks like a real key prefix |
| Telegram session strings | ✅ Encrypted at rest | `sessionString` is encrypted with AES-256-GCM via `secret-store.ts` when `INTEGRATION_SECRETS_MASTER_KEY` is set. Legacy plaintext sessions are detected and passed through; decrypt failure returns null (re-auth). See 4.6. |
| `.env.example` | ✅ Exists | 110 lines, covers all env vars. `.env` is gitignored |
| Secrets in logs | ✅ PII sanitizer exists | `server/utils/sanitizer.ts` masks API keys in logs |

### 4.2 Input Validation Coverage

| Area | Status | Notes |
|------|--------|-------|
| Zod validation middleware | ✅ Exists | `server/middleware/validation.ts` |
| Route-level validation | ⚠️ Inconsistent | Some routes use Zod, many pass `req.body` directly (e.g., CRIT-06) |
| LIKE pattern injection | ⚠️ Unescaped | `%` and `_` in search queries act as wildcards (`database-storage.ts:243-246`) |
| WebSocket message validation | ❌ None | `JSON.parse` with no schema validation on WS messages |

### 4.3 SQL Injection Protection

| Area | Status | Notes |
|------|--------|-------|
| Drizzle ORM parameterization | ✅ Good | All queries use Drizzle's query builder — values are parameterized |
| Raw SQL | ✅ Minimal | Only in migration files, not in application code |
| LIKE patterns | ⚠️ See 4.2 | Not SQL injection, but LIKE wildcard injection |

### 4.4 Rate Limiting

| Area | Status | Notes |
|------|--------|-------|
| General API rate limit | ✅ Exists | In-memory — won't work with PM2 cluster |
| AI generation rate limit | ✅ Exists | Per-tenant AI limiter |
| Auth brute force protection | ✅ Exists | `express-rate-limit` — in-memory, per-process only |
| WebSocket rate limit | ❌ None | No limit on WS connections or messages |
| Webhook rate limit | ✅ Exists | Per-channel webhook limiter |
| Vehicle lookup rate limit | ⚠️ BullMQ concurrency only | No per-tenant rate limit on lookup API |

### 4.5 CORS Configuration

| Aspect | Status | Notes |
|--------|--------|-------|
| CORS middleware | ⚠️ Not explicitly configured | Relies on same-origin (Vite proxy in dev, static serve in prod). No explicit `cors()` middleware found. If deployed behind a different domain, CORS will block requests. |

### ~~4.6 Telegram Session Security~~ — Session storage FIXED

| Aspect | Status | Notes |
|--------|--------|-------|
| Session string storage | ✅ FIXED | `telegramSessions.sessionString` is encrypted with AES-256-GCM via `server/services/secret-store.ts`. New/updated sessions are encrypted when `INTEGRATION_SECRETS_MASTER_KEY` is set; stored as JSON `{v,ciphertext,meta}` in the same column. Legacy unencrypted values are detected (no leading `{` / invalid payload) and returned as-is. Decrypt failure (e.g. key rotated) returns `sessionString: null` so UI can require re-auth. Encrypt/decrypt is applied in `server/database-storage.ts` (create/update/get); `telegram-personal-adapter.ts` and `telegram-client-manager.ts` continue to use plaintext from storage. |
| Session reconnection | ⚠️ No FloodWait handling | `telegram-client-manager.ts` reconnect loop doesn't handle FloodWaitError — can result in Telegram IP ban |
| Auth state cleanup | ❌ No TTL | `authStates` Map in `telegram-personal-adapter.ts` leaks TelegramClient connections — no timeout/cleanup |
| Multi-account limits | ✅ 5 per tenant | Hardcoded but functional |

### 4.7 Authentication/Authorization Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| RBAC fallback returns `operator` | CRITICAL | See CRIT-05 |
| ~~No CSRF token~~ | ~~HIGH~~ | ~~Session auth without CSRF protection. `sameSite: lax` mitigates POST from cross-site, but not all cases~~ ✅ FIXED — Double-submit cookie pattern via `csrf-csrf` v4 (`server/middleware/csrf.ts`). `GET /api/csrf-token` generates a HMAC-signed token (httpOnly cookie) and returns the raw value; `apiRequest()` in `client/src/lib/queryClient.ts` fetches it lazily and sends it as `X-Csrf-Token` on all POST/PUT/PATCH/DELETE; webhook paths exempt via `skipCsrfProtection`; stale tokens auto-cleared on 403. |
| WebSocket unauthenticated | CRITICAL | See CRIT-01 |
| Impersonation missing tenantId | CRITICAL | See CRIT-09 |
| ~~Webhook verification skipped when secrets not set~~ | ~~HIGH~~ | ~~`webhook-security.ts:70-72` returns `{valid: true}` if secret is undefined~~ ✅ FIXED — All three verify functions (`verifyTelegramWebhook`, `verifyWhatsAppWebhook`, `verifyMaxWebhook`) now return `{valid: false, error: "Webhook secret not configured"}` when `NODE_ENV` is `"production"` or `"staging"` and the secret env var is absent. Permissive pass-through is retained only in development/test. |

### 4.8 Dependency Vulnerabilities

| Package | Version | Concern |
|---------|---------|---------|
| `express` | ^4.21.2 | Keep updated — Express 4.x has had path traversal issues in older versions |
| `@whiskeysockets/baileys` | ^7.0.0-rc.9 | Release candidate — may have undiscovered vulnerabilities |
| `telegram` (gramjs) | ^2.26.22 | Monitor for MTProto security issues |
| `passport` | ^0.7.0 | Passport 0.7 requires careful session handling |
| `stripe` | ^20.2.0 | ✅ Up to date |
| `openai` | ^6.15.0 | ✅ Up to date |
| `ioredis-mock` | ^8.13.1 | Should be in devDependencies, not production |

---

## Section 5: Performance

### ~~5.1 N+1 Queries~~ — FIXED

| Location | Method | Impact |
|----------|--------|--------|
| ~~`database-storage.ts:402-417`~~ | ~~`getConversationsByTenant()`~~ | ~~For each conversation: 1 query for customer + 1 query for all messages. 100 conversations = 201 queries.~~ ✅ FIXED — Rewritten with `INNER JOIN customers` + one batched `inArray` message query. 2 queries total regardless of conversation count. |
| ~~`database-storage.ts:419-437`~~ | ~~`getActiveConversations()`~~ | ~~Same N+1 pattern as above.~~ ✅ FIXED — Same approach: JOIN + single batched messages query. |
| ~~`database-storage.ts:736-744`~~ | ~~`getEscalationsByTenant()`~~ | ~~Fetches ALL conversations to get IDs, then queries escalations.~~ ✅ FIXED — Replaced two-step fetch with a Drizzle subquery: `WHERE conversationId IN (SELECT id FROM conversations WHERE tenantId = ?)`. Single query. |

### 5.2 Missing Caching Opportunities

| Opportunity | Current State | Recommendation |
|-------------|---------------|----------------|
| Tenant settings | Fetched from DB on every request | Cache with 60s TTL (tenant settings change rarely) |
| Feature flags | Read from JSON file on every check | Already in-memory, but file reads should be cached |
| RBAC permission matrix | Computed on every request | Already static — no action needed |
| Customer memory | Fetched on every AI generation | Cache with 5-minute TTL per customer |
| RAG embeddings | All loaded into memory per query | Index with pgvector extension for proper vector search |

### 5.3 Heavy Operations on Main Thread

| Operation | File | Impact |
|-----------|------|--------|
| Cosine similarity on all embeddings | `database-storage.ts:1127-1149` | Loads ALL 3072-dim embeddings into memory and computes similarity in JS. Will not scale past ~500 chunks per tenant. **Fix:** Use `pgvector` extension. |
| Full response body logging | `server/index.ts:74-88` | Serializes every API response to JSON for logging. Large responses (conversation history, product lists) cause I/O pressure. **Fix:** Log only status code and response size, not body. |
| ~~Dashboard metrics~~ | ~~`database-storage.ts:770-798`~~ | ~~Fetches ALL conversations, products, and docs into memory just to count them.~~ ✅ FIXED — `getDashboardMetrics()` now uses 4 `COUNT(*)` aggregate queries run in parallel via `Promise.all`. No rows are loaded into memory. |

### 5.4 Memory Leaks

| Leak | File | Impact |
|------|------|--------|
| ~~Audit log Map grows unboundedly~~ | ~~`audit-log.ts:13`~~ | ~~Every audit event is stored forever in memory. No eviction. Server will eventually OOM.~~ ✅ FIXED — In-memory Map removed; events batch-inserted into PostgreSQL. |
| Telegram `authStates` Map | `telegram-personal-adapter.ts` | TelegramClient connections stored without TTL. Abandoned auth flows leak connections. |
| In-memory rate limit Maps | `rate-limiter.ts:18-19` | Old entries never cleaned up. Grows proportionally to unique IPs/tenants. |

### 5.5 Bundle Size (Client)

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| ~~No code splitting / lazy loading~~ | ~~All 20 pages loaded upfront~~ | ✅ FIXED — All 20 page components in `client/src/App.tsx` converted to `React.lazy()`. Three `<Suspense fallback={<PageLoader />}>` boundaries added (main `Router`, `AuthRouter`, `OwnerRouter`). Each page is now a separate Vite/Rollup chunk loaded on first navigation. |
| 40+ shadcn/ui components imported | Tree-shaking helps but not fully | Already individual imports — OK |
| ~~recharts imported on all pages~~ | ~~Heavy charting library (~200KB)~~ | ✅ FIXED — `recharts` is only referenced in `ui/chart.tsx`. `Analytics` is now its own lazy chunk, so recharts stays out of the main bundle and loads only when `/analytics` is visited. |
| framer-motion | ~100KB | Only use where animations are needed, lazy-load elsewhere |
| ~~Google Fonts in index.html~~ | ~~Render-blocking~~ | ✅ ALREADY DONE — `&display=swap` was already present at the end of the Google Fonts URL in `client/index.html`, which causes the Fonts API to emit `font-display: swap` on every `@font-face` rule it serves. |

### 5.6 Database Query Optimization

| Query | Fix |
|-------|-----|
| ~~`getConversationsByTenant` — N+1~~ | ✅ FIXED — `INNER JOIN customers` + single batched `inArray` message query. 2 queries total. |
| ~~`getDashboardMetrics` — SELECT * to count~~ | ✅ FIXED — 4 `COUNT(*)` aggregate queries in `Promise.all`. No full rows loaded. |
| ~~`getEscalationsByTenant` — double query~~ | ✅ FIXED — Drizzle subquery: `WHERE conversationId IN (SELECT id FROM conversations WHERE tenantId = ?)`. |
| `getAllRagChunksWithEmbedding` — full table scan | Install pgvector, use `<=>` operator for nearest-neighbor search |
| ~~`getMessagesByConversation` — no pagination~~ | ✅ FIXED — `getMessagesByConversationPaginated(conversationId, cursor?, limit?)` added to `IStorage` + `DatabaseStorage`. `GET /api/conversations/:id/messages?cursor=&limit=` returns `{ messages, nextCursor }`. Existing callers unchanged. |
| Missing indexes | Add composite indexes on `(tenantId, status)` for conversations, `(tenantId, customerId)` for customer_memory |

---

## Section 6: Testing

### 6.1 Current Test Coverage

**Total test files:** 50 (49 TypeScript + 1 Python)

| Area | Test Files | Coverage |
|------|-----------|----------|
| Decision Engine | `decision-engine.test.ts`, `decision-engine-e2e.test.ts` | Core AI logic well-tested |
| RAG | `rag-indexer.test.ts`, `rag-retrieval.test.ts`, `rag-integration.test.ts`, `rag-cleanup.test.ts` | Good coverage |
| Few-shot | `few-shot-builder.test.ts` | ✅ |
| Embeddings | `embedding-service.test.ts` | ✅ |
| RBAC | `rbac.test.ts`, `permission-403.test.ts` | ✅ |
| Rate limiting | `rate-limiter.test.ts` | ✅ |
| Webhook security | `webhook-security.test.ts`, `webhook-security.integration.test.ts` | ✅ |
| Validation | `validation.test.ts` | ✅ |
| Human delay | `human-delay-engine.test.ts`, `human-delay-integration.test.ts` | ✅ |
| Customer operations | `customer-memory.test.ts`, `customer-summary-service.test.ts`, `customer-card-phase4.test.ts`, `customer-data-deletion.test.ts` | Good |
| Analytics | `conversion.test.ts`, `csat.test.ts`, `intent-analytics.test.ts`, `lost-deals.test.ts`, `learning-score.test.ts` | ✅ |
| Channel adapters | `telegram-adapter.test.ts`, `whatsapp-adapter.test.ts`, `max-adapter.test.ts` | Basic only |
| Onboarding | `onboarding.test.ts`, `onboarding-templates.test.ts` | ✅ |
| Subscription | `subscription-gating.test.ts`, `subscription-grants.test.ts` | ✅ |
| Training | `training-policies.test.ts` | ✅ |
| Admin | `admin-action-idempotency.test.ts`, `platform-owner.test.ts` | ✅ |
| Security | `sanitizer.test.ts`, `security-readiness.test.ts`, `integration-secrets.test.ts` | ✅ |

**Not tested:**

| Area | Risk |
|------|------|
| WebSocket server | No tests — unauthenticated access undetected |
| Multi-tenancy isolation | No cross-tenant access tests |
| Route authorization (end-to-end) | Only unit tests for RBAC middleware |
| Message send worker | No tests for stubs or actual sending |
| Vehicle/price lookup workers | No unit tests for worker logic |
| Telegram client manager | No tests for reconnection, multi-account |
| Billing flows (CryptoBot) | No tests for payment processing |
| Frontend components | Zero client-side tests |
| Database storage methods | No direct tests — tested indirectly via service tests |
| Error handler behavior | No test for the re-throw bug |

### 6.2 test_regression_iter4.py

- **What it tests:** End-to-end regression for the Podzamenu VIN/FRAME lookup service (`podzamenu_lookup_service.py`). Tests 48 VIN/FRAME lookups against a running instance at `localhost:8200`. Validates HTTP 200 responses, gearbox model detection, OEM extraction, and make identification. Iteration 3 targets have specific assertion checks (make, model, OEM).
- **Is it still relevant?** **Yes** — the Podzamenu service is actively used. This test ensures parsing logic continues to work against the external sites (podzamenu.ru, prof-rf). However, it requires a running Python service with Playwright + Chromium, making it unsuitable for CI without browser infrastructure. It's effectively a manual integration test.
- **Recommendation:** Keep as a manual regression suite. Add a mock-based unit test for the parsing logic that can run in CI.

### 6.3 Suggested Test Priorities

1. **CRITICAL:** Multi-tenancy isolation tests — verify users cannot access other tenants' data
2. **CRITICAL:** WebSocket authentication tests
3. **HIGH:** Message send worker integration tests
4. **HIGH:** End-to-end auth flow tests (login → session → protected route → logout)
5. **HIGH:** Error handler behavior test (verify no re-throw)
6. **MEDIUM:** Frontend component tests (at least critical flows: auth, chat, settings)
7. **MEDIUM:** Database storage method tests with real PostgreSQL (test container)
8. **MEDIUM:** Billing flow tests with CryptoBot API mocks
9. **LOW:** Telegram client manager reconnection tests

---

## Section 7: Documentation vs Reality

### 7.1 README.md

| Aspect | Status |
|--------|--------|
| Product description | ✅ Accurate |
| Features listed | ⚠️ Incomplete — only lists 7 features. Missing: RAG, few-shot learning, decision engine, RBAC, CSAT, analytics, onboarding, vehicle lookup, price lookup, admin panel, billing |
| WhatsApp channel | ❌ Not mentioned (but implemented) |
| MAX channel | ❌ Not mentioned (but implemented) |
| Multi-channel support | ❌ Not mentioned |
| Setup instructions | ⚠️ Only "copy .env and use PM2". No npm install, no database setup, no Redis, no Python services |
| Architecture diagram | ❌ Missing |
| Development setup | ❌ Missing — no `npm run dev` instructions |
| Docker instructions | ❌ Missing — Dockerfile exists but not documented |

### 7.2 AGENT_CAPABILITIES_AND_PLAN.md

| Aspect | Status |
|--------|--------|
| Feature inventory (Sections 1–4) | ✅ Very comprehensive and accurate. Matches actual implementation well |
| Vehicle lookup | ❌ Not documented (but fully implemented) |
| Price lookup | ❌ Not documented (but implemented with mock data) |
| Feature flags list | ✅ Accurate and matches `feature_flags.json` |
| Tech stack | ✅ Accurate |
| Language | Russian — may be inaccessible to English-speaking contributors |
| Development ideas (Section 5) | ✅ Good roadmap ideas, still relevant |

### 7.3 INTEGRATION_MAP_GEARBOX_OEM.md

| Aspect | Status |
|--------|--------|
| Message flow documentation | ✅ Extremely detailed and accurate |
| Decision Engine documentation | ✅ Accurate — matches `decision-engine.ts` |
| Schema documentation | ✅ Accurate — matches `shared/schema.ts` |
| Vehicle lookup documentation | ✅ Comprehensive, matches implementation |
| Price lookup documentation | ✅ Accurate — correctly notes mock-only status |
| Channel adapter architecture | ✅ Well-documented with correct file references |
| Storage methods | ✅ All methods listed match `database-storage.ts` |
| Missing items | ⚠️ Doesn't document the `gearbox-templates.ts` Russian template system |
| Status table (Section 7.7) | ✅ Honest about what's not implemented |

### 7.4 PLAN_PODZAMENU_LOOKUP.md

| Aspect | Status |
|--------|--------|
| Architecture plan | ✅ Followed almost exactly — BullMQ + Python Playwright service |
| File locations | ✅ Mostly accurate, actual filenames differ slightly (e.g., `vehicle-lookup-queue.ts` vs proposed `lookup-queue.ts`) |
| Step-by-step plan | ✅ All 10 steps were implemented |
| Rate limiting plan | ⚠️ Partially implemented — BullMQ concurrency exists, per-tenant rate limit not implemented |
| Cache table plan | ✅ Implemented as `vehicle_lookup_cache` |
| Case table plan | ✅ Implemented as `vehicle_lookup_cases` |
| PM2 worker plan | ⚠️ Workers run via npm scripts, not as separate PM2 apps as planned |
| Auto-trigger by VIN detection | ❌ Not implemented — lookup requires manual API call |

### 7.5 Additional Undocumented Features

The following significant features exist in code but are not documented in any file:

- Admin action service and idempotency
- Customer data deletion (GDPR)
- Fraud detection and channel fingerprinting
- Security readiness scoring
- Smoke test service
- Learning score and learning queue
- Document chunking service
- Proxy management
- System update service
- Owner dashboard and bootstrap
- Platform admin impersonation

---

## Section 8: Prioritized Action Plan

### Sprint 1 — Critical (do immediately, this week)

1. **Fix error handler re-throw** (CRIT-03) — Remove `throw err` from `server/index.ts:102`. Replace with `console.error(err)`. [5 minutes]
2. **Make SESSION_SECRET required in production** (CRIT-04) — Change config.ts to fail on startup without it. [15 minutes]
3. **Fix RBAC fallback to `"guest"` instead of `"operator"`** (CRIT-05) — Change `rbac.ts:96` from `return "operator"` to `return "guest"`. [5 minutes]
4. **Add WebSocket authentication** (CRIT-01) — Verify session cookie on upgrade. Validate tenantId matches session. [2–4 hours]
5. **Add tenant isolation on entity lookups** (CRIT-02) — Add `tenantId` check to all single-entity storage methods and routes. [4–8 hours]
6. **Fix routes using `getDefaultTenant()`** (CRIT-08) — Replace with `req.user.tenantId` everywhere. [2 hours]
7. **Add Zod validation to `PATCH /api/tenant`** (CRIT-06) — Whitelist allowed fields. [30 minutes]
8. ~~**Fix impersonation tenantId** (CRIT-09) — Add `session.tenantId = user.tenantId` to impersonation logic. [15 minutes]~~ ✅ DONE
9. ~~**Remove `--force` from production migrations** (CRIT-07) — Use reviewed migration files instead. [30 minutes]~~ ✅ DONE

### Sprint 2 — Important (this week / next week)

1. ~~**Move audit log to database** (DEBT-01, DEBT-02) — Use existing `auditEvents` table. Use AsyncLocalStorage for request context. [1 day]~~ ✅ DONE
2. ~~**Fix N+1 queries** (P1, P3) — Rewrite `getConversationsByTenant` and `getActiveConversations` with JOINs. Use COUNT(*) for dashboard. [4 hours]~~ ✅ DONE
3. ~~**Encrypt Telegram session strings** — Use existing `secret-store.ts` AES-256-GCM for `sessionString` field. [2 hours]~~ ✅ DONE
4. ~~**Add webhook verification enforcement** — Reject webhooks when secrets are not configured (don't silently skip). [1 hour]~~ ✅ DONE
5. ~~**Implement message worker stubs** (DEBT-08) — Add real validity checking and database status updates. [3 hours]~~ ✅ DONE
6. **Replace in-memory rate limiting with Redis** (ARCH-04) — Already have `ioredis` as dependency. [3 hours]
7. ~~**Delete `MemStorage` dead code** (DEBT-03) — [30 minutes]~~ ✅ DONE
8. ~~**Delete `server/replit_integrations/`** (DEBT-06) — [5 minutes]~~ ✅ DONE
9. **Move test/type packages to devDependencies** (DEBT-12, DEBT-13) — [15 minutes]
10. **Add Telegram FloodWait handling** — Exponential backoff in reconnect loop, detect `AuthKeyUnregisteredError`. [2 hours]

### Sprint 3 — Improvements (next iteration)

1. ~~**Split `routes.ts` into domain modules** (DEBT-04, ARCH-01) — Extract into 8–10 focused route files. [1–2 days]~~ ✅ DONE
2. **Split `settings.tsx` into tab components** (DEBT-11) — [4 hours]
3. **Add code splitting / lazy loading** — `React.lazy()` for route-based splitting. [2 hours]
4. **Install pgvector and migrate RAG to vector search** — Eliminate JS-side cosine similarity. [1 day]
5. **Add pagination to `getMessagesByConversation`** — [2 hours]
6. **Implement graceful shutdown** (ARCH-05) — [3 hours]
7. **Remove fake random similarity scores** from decision engine RAG fallback. [30 minutes]
8. **Add auth state cleanup timer** for Telegram adapter (10-minute TTL). [1 hour]
9. **Disable full response body logging** — Log status + response size only. [30 minutes]
10. **Implement real email provider** (DEBT-07) — [4 hours]

### Sprint 4 — Nice to Have

1. **Add frontend tests** — Start with auth flow, conversation list, chat interface. [2–3 days]
2. **Add multi-tenancy integration tests** — Verify cross-tenant access is blocked. [1 day]
3. **Introduce service layer** (ARCH-06) — Start with ConversationService, CustomerService. [2–3 days]
4. **Replace `as any` casts with proper types** (DEBT-05) — Extend Express Request consistently. [1 day]
5. **Add CSRF tokens** — For session-based auth. [3 hours]
6. **Add explicit CORS configuration** — For future multi-domain deployments. [1 hour]
7. **Implement real price sources** — Replace mock prices with Avito/Exist scrapers. [2–3 days]
8. **Add database connection pool tuning** — Configure max connections, idle timeouts. [1 hour]
9. **Extract hardcoded business constants** (DEBT-09) — Move to tenant config or database. [3 hours]
10. **Update README.md** — Add comprehensive setup, architecture diagram, all features. [2 hours]
11. **Translate AGENT_CAPABILITIES_AND_PLAN.md to English** — Or maintain bilingual docs. [2 hours]
12. **Add auto-VIN detection in messages** — Trigger vehicle lookup from inbound messages automatically. [1 day]

---

*End of audit. Total critical issues: 9. Total items identified: 60+.*
*Estimated effort for Sprint 1 (critical fixes): 1–2 developer-days.*

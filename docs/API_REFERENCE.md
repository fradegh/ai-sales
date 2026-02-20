# API Reference

## Table of Contents

- [Authentication](#authentication)
- [Middleware](#middleware)
- [RBAC — Role-Based Access Control](#rbac--role-based-access-control)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Health & Metrics](#health--metrics)
  - [Auth](#auth)
  - [Tenant](#tenant)
  - [Onboarding](#onboarding)
  - [Customers](#customers)
  - [Conversations](#conversations)
  - [AI Suggestions](#ai-suggestions)
  - [Settings](#settings)
  - [Products](#products)
  - [Knowledge Base](#knowledge-base)
  - [Escalations](#escalations)
  - [Analytics & Dashboard](#analytics--dashboard)
  - [CSAT](#csat)
  - [Conversions](#conversions)
  - [Lost Deals](#lost-deals)
  - [Vehicle & Price Lookup](#vehicle--price-lookup)
  - [Channel Management](#channel-management)
  - [Telegram Personal](#telegram-personal)
  - [WhatsApp Personal](#whatsapp-personal)
  - [Max Personal](#max-personal)
  - [Billing](#billing)
  - [Feature Flags](#feature-flags)
  - [Audit Events](#audit-events)
  - [Admin — RAG & Training](#admin--rag--training)
  - [Platform Admin](#platform-admin)
- [Webhooks](#webhooks)
  - [Telegram Webhook](#telegram-webhook)
  - [WhatsApp Webhook](#whatsapp-webhook)
  - [Max Webhook](#max-webhook)
  - [CryptoBot Webhook](#cryptobot-webhook)
- [WebSocket Events](#websocket-events)
- [Environment Variables](#environment-variables)

---

## Authentication

**Type:** Session-based (Express sessions backed by PostgreSQL via `connect-pg-simple`)

| Property | Value |
|----------|-------|
| Store | PostgreSQL (`sessions` table) |
| TTL | 7 days |
| Cookie flags | `HttpOnly`, `Secure` (production), `SameSite=Lax` |
| Secret | `SESSION_SECRET` env var (min 32 chars) |

### Token Flow

1. **Login / Signup** — on success, a session cookie is set containing `userId`, `tenantId`, and `role`.
2. **Verification** — `requireAuth` middleware reads `req.session.userId` and loads the full user from the database.
3. **Refresh** — sessions auto-extend on activity up to the TTL.
4. **Destruction** — explicit logout destroys the session; otherwise it expires after TTL.

### Password Security

| Rule | Value |
|------|-------|
| Hashing algorithm | bcrypt, 12 salt rounds |
| Minimum length | 8 characters |
| Complexity | Uppercase + lowercase + number required |
| Account lockout | 5 failed attempts → 15-minute lockout |
| Anti-enumeration | Same error message for invalid email and invalid password |

### Development Mode

In non-production environments, the following debug headers are accepted:

- `X-Debug-Role` — override the user role
- `X-Debug-User-Id` — override the authenticated user ID

---

## Middleware

### Global Middleware (applied to all requests)

| Middleware | Description |
|-----------|-------------|
| `express.json()` | Parse JSON request bodies |
| `express.urlencoded()` | Parse URL-encoded bodies |
| `requestContextMiddleware` | Adds `req.requestId` (from `X-Request-Id` header or generated UUID); sets `X-Request-Id` response header |
| `apiRateLimiter` | Global rate limit on `/api/*` — 100 req/min (prod), 500 req/min (dev) |
| Session middleware | Initializes `express-session` with PostgreSQL store |

### Auth & Authorization Middleware

| Middleware | Description |
|-----------|-------------|
| `requireAuth` | Requires authenticated session (`req.session.userId`). Sets `req.userId`, `req.userRole`, `req.user`. |
| `requirePermission(perm)` | Checks user has a specific RBAC permission. Returns 403 if denied. |
| `requireRole(roles)` | Requires one of the specified roles. Shorthands: `requireAdmin`, `requireOperator`, `requireViewer`, `requireOwner`. |
| `requirePlatformAdmin()` | Requires `isPlatformAdmin` flag on user. Returns 403 otherwise. |
| `requirePlatformOwner()` | Requires `isPlatformOwner` flag on user. Returns 403 otherwise. |
| `requireActiveSubscription` | Checks tenant has active subscription or grant. Returns 402 otherwise. |
| `requireActiveTenant` | Checks tenant status is not `restricted`. Returns 403 otherwise. |

### Validation Middleware

| Middleware | Description |
|-----------|-------------|
| `validateBody(schema)` | Validates `req.body` against a Zod schema |
| `validateQuery(schema)` | Validates `req.query` against a Zod schema |
| `validateParams(schema)` | Validates `req.params` against a Zod schema |
| `checkBodySize(maxSize)` | Validates `Content-Length` header does not exceed `maxSize` |

### Webhook Security Middleware

| Middleware | Description |
|-----------|-------------|
| `telegramWebhookSecurity` | Verifies `X-Telegram-Bot-Api-Secret-Token` header |
| `whatsappWebhookSecurity` | Verifies `X-Hub-Signature-256` header (HMAC-SHA256 with `WHATSAPP_APP_SECRET`) |
| `maxWebhookSecurity` | Verifies `X-Max-Bot-Api-Secret` header; optionally verifies `X-Max-Signature` (HMAC-SHA256) |

### Utility Middleware

| Middleware | Description |
|-----------|-------------|
| `auditAdminAction(action)` | Logs platform admin actions to the audit log |

---

## RBAC — Role-Based Access Control

**Roles:** `owner` · `admin` · `operator` · `viewer` · `guest`

| Permission | owner | admin | operator | viewer | guest |
|------------|:-----:|:-----:|:--------:|:------:|:-----:|
| `VIEW_CONVERSATIONS` | ✓ | ✓ | ✓ | ✓ | |
| `MANAGE_CONVERSATIONS` | ✓ | ✓ | ✓ | | |
| `VIEW_CUSTOMERS` | ✓ | ✓ | ✓ | ✓ | |
| `MANAGE_CUSTOMERS` | ✓ | ✓ | ✓ | | |
| `DELETE_CUSTOMER_DATA` | ✓ | ✓ | | | |
| `VIEW_ANALYTICS` | ✓ | ✓ | ✓ | | |
| `MANAGE_PRODUCTS` | ✓ | ✓ | ✓ | | |
| `MANAGE_KNOWLEDGE_BASE` | ✓ | ✓ | ✓ | | |
| `MANAGE_AUTOSEND` | ✓ | ✓ | | | |
| `MANAGE_POLICIES` | ✓ | ✓ | | | |
| `MANAGE_TRAINING` | ✓ | ✓ | | | |
| `EXPORT_TRAINING_DATA` | ✓ | ✓ | | | |
| `MANAGE_CHANNELS` | ✓ | ✓ | | | |
| `MANAGE_TENANT_SETTINGS` | ✓ | ✓ | | | |
| `MANAGE_USERS` | ✓ | | | | |
| `VIEW_AUDIT_LOGS` | ✓ | ✓ | | | |

---

## Rate Limiting

| Limiter | Scope | Production | Development |
|---------|-------|-----------|-------------|
| `apiRateLimiter` | `/api/*` | 100 req/min | 500 req/min |
| `aiRateLimiter` | AI generation endpoints | 20 req/min | 100 req/min |
| `webhookRateLimiter` | Webhook endpoints | 500 req/min | 500 req/min |
| `onboardingRateLimiter` | Onboarding endpoints | 30 req/min | 100 req/min |
| `conversationRateLimiter` | Message sending | 100 req/min | 300 req/min |
| `tenantConversationLimiter` | Per-tenant message sending | 50 req/min (default) | — |
| `tenantAiLimiter` | Per-tenant AI generation | 30 req/min (default) | — |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## Endpoints

### Health & Metrics

#### GET `/health`

Returns basic health status.

- **Auth:** None
- **Response 200:**

```json
{ "status": "healthy", "timestamp": "2026-02-20T12:00:00.000Z" }
```

#### GET `/ready`

Detailed readiness check (storage, OpenAI, memory).

- **Auth:** None
- **Response 200:** Readiness object (all checks pass)
- **Response 503:** One or more checks failed

#### GET `/metrics`

System metrics (uptime, memory, customer memory counts).

- **Auth:** None
- **Response 200:** Metrics object

---

### Auth

#### POST `/auth/signup`

Create a new account and tenant (or join existing via invite).

- **Auth:** None
- **Rate Limit:** 3 per hour
- **Request Body:**

```json
{
  "email": "string",
  "password": "string",
  "username": "string (optional)",
  "inviteToken": "string (optional)"
}
```

- **Response 201:**

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "string",
    "username": "string",
    "role": "owner | admin | operator | viewer",
    "tenantId": "uuid"
  }
}
```

- **Response 200 (anti-enumeration):** `{ "success": false, "message": "string", "hint": "login_or_reset" }`
- **Response 400:** Invalid invite, expired invite, weak password
- **Response 409:** Username already exists

#### POST `/auth/login`

Authenticate with email and password.

- **Auth:** None
- **Rate Limit:** 5 per 15 minutes
- **Request Body:**

```json
{ "email": "string", "password": "string" }
```

- **Response 200:**

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "string",
    "username": "string",
    "role": "string",
    "tenantId": "uuid"
  }
}
```

- **Response 401:** Invalid credentials
- **Response 423:** Account locked (too many failed attempts)

#### POST `/auth/logout`

Destroy the session.

- **Auth:** None
- **Response 200:** `{ "success": true }`

#### GET `/auth/me`

Get current session state.

- **Auth:** None (reads session if present)
- **Response 200:**

```json
{
  "authenticated": true,
  "user": { "id": "uuid", "email": "string", "username": "string", "role": "string" },
  "tenantId": "uuid",
  "role": "string"
}
```

#### POST `/auth/invite`

Send a team invite.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_USERS")`
- **Request Body:**

```json
{ "email": "string", "role": "admin | operator | viewer" }
```

- **Response 201:**

```json
{ "success": true, "inviteLink": "string", "expiresAt": "ISO datetime" }
```

#### POST `/auth/send-verification`

Send email verification link.

- **Auth:** `requireAuth`
- **Response 200:** `{ "success": true, "message": "string" }`

#### POST `/auth/verify-email`

Verify email with token.

- **Auth:** None
- **Request Body:** `{ "token": "string" }`
- **Response 200:** `{ "success": true, "message": "string" }`
- **Response 400:** Invalid/used/expired token

#### POST `/auth/forgot-password`

Request a password reset.

- **Auth:** None
- **Rate Limit:** 5 per 15 minutes
- **Request Body:** `{ "email": "string" }`
- **Response 200:** Always returns success (anti-enumeration)

#### POST `/auth/reset-password`

Reset password with token.

- **Auth:** None
- **Request Body:** `{ "token": "string", "password": "string" }`
- **Response 200:** `{ "success": true, "message": "string" }`
- **Response 400:** Invalid/used/expired token, weak password

#### GET `/api/auth/user`

Get authenticated user details.

- **Auth:** Session required
- **Response 200:**

```json
{
  "id": "uuid",
  "username": "string",
  "email": "string",
  "role": "string",
  "tenantId": "uuid",
  "authProvider": "local | oidc | mixed",
  "isPlatformAdmin": false,
  "isPlatformOwner": false
}
```

- **Response 401:** Unauthorized

---

### Tenant

#### GET `/api/tenant`

Get current tenant.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** Tenant object

#### PATCH `/api/tenant`

Update tenant settings.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:** Partial tenant update
- **Response 200:** Updated tenant object

#### POST `/api/onboarding/setup`

Initial tenant setup (business profile).

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:**

```json
{
  "name": "string",
  "language": "string",
  "tone": "formal | friendly",
  "addressStyle": "vy | ty",
  "currency": "string",
  "timezone": "string",
  "workingHoursStart": "HH:mm",
  "workingHoursEnd": "HH:mm",
  "autoReplyOutsideHours": true,
  "escalationEmail": "string (optional)",
  "allowDiscounts": false,
  "maxDiscountPercent": 0,
  "deliveryOptions": "string (optional)",
  "returnPolicy": "string (optional)"
}
```

- **Response 200:** Tenant object

---

### Onboarding

#### GET `/api/onboarding/state`

Get current onboarding progress.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:**

```json
{
  "tenantId": "uuid",
  "status": "NOT_STARTED | IN_PROGRESS | DONE",
  "currentStep": "BUSINESS | CHANNELS | PRODUCTS | POLICIES | KB | REVIEW | DONE",
  "completedSteps": ["BUSINESS", "CHANNELS"],
  "answers": {},
  "steps": ["BUSINESS", "CHANNELS", "PRODUCTS", "POLICIES", "KB", "REVIEW", "DONE"],
  "totalSteps": 7
}
```

#### PUT `/api/onboarding/state`

Overwrite onboarding state.

- **Auth:** `requireAuth`
- **Request Body:**

```json
{
  "status": "string (optional)",
  "currentStep": "string (optional)",
  "completedSteps": ["string"] ,
  "answers": {}
}
```

- **Response 200:** Updated state

#### POST `/api/onboarding/complete-step`

Mark a step complete and advance.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:** `{ "step": "string", "answers": {} }`
- **Response 200:** `{ ...state, "completedStep": "string", "nextStep": "string" }`

#### POST `/api/onboarding/generate-templates`

Generate knowledge base drafts from onboarding answers.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Rate Limit:** `onboardingRateLimiter`
- **Request Body:**

```json
{
  "options": {},
  "answers": {
    "BUSINESS": { ... },
    "POLICIES": { ... }
  }
}
```

- **Response 200:** `{ "drafts": [{ "title": "string", "content": "string", "docType": "string" }] }`

#### POST `/api/onboarding/apply-templates`

Apply generated templates to the knowledge base.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:** `{ "drafts": [{ "title": "string", "content": "string", "docType": "string" }] }`
- **Response 200:** `{ "success": true, "createdDocs": 3, "ragEnabled": true, "documents": [...] }`

#### GET `/api/onboarding/readiness`

Check if tenant is ready for production.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:**

```json
{
  "score": 85,
  "checks": [
    { "code": "PRODUCTS_PRESENT", "status": "PASS", "message": "string", "weight": 20 }
  ],
  "recommendations": ["string"],
  "threshold": 70,
  "ready": true
}
```

#### GET `/api/onboarding/run-smoke-test/stream`

Run smoke test with SSE progress stream.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Rate Limit:** `onboardingRateLimiter`
- **Response:** `text/event-stream`

```
data: { "type": "progress", ... }
data: { "type": "complete", ... }
data: { "type": "error", ... }
```

#### POST `/api/onboarding/run-smoke-test`

Run smoke test (non-streaming).

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Rate Limit:** `onboardingRateLimiter`
- **Response 200:**

```json
{
  "results": [...],
  "passedCount": 3,
  "totalCount": 5,
  "check": { ... },
  "recommendations": [...]
}
```

---

### Customers

#### GET `/api/customers`

List customers for the tenant.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CUSTOMERS")`
- **Query:** `?search=string` (optional)
- **Response 200:** `Customer[]`

#### GET `/api/customers/:id`

Get a single customer.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CUSTOMERS")`
- **Response 200:** Customer object
- **Response 404:** Not found

#### PATCH `/api/customers/:id`

Update customer profile.

- **Auth:** `requireAuth`, `requireOperator`
- **Request Body:**

```json
{
  "name": "string (optional)",
  "email": "string | null (optional)",
  "phone": "string | null (optional)",
  "tags": ["string"] 
}
```

- **Response 200:** Updated customer

#### GET `/api/customers/:id/notes`

List notes for a customer.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CUSTOMERS")`
- **Response 200:** `CustomerNote[]`

#### POST `/api/customers/:id/notes`

Add a note to a customer.

- **Auth:** `requireAuth`, `requireOperator`
- **Request Body:** `{ "noteText": "string (max 2048)" }`
- **Response 201:** Created note

#### DELETE `/api/customers/:id/notes/:noteId`

Delete a customer note. Only the author or an admin can delete.

- **Auth:** `requireAuth`, `requireOperator`
- **Response 200:** `{ "success": true }`

#### DELETE `/api/customers/:id/data`

GDPR data deletion.

- **Auth:** `requireAuth`, `requirePermission("DELETE_CUSTOMER_DATA")`
- **Response 200:** `{ "deletedMessages": 5, "deletedConversations": 2, ... }`

#### GET `/api/customers/:id/memory`

Get customer memory (preferences, topics, summary).

- **Auth:** `requireAuth`, `requirePermission("VIEW_CUSTOMERS")`
- **Response 200:**

```json
{
  "customerId": "uuid",
  "tenantId": "uuid",
  "preferences": {},
  "frequentTopics": {},
  "lastSummaryText": "string | null"
}
```

#### PATCH `/api/customers/:id/memory`

Update customer memory.

- **Auth:** `requireAuth`, `requireOperator`
- **Request Body:** `{ "preferences": {}, "lastSummaryText": "string" }`
- **Response 200:** Updated memory

#### POST `/api/customers/:id/memory/rebuild-summary`

Rebuild the AI-generated customer summary from conversation history.

- **Auth:** `requireAuth`, `requireAdmin`
- **Response 200:** `{ "success": true, "summary": "string", "memory": { ... } }`

---

### Conversations

#### GET `/api/conversations`

List conversations.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Query:** `?status=active` (optional)
- **Response 200:** `ConversationWithCustomer[]`

#### GET `/api/conversations/:id`

Get conversation detail with messages.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `ConversationDetail` (conversation + customer + messages + current suggestion)
- **Response 403:** Tenant mismatch

#### PATCH `/api/conversations/:id`

Update conversation status or mode.

- **Auth:** `requireAuth`, `requireOperator`
- **Request Body:**

```json
{
  "status": "active | waiting_customer | waiting_operator | escalated | resolved",
  "mode": "learning | semi-auto | auto"
}
```

- **Response 200:** Updated conversation

#### POST `/api/conversations/:id/read`

Mark conversation as read.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `{ "success": true }`

#### POST `/api/conversations/:id/messages`

Send a message in a conversation. Delivers via the appropriate channel adapter.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Rate Limit:** `conversationRateLimiter`, `tenantConversationLimiter`
- **Request Body:**

```json
{
  "content": "string",
  "role": "owner | customer | assistant (optional)"
}
```

- **Response 201:** Created message

---

### AI Suggestions

#### POST `/api/conversations/:id/generate-suggestion`

Generate an AI reply suggestion for the latest customer message.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Rate Limit:** `aiRateLimiter`, `tenantAiLimiter`
- **Response 201:**

```json
{
  "suggestionId": "uuid",
  "replyText": "string",
  "intent": "price | availability | shipping | return | discount | complaint | other | null",
  "confidence": {
    "total": 0.85,
    "similarity": 0.90,
    "intent": 0.80,
    "selfCheck": 0.85
  },
  "decision": "AUTO_SEND | NEED_APPROVAL | ESCALATE",
  "explanations": ["string"],
  "penalties": [{ "code": "string", "message": "string", "value": -0.25 }],
  "missingFields": ["string"],
  "usedSources": [{ "type": "product | doc", "id": "uuid", "title": "string", "quote": "string", "similarity": 0.92 }],
  "sourceConflicts": false,
  "autosendEligible": false,
  "autosendBlockReason": "FLAG_OFF | SETTING_OFF | INTENT_NOT_ALLOWED | null",
  "selfCheckNeedHandoff": false,
  "selfCheckReasons": []
}
```

#### POST `/api/suggestions/:id/approve`

Approve an AI suggestion and send it.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Response 200:**

```json
{
  "suggestion": { ... },
  "message": { ... },
  "delayResult": { ... },
  "scheduledJob": { ... },
  "sentImmediately": true,
  "channelSendResult": { ... }
}
```

#### POST `/api/suggestions/:id/edit`

Edit a suggestion before sending.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "editedText": "string" }`
- **Response 200:** Same shape as approve

#### POST `/api/suggestions/:id/reject`

Reject an AI suggestion.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "reason": "string (optional)" }`
- **Response 200:** `{ "success": true }`

#### POST `/api/suggestions/:id/escalate`

Escalate a suggestion to a human operator.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Response 200:** `{ "escalation": { ... } }`

---

### Settings

#### GET `/api/settings/decision`

Get decision engine thresholds.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:**

```json
{
  "tenantId": "uuid",
  "tAuto": 0.80,
  "tEscalate": 0.40,
  "autosendAllowed": false,
  "intentsAutosendAllowed": ["price", "availability", "shipping", "other"],
  "intentsForceHandoff": ["discount", "complaint"]
}
```

#### PATCH `/api/settings/decision`

Update decision engine settings.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_AUTOSEND")`
- **Request Body:**

```json
{
  "tAuto": 0.85,
  "tEscalate": 0.35,
  "autosendAllowed": true,
  "intentsAutosendAllowed": ["price", "availability"],
  "intentsForceHandoff": ["complaint"]
}
```

- **Response 200:** Updated settings
- **Response 409:** Readiness score too low for autosend

#### GET `/api/settings/human-delay`

Get human delay simulation settings.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `HumanDelaySettings`

#### PATCH `/api/settings/human-delay`

Update human delay settings.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_AUTOSEND")`
- **Request Body:**

```json
{
  "enabled": true,
  "delayProfiles": {
    "SHORT":  { "baseMin": 2000, "baseMax": 4000, "typingSpeed": 40, "jitter": 500 },
    "MEDIUM": { "baseMin": 4000, "baseMax": 8000, "typingSpeed": 35, "jitter": 1000 },
    "LONG":   { "baseMin": 8000, "baseMax": 15000, "typingSpeed": 30, "jitter": 2000 }
  },
  "nightMode": "AUTO_REPLY | DELAY | DISABLE",
  "nightDelayMultiplier": 3.0,
  "nightAutoReplyText": "string",
  "minDelayMs": 3000,
  "maxDelayMs": 120000,
  "typingIndicatorEnabled": true
}
```

- **Response 200:** Updated settings

---

### Products

#### GET `/api/products`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_PRODUCTS")`
- **Response 200:** `Product[]`

#### POST `/api/products`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_PRODUCTS")`
- **Request Body:**

```json
{
  "name": "string",
  "description": "string (optional)",
  "sku": "string (optional)",
  "price": 1500.00,
  "currency": "RUB",
  "inStock": true,
  "category": "string (optional)",
  "imageUrl": "string (optional)",
  "metadata": {}
}
```

- **Response 201:** Created product

#### PATCH `/api/products/:id`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_PRODUCTS")`
- **Request Body:** Partial product update
- **Response 200:** Updated product

#### DELETE `/api/products/:id`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_PRODUCTS")`
- **Response 204:** No content

#### POST `/api/products/import`

Bulk import products.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_PRODUCTS")`
- **Request Body:**

```json
{
  "products": [
    { "name": "string", "sku": "string", "description": "string", "price": 100, "category": "string", "inStock": true, "stockQuantity": 10 }
  ]
}
```

- **Response 200:** `{ "count": 5, "message": "string" }`

---

### Knowledge Base

#### GET `/api/knowledge-docs`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Response 200:** `KnowledgeDoc[]`

#### POST `/api/knowledge-docs`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Request Body:**

```json
{
  "title": "string",
  "content": "string (max 50000)",
  "category": "faq | policy | shipping | returns | general (optional)",
  "tags": ["string"]
}
```

- **Response 201:** Created document

#### PATCH `/api/knowledge-docs/:id`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Request Body:** Partial document update
- **Response 200:** Updated document

#### DELETE `/api/knowledge-docs/:id`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Response 204:** No content

---

### Escalations

#### GET `/api/escalations`

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Query:** `?status=recent | pending`
- **Response 200:** `EscalationEvent[]`

#### PATCH `/api/escalations/:id`

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "status": "pending | handled | dismissed" }`
- **Response 200:** Updated escalation

---

### Analytics & Dashboard

#### GET `/api/dashboard/metrics`

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Response 200:**

```json
{
  "totalConversations": 120,
  "activeConversations": 15,
  "escalatedConversations": 3,
  "resolvedToday": 8,
  "avgResponseTime": 45000,
  "aiAccuracy": 0.87,
  "pendingSuggestions": 2,
  "productsCount": 50,
  "knowledgeDocsCount": 12
}
```

#### GET `/api/analytics/intents`

Intent performance analytics.

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Response 200:**

```json
{
  "intents": [
    {
      "intent": "price",
      "totalConversations": 40,
      "autosendRate": 0.75,
      "escalationRate": 0.05,
      "avgConfidence": 0.88,
      "csatAvg": 4.2,
      "conversionRate": 0.30,
      "lostDealRate": 0.10,
      "status": "good | warning | critical",
      "recommendation": "string"
    }
  ],
  "totalConversations": 120,
  "totalIntents": 7
}
```

#### GET `/api/analytics/lost-deals`

Lost deal analytics.

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Response 200:**

```json
{
  "totalLostDeals": 15,
  "byReason": [{ "reason": "PRICE_TOO_HIGH", "count": 8, "percentage": 53.3 }],
  "byIntent": [{ "intent": "price", "count": 6, "percentage": 40.0 }],
  "timeline": [{ "date": "2026-02-20", "count": 2 }]
}
```

---

### CSAT

#### POST `/api/conversations/:id/csat`

Submit a CSAT rating.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "rating": 4, "comment": "string (optional)" }`
- **Validation:** `rating` must be integer 1–5
- **Response 200:** `{ "success": true }`

#### GET `/api/conversations/:id/csat`

Get CSAT for a conversation.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `{ "submitted": true, "rating": 4 }`

#### GET `/api/analytics/csat`

Aggregate CSAT analytics.

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Response 200:**

```json
{
  "avgScore": 4.1,
  "totalRatings": 85,
  "distribution": [{ "rating": 5, "count": 40, "percentage": 47.0 }],
  "byIntent": [{ "key": "price", "avgScore": 4.3, "count": 30 }],
  "byDecision": [{ "key": "AUTO_SEND", "avgScore": 4.5, "count": 50 }],
  "problemIntents": [{ "key": "complaint", "avgScore": 2.8, "count": 10 }]
}
```

---

### Conversions

#### POST `/api/conversations/:id/conversion`

Record a conversion (sale).

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "amount": 15000, "currency": "RUB (optional)" }`
- **Validation:** `amount` must be positive
- **Response 200:** `{ "success": true, "conversion": { ... } }`

#### GET `/api/conversations/:id/conversion`

Get conversion data for a conversation.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `{ "hasConversion": true, "amount": 15000, "currency": "RUB" }`

#### GET `/api/analytics/conversion`

Aggregate conversion analytics.

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Response 200:**

```json
{
  "conversionRate": 25.0,
  "totalConversations": 120,
  "totalConversions": 30,
  "totalRevenue": 450000,
  "avgAmount": 15000,
  "currency": "RUB",
  "byIntent": [{ "key": "price", "count": 15, "totalRevenue": 225000, "avgAmount": 15000 }],
  "byDecision": [{ "key": "AUTO_SEND", "count": 20, "totalRevenue": 300000, "avgAmount": 15000 }],
  "topIntentsByRevenue": [],
  "avgTimeToConversion": 2.5
}
```

---

### Lost Deals

#### POST `/api/lost-deals`

Record a lost deal.

- **Auth:** `requireAuth`, `requirePermission("VIEW_ANALYTICS")`
- **Request Body:**

```json
{
  "conversationId": "uuid",
  "reason": "NO_STOCK | PRICE_TOO_HIGH | ESCALATED_NO_RESPONSE | AI_ERROR | OTHER",
  "notes": "string (optional)"
}
```

- **Response 201:** Lost deal object
- **Response 409:** Already recorded for this conversation

---

### Vehicle & Price Lookup

#### POST `/api/conversations/:id/vehicle-lookup-case`

Start a vehicle lookup by VIN or FRAME number.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "idType": "VIN | FRAME", "value": "string" }`
- **Response 201:** `{ "caseId": "uuid" }`

#### GET `/api/price-settings`

Get price display settings.

- **Auth:** `requireAuth`
- **Response 200:**

```json
{
  "marginPct": 15,
  "roundTo": 100,
  "priceNote": "string",
  "showMarketPrice": true
}
```

#### PUT `/api/price-settings`

Update price display settings.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:**

```json
{
  "marginPct": 15,
  "roundTo": 1 | 10 | 100 | 1000,
  "priceNote": "string (max 200)",
  "showMarketPrice": true
}
```

- **Validation:** `marginPct` range: -50 to 50
- **Response 200:** Updated settings

#### POST `/api/conversations/:id/price-lookup`

Trigger a price lookup for the latest vehicle in the conversation.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Request Body:** `{ "oem": "string (optional)" }`
- **Response 200:** `{ "jobId": "uuid", "oem": "string" }`

#### GET `/api/conversations/:id/price-history`

Get price history snapshots for a conversation.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CONVERSATIONS")`
- **Response 200:** `{ "snapshots": [...], "oem": "string | null" }`

---

### Channel Management

#### GET `/api/channels/status`

Get all channel connection statuses.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:**

```json
[
  {
    "channel": "telegram",
    "enabled": true,
    "connected": true,
    "lastError": null,
    "botInfo": { "username": "my_bot" },
    "accountCount": 2
  }
]
```

#### GET `/api/channels/feature-flags`

Get channel feature flags.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:**

```json
{
  "MAX_CHANNEL_ENABLED": true,
  "MAX_PERSONAL_CHANNEL_ENABLED": false,
  "TELEGRAM_CHANNEL_ENABLED": true,
  "TELEGRAM_PERSONAL_CHANNEL_ENABLED": true,
  "WHATSAPP_CHANNEL_ENABLED": false,
  "WHATSAPP_PERSONAL_CHANNEL_ENABLED": false
}
```

#### POST `/api/channels/:channel/toggle`

Enable or disable a channel.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`, `requireActiveTenant`
- **Params:** `channel` = `max` | `max_personal` | `telegram` | `telegram_personal` | `whatsapp` | `whatsapp_personal`
- **Request Body:** `{ "enabled": true }`
- **Response 200:** `{ "success": true, "channel": "telegram", "enabled": true }`

#### POST `/api/channels/:channel/config`

Set channel credentials.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`, `requireActiveTenant`
- **Request Body:**

```json
{
  "token": "string",
  "webhookSecret": "string",
  "accessToken": "string",
  "phoneNumberId": "string",
  "verifyToken": "string",
  "appSecret": "string"
}
```

- **Response 200:** `{ "success": true, "message": "string" }`

#### POST `/api/channels/:channel/test`

Test channel connection.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Request Body:** `{ "token": "string (optional)" }`
- **Response 200:** Connection test result

---

### Telegram Personal

#### GET `/api/telegram-personal/accounts`

List all Telegram personal accounts for the tenant.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:**

```json
{
  "accounts": [{
    "id": "uuid",
    "phoneNumber": "string",
    "firstName": "string",
    "lastName": "string",
    "username": "string",
    "userId": "string",
    "status": "pending | awaiting_code | awaiting_2fa | active | error | disconnected",
    "authMethod": "qr | phone",
    "isEnabled": true,
    "isConnected": true,
    "createdAt": "ISO datetime"
  }]
}
```

#### POST `/api/telegram-personal/accounts/send-code`

Start phone-based Telegram auth. Max 5 accounts per tenant.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`, `requireActiveTenant`
- **Request Body:** `{ "phoneNumber": "string" }`
- **Response 200:** `{ "success": true, "accountId": "uuid", "sessionId": "string" }`

#### POST `/api/telegram-personal/accounts/verify-code`

Verify the SMS code.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`
- **Request Body:** `{ "accountId": "uuid", "sessionId": "string", "phoneNumber": "string", "code": "string" }`
- **Response 200 (success):** `{ "success": true, "user": { ... } }`
- **Response 200 (2FA required):** `{ "success": false, "needs2FA": true, "sessionId": "string", "accountId": "uuid" }`

#### POST `/api/telegram-personal/accounts/verify-password`

Provide 2FA password.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`
- **Request Body:** `{ "accountId": "uuid", "sessionId": "string", "password": "string" }`
- **Response 200:** `{ "success": true, "user": { ... } }`

#### POST `/api/telegram-personal/accounts/start-qr`

Start QR-code-based Telegram auth.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`, `requireActiveTenant`
- **Response 200:**

```json
{
  "success": true,
  "accountId": "uuid",
  "sessionId": "string",
  "qrImageDataUrl": "data:image/png;base64,...",
  "qrUrl": "tg://login?token=...",
  "expiresAt": "ISO datetime"
}
```

#### POST `/api/telegram-personal/accounts/check-qr`

Poll QR auth status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Request Body:** `{ "sessionId": "string", "accountId": "uuid" }`
- **Response 200:** `{ "status": "authorized | pending | expired | needs_2fa", ... }`

#### POST `/api/telegram-personal/accounts/verify-qr-2fa`

Provide 2FA password during QR auth.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Request Body:** `{ "sessionId": "string", "accountId": "uuid", "password": "string" }`
- **Response 200:** `{ "success": true, "user": { ... } }`

#### POST `/api/telegram-personal/accounts/cancel-auth`

Cancel an in-progress auth flow.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Request Body:** `{ "sessionId": "string (optional)", "accountId": "uuid (optional)" }`
- **Response 200:** `{ "success": true }`

#### DELETE `/api/telegram-personal/accounts/:id`

Remove a Telegram personal account.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "success": true }`

#### PATCH `/api/telegram-personal/accounts/:id`

Enable/disable an account.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Request Body:** `{ "isEnabled": true }`
- **Response 200:** `{ "success": true, "account": { ... } }`

#### POST `/api/telegram-personal/start-conversation`

Start a new outbound conversation via Telegram personal.

- **Auth:** `requireAuth`
- **Request Body:** `{ "phoneNumber": "string", "initialMessage": "string (optional)" }`
- **Response 200:** `{ "success": true, "conversationId": "uuid" }`

---

### WhatsApp Personal

#### POST `/api/whatsapp-personal/start-auth`

Start QR-based WhatsApp auth.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`
- **Response 200:** `{ "success": true, "status": "qr_ready | connected", "qrCode": "string", "qrDataUrl": "string" }`

#### POST `/api/whatsapp-personal/start-auth-phone`

Start phone pairing code auth.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`, `requireActiveTenant`
- **Request Body:** `{ "phoneNumber": "string" }`
- **Response 200:** `{ "success": true, "status": "pairing_code_ready | connected", "pairingCode": "string" }`

#### POST `/api/whatsapp-personal/check-auth`

Poll auth status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "success": true, "status": "string", "user": { ... } }`

#### POST `/api/whatsapp-personal/logout`

Disconnect WhatsApp personal.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** Logout result

#### GET `/api/whatsapp-personal/status`

Get connection status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "connected": true, "status": "string", "user": { ... } }`

---

### Max Personal

#### POST `/api/max-personal/start-auth`

Start QR-based Max auth.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`, `requireActiveSubscription`
- **Response 200:** `{ "success": true, "status": "qr_ready | connected", "qrCode": "string", "qrDataUrl": "string", "user": { ... } }`
- **Response 503:** Service unavailable

#### POST `/api/max-personal/check-auth`

Poll auth status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "success": true, "status": "string", "user": { ... } }`

#### POST `/api/max-personal/logout`

Disconnect Max personal.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** Logout result

#### GET `/api/max-personal/status`

Get connection status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "connected": true, "status": "string", "user": { ... } }`

#### GET `/api/max-personal/service-status`

Check if the Max Personal Python microservice is available.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_CHANNELS")`
- **Response 200:** `{ "available": true }`

#### POST `/api/max-personal/incoming` *(internal)*

Receives messages from the Max Personal Python microservice.

- **Auth:** `X-Internal-Secret` header (matches `MAX_INTERNAL_SECRET` or `SESSION_SECRET`)
- **Request Body:** `{ "tenant_id": "uuid", "message": { ... } }`
- **Response 200:** `{ "success": true }`

---

### Billing

#### GET `/api/billing/me`

Get billing status for the current tenant.

- **Auth:** `requireAuth`
- **Response 200:**

```json
{
  "hasSubscription": true,
  "status": "active | trialing | past_due | canceled | ...",
  "plan": { "id": "uuid", "name": "string", "amount": 5000, "currency": "usd", "interval": "month" },
  "currentPeriodEnd": "ISO datetime",
  "cancelAtPeriodEnd": false,
  "canAccess": true,
  "isTrial": false,
  "trialEndsAt": null,
  "trialDaysRemaining": null,
  "hadTrial": true,
  "hasActiveGrant": false,
  "grantEndsAt": null
}
```

#### POST `/api/billing/checkout`

Create a payment checkout session (CryptoBot).

- **Auth:** `requireAuth`, `requireAdmin`
- **Response 200:** `{ "url": "https://...", "invoiceId": "string" }`

#### GET `/api/billing/check-invoice/:invoiceId`

Check invoice payment status.

- **Auth:** `requireAuth`
- **Response 200:** `{ "status": "string", "billingStatus": { ... } }`

#### POST `/api/billing/cancel`

Cancel subscription.

- **Auth:** `requireAuth`, `requireAdmin`
- **Response 200:** `{ "success": true, "message": "string" }`

---

### Feature Flags

#### GET `/api/admin/feature-flags`

List all feature flags.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Response 200:** `FeatureFlag[]`

#### GET `/api/admin/feature-flags/:name`

Get a single flag.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Response 200:** Feature flag object
- **Response 404:** Not found

#### POST `/api/admin/feature-flags/:name/toggle`

Toggle a feature flag.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TENANT_SETTINGS")`
- **Request Body:** `{ "enabled": true, "tenantId": "uuid (optional)" }`
- **Response 200:** Updated flag

#### GET `/api/feature-flags/:name/check`

Check if a flag is enabled for the current tenant.

- **Auth:** `requireAuth`, `requirePermission("VIEW_CONVERSATIONS")`
- **Response 200:** `{ "name": "string", "enabled": true }`

---

### Audit Events

#### GET `/api/conversations/:id/audit`

Get audit trail for a conversation.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Response 200:** `AuditEvent[]`

#### GET `/api/admin/audit-events`

List recent audit events.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Query:** `?limit=100` (max 500)
- **Response 200:** `AuditEvent[]`

#### GET `/api/admin/audit-events/:entityType/:entityId`

Get audit events for a specific entity.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Query:** `?limit=50` (max 200)
- **Response 200:** `AuditEvent[]`

---

### Admin — RAG & Training

#### POST `/api/admin/rag/regenerate-embeddings`

Regenerate RAG embeddings.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Query:** `?limit=50&batchSize=10&concurrency=3&includeStale=true`
- **Response 200:** `{ "processed": 42, "failed": 1, "total": 43, "batches": 5 }`

#### GET `/api/admin/rag/status`

Get RAG system status.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Response 200:**

```json
{
  "ragEnabled": true,
  "embeddingServiceAvailable": true,
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "pendingChunks": 5,
  "staleChunks": 0
}
```

#### POST `/api/admin/rag/invalidate-stale`

Mark stale RAG chunks for re-embedding.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_KNOWLEDGE_BASE")`
- **Response 200:** `{ "invalidated": 12 }`

#### GET `/api/admin/delayed-jobs`

List delayed (scheduled) message jobs.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Response 200:** `{ "jobs": [...], "metrics": { ... } }`

#### GET `/api/admin/training-samples`

List AI training samples.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TRAINING")`
- **Query:** `?outcome=APPROVED | EDITED | REJECTED`
- **Response 200:** `AiTrainingSample[]`

#### POST `/api/admin/training-samples/export`

Export training data.

- **Auth:** `requireAuth`, `requirePermission("EXPORT_TRAINING_DATA")`
- **Request Body:** `{ "outcome": "string (optional)" }`
- **Response 200:** Export data object

#### GET `/api/admin/training-policies`

Get training policies.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_POLICIES")`
- **Response 200:**

```json
{
  "tenantId": "uuid",
  "alwaysEscalateIntents": ["complaint"],
  "forbiddenTopics": ["politics"],
  "disabledLearningIntents": [],
  "updatedAt": "ISO datetime"
}
```

#### PUT `/api/admin/training-policies`

Update training policies.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_POLICIES")`
- **Request Body:**

```json
{
  "alwaysEscalateIntents": ["complaint", "return"],
  "forbiddenTopics": ["politics", "religion"],
  "disabledLearningIntents": []
}
```

- **Response 200:** Updated policy

#### GET `/api/admin/learning-queue`

Get learning queue items.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TRAINING")`
- **Query:** `?minScore=2`
- **Response 200:** `{ "items": [...], "total": 15, "minScore": 2 }`

#### PATCH `/api/admin/learning-queue/:conversationId/review`

Review a learning queue item.

- **Auth:** `requireAuth`, `requirePermission("MANAGE_TRAINING")`
- **Response 200:** Updated queue item

#### GET `/api/admin/security/readiness`

Security readiness report.

- **Auth:** `requireAuth`, `requirePermission("VIEW_AUDIT_LOGS")`
- **Response 200:** Security readiness report object

#### GET `/api/admin/system/metrics`

System metrics (CPU, memory, DB stats).

- **Auth:** `requireAuth`, `requirePlatformOwner`
- **Response 200:**

```json
{
  "cpu": { ... },
  "memory": { ... },
  "uptime": 86400,
  "loadAverage": [0.5, 0.3, 0.2],
  "dbStats": { ... },
  "userStats": { ... }
}
```

---

### Platform Admin

All platform admin routes require `requireAuth` + `requirePlatformAdmin()` (or `requirePlatformOwner()` where noted). Most also apply `auditAdminAction(...)`.

#### GET `/api/admin/health`

Admin health check.

- **Response 200:** `{ "status": "ok", "timestamp": "string", "adminId": "uuid" }`

#### GET `/api/admin/billing/metrics`

Billing overview metrics.

- **Response 200:**

```json
{
  "activeSubscriptions": 50,
  "activeGrants": 5,
  "trialCount": 10,
  "expiredTrials": 3,
  "upcomingRenewals": { "count": 12, "totalAmount": 60000, "renewals": [...] },
  "totalRevenue": 250000
}
```

#### GET `/api/admin/tenants/search`

Search tenants.

- **Query:** `?q=string&limit=20&offset=0`
- **Response 200:** `{ "results": [...], "count": 5, "query": "string" }`

#### GET `/api/admin/users/search`

Search users (emails are masked).

- **Query:** `?q=string&limit=20&offset=0`
- **Response 200:** `{ "results": [...], "count": 3, "query": "string" }`

#### POST `/api/admin/tenants/:tenantId/restrict`

Restrict a tenant (disables all channels).

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### POST `/api/admin/tenants/:tenantId/unrestrict`

Unrestrict a tenant. **Requires platform owner.**

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### POST `/api/admin/users/:userId/disable`

Disable a user.

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### POST `/api/admin/users/:userId/enable`

Re-enable a user.

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### POST `/api/admin/tenants/:tenantId/grant`

Grant temporary subscription access.

- **Request Body:** `{ "days": 30, "reason": "string (3-500 chars)" }`
- **Validation:** `days` range: 1–365
- **Response 201:** `{ "success": true, "grant": { ... } }`

#### POST `/api/admin/tenants/:tenantId/grants`

Grant access with explicit date range.

- **Request Body:** `{ "startsAt": "ISO datetime", "endsAt": "ISO datetime", "reason": "string (3-500 chars)" }`
- **Response 201:** `{ "success": true, "grant": { ... } }`

#### GET `/api/admin/tenants/:tenantId/grants`

List grants for a tenant.

- **Query:** `?includeRevoked=true`
- **Response 200:** `{ "grants": [...], "count": 3 }`

#### DELETE `/api/admin/grants/:grantId`

Revoke a grant.

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "grantId": "uuid" }`

#### POST `/api/admin/secrets`

Create or rotate an integration secret.

- **Request Body:**

```json
{
  "scope": "global | tenant",
  "tenantId": "uuid (required if scope=tenant)",
  "keyName": "UPPERCASE_ALPHANUMERIC_KEY (3-64 chars)",
  "plaintextValue": "string (1-10000 chars)",
  "reason": "string (3-500 chars)"
}
```

- **Response 201:** Secret metadata (new) or **200** (rotated existing)

#### POST `/api/admin/secrets/:id/rotate`

Rotate an existing secret.

- **Request Body:** `{ "plaintextValue": "string (1-10000 chars)", "reason": "string (3-500 chars)" }`
- **Response 200:** Updated secret metadata
- **Response 403:** Global secrets require platform owner

#### POST `/api/admin/secrets/:id/revoke`

Revoke a secret.

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "secretId": "uuid" }`

#### GET `/api/admin/secrets`

List secrets (values are never returned).

- **Query:** `?scope=global|tenant&tenantId=uuid&keyName=string&includeRevoked=true&limit=20&offset=0`
- **Response 200:** `{ "secrets": [...], "pagination": { "limit": 20, "offset": 0, "count": 5 } }`

#### GET `/api/admin/users`

List all users.

- **Query:** `?q=string&limit=20&offset=0`
- **Response 200:** `{ "users": [...], "total": 50 }`

#### GET `/api/admin/users/:userId`

Get full user details with tenant/subscription info.

- **Response 200:** Full user object

#### GET `/api/admin/users/:userId/audit`

Get user's audit log.

- **Query:** `?limit=50` (max 100)
- **Response 200:** `{ "logs": [...] }`

#### POST `/api/admin/users/:userId/impersonate`

Impersonate a user. **Requires platform owner.** Cannot impersonate other admins/owners.

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "redirectUrl": "string", "impersonatedUser": { ... } }`

#### POST `/api/admin/impersonate/exit`

Exit impersonation and return to admin session.

- **Auth:** `requireAuth`
- **Response 200:** `{ "success": true, "redirectUrl": "string" }`

#### POST `/api/admin/users/:userId/promote-admin`

Promote user to platform admin. **Requires platform owner.**

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### POST `/api/admin/users/:userId/demote-admin`

Demote a platform admin. **Requires platform owner.**

- **Request Body:** `{ "reason": "string (3-500 chars)" }`
- **Response 200:** `{ "success": true, "actionId": "uuid" }`

#### GET `/api/admin/updates`

Get update history. **Requires platform owner.**

- **Response 200:** `{ "history": [...], "currentVersion": "string" }`

#### GET `/api/admin/updates/version`

Get current version. **Requires platform owner.**

- **Response 200:** `{ "version": "string" }`

#### POST `/api/admin/updates/upload`

Upload a system update package. **Requires platform owner.**

- **Content-Type:** `multipart/form-data`
- **Fields:** `file` (ZIP, max 100 MB), `version` (string), `changelog` (string, optional)
- **Response 200:** `{ "success": true, "update": { ... } }`

#### POST `/api/admin/updates/:id/apply`

Apply an uploaded update. **Requires platform owner.**

- **Response 200:** `{ "success": true, "message": "string" }`

#### POST `/api/admin/updates/:id/rollback`

Rollback a previously applied update. **Requires platform owner.**

- **Response 200:** `{ "success": true, "message": "string" }`

#### POST `/api/admin/system/rebuild`

Trigger system rebuild. **Requires platform owner.**

- **Response 200:** `{ "success": true, "message": "string" }`

#### Proxy Management (all require platform owner)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/proxies` | List proxies. Query: `?status=...&limit=50&offset=0` |
| POST | `/api/admin/proxies` | Add a proxy. Body: `{ host, port, protocol, username?, password?, country?, label? }` |
| POST | `/api/admin/proxies/import` | Bulk import (max 1000). Body: `{ proxies: [...] }` |
| POST | `/api/admin/proxies/parse` | Parse proxy list from text. Body: `{ text: "string" }` |
| PATCH | `/api/admin/proxies/:id` | Update a proxy. |
| DELETE | `/api/admin/proxies/:id` | Delete a proxy. |
| DELETE | `/api/admin/proxies` | Bulk delete. Query: `?status=...` |
| POST | `/api/admin/proxies/:id/assign` | Assign proxy to tenant/channel. Body: `{ tenantId?, channelId? }` |
| GET | `/api/admin/proxies/available` | List available proxies. Query: `?protocol=socks5&country=RU` |

---

## Webhooks

### Telegram Webhook

**URL:** `POST /webhooks/telegram` (also `/api/webhook/telegram`)

| Property | Value |
|----------|-------|
| Auth | None |
| Rate limit | `webhookRateLimiter` (500 req/min) |
| Verification | `X-Telegram-Bot-Api-Secret-Token` header must match `TELEGRAM_WEBHOOK_SECRET` |
| Feature flag | `TELEGRAM_CHANNEL_ENABLED` |

**Payload:** Standard Telegram Bot API `Update` object.

**Response 200:**

```json
{
  "ok": true,
  "processed": true,
  "messageId": "string",
  "chatId": "string",
  "userId": "string",
  "duplicate": false
}
```

**Response 401:** Verification failed

Deduplication is performed by `update_id`.

---

### WhatsApp Webhook

**Verification (GET):** `GET /webhooks/whatsapp`

- Query params: `hub.mode`, `hub.verify_token`, `hub.challenge`
- Returns the `hub.challenge` string on success
- Returns 403 if `hub.verify_token` doesn't match or channel is disabled

**Messages (POST):** `POST /webhooks/whatsapp`

| Property | Value |
|----------|-------|
| Auth | None |
| Rate limit | `webhookRateLimiter` (500 req/min) |
| Verification | `X-Hub-Signature-256` header (HMAC-SHA256 with `WHATSAPP_APP_SECRET`) |
| Feature flag | `WHATSAPP_CHANNEL_ENABLED` |

**Payload:** Standard WhatsApp Business API webhook payload. Only `whatsapp_business_account` objects are processed.

**Response 200:**

```json
{
  "ok": true,
  "processed": true,
  "messageId": "string",
  "senderId": "string"
}
```

---

### Max Webhook

**URL:** `POST /webhooks/max/`

| Property | Value |
|----------|-------|
| Auth | None |
| Verification | `X-Max-Bot-Api-Secret` header; optionally `X-Max-Signature` (HMAC-SHA256) |
| Feature flag | `MAX_CHANNEL_ENABLED` |

**Response 200:**

```json
{
  "ok": true,
  "received": { "messageId": "string", "userId": "string", "chatId": "string" },
  "duplicate": false
}
```

**Additional Max webhook endpoints:**

- `GET /webhooks/max/health` — returns `{ "channel": "max", "enabled": true, "webhookConfigured": true, "tokenConfigured": true }`
- `POST /webhooks/max/verify-auth` — returns `{ "ok": true, "bot": { "id": "string", "name": "string", "username": "string" } }`

---

### CryptoBot Webhook

**URL:** `POST /webhooks/cryptobot`

| Property | Value |
|----------|-------|
| Auth | None |
| Verification | `crypto-pay-api-signature` header (HMAC-SHA256 with `CRYPTO_PAY_API_TOKEN`) |

**Payload:** CryptoBot payment event object.

**Response 200:** `{ "received": true }`
**Response 400:** Missing or invalid signature

Handles subscription payment confirmations.

---

## WebSocket Events

**Connection URL:** `ws://host/ws` (or `wss://` in production)

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribe` | `{ type: "subscribe", conversationId: "uuid" }` | Subscribe to updates for a conversation |
| `set_tenant` | `{ type: "set_tenant", tenantId: "uuid" }` | Set tenant context |
| `ping` | `{ type: "ping" }` | Keepalive; server responds with `pong` |

### Server → Client

| Event | Payload | When |
|-------|---------|------|
| `connected` | `{ type: "connected" }` | On connection |
| `pong` | `{ type: "pong" }` | In response to `ping` |
| `new_message` | `{ type: "new_message", conversationId: "uuid", message: Message }` | New message in a subscribed conversation |
| `conversation_update` | `{ type: "conversation_update", conversation: Partial<Conversation> & { id: string } }` | Conversation status/mode change |
| `new_conversation` | `{ type: "new_conversation", conversation: Conversation }` | New conversation created |
| `new_suggestion` | `{ type: "new_suggestion", conversationId: "uuid", suggestionId: "uuid" }` | AI suggestion generated |

**Scoping:** `new_message` is sent to clients subscribed to the specific conversation or the tenant. All other events are broadcast to all clients in the tenant.

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI API key (fallback: `OPENAI_API_KEY`) |
| `SESSION_SECRET` | Session secret, min 32 chars |
| `INTEGRATION_SECRETS_MASTER_KEY` | AES-256-GCM master key (32 bytes, base64) |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development` / `staging` / `production` / `test` |
| `PORT` | `5000` | Server listen port |
| `TRUST_PROXY` | `false` | Enable for reverse proxy (Cloudflare, Nginx) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SENTRY_DSN` | — | Sentry error tracking DSN |
| `REDIS_URL` | — | Redis URL for queues/workers (disabled if not set) |

### OpenAI

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | — | Primary API key |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL |
| `OPENAI_API_KEY` | — | Fallback API key |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max API requests per minute |
| `RATE_LIMIT_AI_MAX_REQUESTS` | `20` | Max AI requests per minute |

### Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook verification secret |
| `TELEGRAM_API_ID` | MTProto API ID (numeric, for personal accounts) |
| `TELEGRAM_API_HASH` | MTProto API hash (32-char hex) |

### WhatsApp

| Variable | Description |
|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Business API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verify token |
| `WHATSAPP_APP_SECRET` | App secret for signature verification |

### Max (VK Teams)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TOKEN` | — | Bot token |
| `MAX_WEBHOOK_SECRET` | — | Webhook verification secret |
| `MAX_SERVICE_URL` | `http://localhost:8100` | Python microservice URL |
| `MAX_INTERNAL_SECRET` | falls back to `SESSION_SECRET` | Internal service auth |

### Billing

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `CRYPTO_PAY_API_TOKEN` | CryptoPay API token |
| `CRYPTO_PAY_TESTNET` | Enable CryptoPay testnet (`true`/`false`) |

### Feature Flags (env overrides)

| Variable | Default | Description |
|----------|---------|-------------|
| `FEATURE_AI_SUGGESTIONS_ENABLED` | — | Enable AI suggestions |
| `FEATURE_RAG_ENABLED` | `true` | Enable RAG retrieval |
| `FEATURE_AI_AUTOSEND_ENABLED` | `false` | Enable auto-send |
| `FEATURE_HUMAN_DELAY_ENABLED` | `false` | Enable human-like delay |
| `FEATURE_DECISION_ENGINE_ENABLED` | `false` | Enable decision engine |

### Price Sources

| Variable | Default | Description |
|----------|---------|-------------|
| `AVITO_ENABLED` | `false` | Enable Avito price source |
| `DROM_ENABLED` | `false` | Enable Drom price source |
| `SERP_API_KEY` | — | SerpAPI key for web price source |

### Vehicle Lookup

| Variable | Default | Description |
|----------|---------|-------------|
| `PODZAMENU_LOOKUP_SERVICE_URL` | `http://localhost:8200` | Podzamenu service URL |

### Platform Owner Bootstrap

| Variable | Description |
|----------|-------------|
| `OWNER_EMAIL` | Bootstrap owner email |
| `OWNER_PASSWORD` | Bootstrap owner password (remove after first run) |
| `OWNER_PASSWORD_HASH` | Alternative: bcrypt hash |
| `OWNER_NAME` | Owner display name (default: "Platform Owner") |

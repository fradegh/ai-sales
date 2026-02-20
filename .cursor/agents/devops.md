---
name: devops
description: DevOps engineer for AI Sales Operator. Docker, PM2, Nixpacks deployment. Use when working on Dockerfile, docker-compose, PM2 config, Nixpacks, environment variables, build scripts, health checks, logging, CI/CD, deployment, or infrastructure.
---

You are the DevOps engineer for AI Sales Operator.

**Deployment:** Docker (node:20-alpine) + PM2 (ecosystem.config.cjs) + Nixpacks (nixpacks.toml)

**Configs:** `Dockerfile`, `ecosystem.config.cjs`, `nixpacks.toml`, `start.sh`

## Before Any Work

1. Read `Dockerfile`, `ecosystem.config.cjs`, `nixpacks.toml`, `start.sh`
2. Read `.env.example` for all environment variables
3. Read `server/config.ts` for Zod-based env validation
4. Read `package.json` for scripts
5. Read `PROJECT_MAP.md` for context

## Rules

### Environment Variables

- `.env.example` is the source of truth (110 lines)
- Required: `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `SESSION_SECRET` (min 32 chars), `INTEGRATION_SECRETS_MASTER_KEY` (32 bytes, base64 for AES-256-GCM)

### Docker

- `node:20-alpine` base image
- Build: `npm install` → `npm run build`
- Start: `drizzle-kit push --force` → `npm run start`
- Exposes port 5000

### PM2 (`ecosystem.config.cjs`)

- `aisales`: main app (`dist/index.cjs`), 1 instance, 1G memory limit, reads `.env` file
- `worker-price-lookup`: separate process (`npm run worker:price-lookup`), 1 instance, 512M memory limit
- Logs to `../logs/` directory (error.log, out.log, combined.log)

### Nixpacks (`nixpacks.toml`)

Node 20 + npm 9. Install: `npm install`. Build: `npm run build`. Start: `npm run start`

### Python Services

Launched as child processes from `server/index.ts`:

| Service | Port | Purpose |
|---------|------|---------|
| `max_personal_service.py` | 8100 | MAX Personal auth via Playwright. Spawned automatically on startup |
| `podzamenu_lookup_service.py` | 8200 | VIN/FRAME lookup via Playwright. Launched separately or via PM2 |

Both require Python >=3.11 with deps from `pyproject.toml` (FastAPI, Playwright, uvicorn, pydantic, httpx, aiohttp).

### DB Migrations

`drizzle-kit push --force` runs automatically before app start (in `start.sh`, `Dockerfile`, and `npm run start` script).

### Build Process

- `npm run build` → `tsx script/build.ts` → esbuild (server → `dist/index.cjs` as CJS bundle) + Vite (client → `dist/public/` as static files)
- `npm run dev` → `tsx server/index.ts` with Vite dev middleware for HMR
- `npm run check` → `tsc` type checking

### Health Checks

`GET /health` (basic), `GET /ready` (DB + OpenAI connectivity), `GET /metrics` (uptime, memory)

### Logging

pino 10.1.0 (structured JSON). Level controlled by `LOG_LEVEL` env var (debug/info/warn/error). Sentry DSN optional via `SENTRY_DSN`.

### Redis

Required for BullMQ job queues. ioredis 5.9.0 client. Falls back to `ioredis-mock` in development if no Redis configured.

## Key Files

| File | Description |
|------|-------------|
| `Dockerfile` | node:20-alpine, npm install, npm run build, drizzle-kit push --force, npm run start. Port 5000 |
| `ecosystem.config.cjs` | PM2: aisales (dist/index.cjs, 1G) + worker-price-lookup (512M). Loads .env, logs to ../logs/ |
| `nixpacks.toml` | Node 20, npm 9. Install → Build → Start |
| `start.sh` | `drizzle-kit push --force` then `npm run start` |
| `pyproject.toml` | Python >=3.11 deps: FastAPI, Playwright, uvicorn, pydantic, httpx, aiohttp, maxapi-python |
| `package.json` | Scripts: dev, build, start, check, db:push, worker:vehicle-lookup, worker:price-lookup |
| `script/build.ts` | Build script: Vite frontend + esbuild server bundle |
| `.env.example` | All environment variables documented (110 lines) |
| `server/config.ts` | Zod-based env validation schema |
| `server/routes/health.ts` | /health, /ready, /metrics endpoints |
| `max_personal_service.py` | FastAPI (port 8100): MAX Personal auth via Playwright |
| `podzamenu_lookup_service.py` | FastAPI (port 8200): VIN/FRAME lookup via Playwright (podzamenu.ru, prof-rf) |

# lets_go_back

Standalone backend repository. Related clients: [web](https://github.com/leonid-belousov/letsgo-frontend) and [mobile](https://github.com/leonid-belousov/letsgo-mobile).

Shared product documents and backend reports are included in [docs/project](docs/project). Historical plans retain paths from the original combined workspace; `lets_go_back/` denotes this repository root.

## 1. Purpose

Let'sGo backend API — the **source of truth for business state and permissions**. `lets_go_front` (web) and `lets_go_mobile` (Expo) are clients only; neither may infer authorization from visible buttons. All API routes live under `/v1`; `/health`, `/health/ready` and `/docs` are unprefixed.

## 2. Technology stack

Node.js · TypeScript (strict) · NestJS 11 · PostgreSQL 16 · Prisma 7 (`@prisma/adapter-pg`) · zod (env) · class-validator (DTOs) · Swagger/OpenAPI · nestjs-pino (secrets redacted) · helmet · @nestjs/throttler · scrypt password hashing (`node:crypto`) · JWT access + rotating opaque refresh tokens · Jest + supertest · ESLint + Prettier.

> Nest **11** is pinned: Nest 12 is ESM-only and clashes with the Jest/CJS toolchain.

## 3. Requirements

Node.js ≥ 22 (developed on 25.6), npm ≥ 10, Docker (local PostgreSQL).

## 4. Installation

```bash
npm install
cp .env.example .env          # placeholders only — never commit real secrets
npm run db:up                 # PostgreSQL 16 via docker compose
npx prisma migrate deploy     # apply all migrations
npm run prisma:generate
```

## 5. Environment variables (`.env.example`)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `PORT`, `NODE_ENV`, `CORS_ORIGINS`, `LOG_LEVEL` | basics |
| `JWT_ACCESS_SECRET` (≥32 chars), `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TTL_DAYS` | sessions |
| `PASSWORD_SCRYPT_LOG_N`, `PASSWORD_MIN_LENGTH` | password hashing cost / floor |
| `CASUAL_CASH_RECEIVER_POLICY` | OPEN decision #1: `EXPLICIT_ONLY` (default) or `ORGANISER` |
| `WAITLIST_OFFER_MINUTES`, `MVP_VOTING_HOURS`, `RATING_EDIT_DAYS`, `IDEMPOTENCY_TTL_HOURS` | configurable product parameters (no numbers hard-coded from mockups) |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | optional comma lists of accepted ID-token audiences (Google OAuth client ids; Apple bundle id / service id). Empty ⇒ that provider answers `503 PROVIDER_UNAVAILABLE` with `details.reason = PROVIDER_NOT_CONFIGURED` |
| `MAINTENANCE_INTERVAL_SECONDS` | built-in trigger of the persistent maintenance job (default 30; `0` disables it and an external scheduler runs `npm run maintenance:tick`). State lives in PostgreSQL; an advisory lock makes concurrent runs collapse into one |
| `NOTIFICATION_MAX_ATTEMPTS` | delivery retries with exponential backoff before a notification stays FAILED (in-app copy is always kept) |
| `TRUST_PROXY` | `false` (default), a hop count (`1`), or a list of trusted subnets. The literal `true` is refused. Behind a proxy set it explicitly, otherwise rate limiting keys on the proxy address |
| `THROTTLE_STORAGE` | `memory` only: rate limits are **per process**; several instances need a shared store (OPEN #28) |
| `DB_POOL_MAX` | PostgreSQL pool size per process (default 10; size instances × pool below `max_connections`) |
| `MEDIA_LOCAL_DIR` | dev-only local media storage (production provider is OPEN) |
| `TEST_DATABASE_URL` | optional; tests default to the dev database |

Invalid configuration aborts startup (`src/config/env.ts`).

## 6. Local development

```bash
npm run dev                   # http://localhost:3000
```

- Liveness `GET /health`; readiness `GET /health/ready` (database).
- Swagger UI `/docs`, OpenAPI JSON `/docs/openapi.json` (disabled when `NODE_ENV=production`) — the source for generated client APIs (`npm run api:generate` in the clients).
- Staff bootstrap: there is no admin flag. Insert a `PLATFORM` `RoleGrant` (`admin.staff.manage`) for the first staff member with SQL/Prisma Studio; that person then issues scoped staff grants through `POST /v1/grants`.

## 7. Build / run

`npm run build` then `npm start`.

## 8. Test

```bash
npm test                      # unit + HTTP e2e + real-PostgreSQL integration & concurrency tests
npm run test:migrations       # rebuilds the schema FROM ZERO in a throw-away database, checks drift and the DB-level invariants
```

## 9. Lint / types

`npm run lint` · `npm run typecheck` · `npm run format:check`.

## 10. Architecture notes

See `CLAUDE.md` / `AGENTS.md` (rules) and [BACKEND_IMPLEMENTATION_REPORT.md](docs/project/BACKEND_IMPLEMENTATION_REPORT.md) (what exists). Highlights:

- **Authorization**: `PolicyService` (structural authority + `RoleGrant` with scope, expiry, source grant, can-pass-on). Role titles grant nothing. Capabilities in responses come from the same calls that guard mutations.
- **Idempotency**: `Idempotency-Key` header; key row committed in the same transaction as the work (survives restarts; same key + different payload → `IDEMPOTENCY_CONFLICT`). Mandatory for Cash received and adjustments.
- **Concurrency**: `SELECT … FOR UPDATE` on the Event for seats/holds/offers/team moves; PostgreSQL exclusion constraint on `PitchOccupancy` for bookings (divisible pitches expand to atomic parts); unique indexes for handles/contacts/entries; immutable tables (receipts, adjustments, consents, audit, match revisions) enforced by triggers.
- **Side effects** (Activity, Notification, system chat card) are written in the same transaction as the change (`Notifier`); external push is an abstraction with a dev/log provider only.
- **Errors**: one envelope `{ error: { code, message, details?, requestId? } }` with `VALIDATION, ACCESS_DENIED, EXPIRED, CAPACITY_CHANGED, BOOKING_CONFLICT, VERSION_CHANGED, UPLOAD_FAILED` (+ `UNAUTHENTICATED, NOT_FOUND, CONFLICT, IDEMPOTENCY_CONFLICT, RATE_LIMITED, PROVIDER_UNAVAILABLE, INTERNAL`).
- **Pagination**: opaque keyset cursors (`{ items, nextCursor }`).

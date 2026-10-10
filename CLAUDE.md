# CLAUDE.md — lets_go_back

Working guide for Claude Code sessions in the Let'sGo backend. Read this first, then `AGENTS.md`.

## 1. Project purpose
Backend API for Let'sGo (football platform, Georgia first): auth, profiles/privacy, games and invitations, clubs, venues/booking, tournaments, cash fee tracking, social, chat, activity, ratings, moderation. **The backend is the single source of truth for business state AND permissions.** `lets_go_front` and `lets_go_mobile` are clients; they never decide access.

## 2. Technology stack
Node.js (dev on 25.x; ≥22) · TypeScript strict · NestJS **11** (CJS; Nest 12 is ESM-only and breaks Jest) · PostgreSQL 16 · Prisma **7** with `@prisma/adapter-pg` · zod (env) · class-validator (DTOs) · @nestjs/swagger · nestjs-pino · helmet · @nestjs/throttler · Jest + supertest · ESLint + Prettier. npm only.

## 3. Architecture decisions (TECH unless marked)
- Global prefix `/v1`; `/health`, `/health/ready`, `/docs*` are unprefixed.
- IDs: UUIDv7 (`@default(uuid(7))`, `@db.Uuid`) → time-sortable, keyset-pagination friendly. Timestamps `timestamptz(3)` UTC. Event-local time = UTC instant + IANA `timezone` string. Never store "Tomorrow".
- Money: integer minor units (`amountMinor`) + ISO currency. No floats.
- Auth: password (scrypt via `node:crypto`, no extra dep) → short-lived JWT access token (15 min) bound to a `Session`; opaque refresh token (256-bit random, only SHA-256 stored), rotated on every refresh with reuse detection. Access guard re-checks the session row so revocation is immediate.
- Authorization: `PolicyService` = structural relations (owner/organiser) + `RoleGrant` rows (permission, scope, expiry, source grant, can-pass-on). Role *titles* are display text only. Capabilities (`canJoin`, …) are computed server-side per response.
- Idempotency: `IdempotencyRecord` (user, scope, key, request hash, stored response) written **inside the same DB transaction** as the work; concurrent duplicates block on the row lock; survives restarts.
- Concurrency: row locks (`SELECT … FOR UPDATE` on the Event row) for seats/holds; PostgreSQL **exclusion constraints** (btree_gist) for booking overlap; unique indexes for handles/contacts; DB triggers make receipts/adjustments/audit rows immutable.
- Side effects (ActivityItem, Notification, system chat message) are written in the *same transaction* as the state change (no broker). External push delivery is an abstraction over `Notification.deliveryStatus` (provider is OPEN).
- Pagination: opaque keyset cursors (`{t,id}`), never offset for mutable feeds.
- Optimistic concurrency: `version` int on editable resources → `VERSION_CHANGED`.

## 4. Directory structure
```
src/
  common/{auth,errors,idempotency,pagination,permissions,transactions,audit,time}
  config/ infrastructure/{prisma,security,storage,notifications}
  modules/{auth,users,privacy,social,games,invitations,clubs,venues,bookings,tournaments,
           payments,chat,activity,posts,media,notifications,ratings,achievements,moderation,admin,health}
prisma/schema.prisma  prisma/migrations/  (custom SQL for exclusion constraints/triggers lives in migrations)
test/  (e2e + db integration; helpers in test/support)
```
Module = `*.module.ts`, `*.controller.ts` (thin), `*.service.ts` (application/domain), `dto/`, `*.spec.ts`.

## 5. Commands
`npm run db:up` · `npx prisma migrate deploy` · `npm run prisma:generate` · `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run maintenance:tick`. Clean-DB migration proof: `npm run test:migrations`.

## 6. Environment
Copy `.env.example` → `.env`. `DATABASE_URL` points at docker compose Postgres. Tests use `TEST_DATABASE_URL` (defaults to the dev DB; integration tests use unique synthetic data and never truncate shared tables). Secrets are placeholders only.

## 7. Coding conventions
Strict TS, no `any`, no unsafe casts. Controllers thin (parse → actor → service → DTO). Domain errors via `ApiError(ErrorCode.X, msg, details)`. Explicit response DTOs (never return Prisma entities). Separate public/follower/owner/admin DTOs. Raw SQL only via tagged `$queryRaw`/`$executeRaw` templates. No repository wrappers that add nothing. No business logic in controllers. No circular module deps.

## 8. Testing requirements
Every module needs domain-service tests + HTTP/e2e for its endpoints; races (last seat, booking overlap, cash double-tap, username race) need real-DB concurrency tests. Map to `BACKEND_ACCEPTANCE_MATRIX.md`. `typecheck && lint && test && build` must be green before finishing.

## 9. Security rules
No secrets/tokens/passwords in logs, audit metadata, errors or repo. Never return `passwordHash`, refresh token hashes, DOB, phone/email to non-owners. Every read that returns another user's data goes through the visibility layer. Check ownership/permission on **every** object id (IDOR/BOLA). DTOs whitelist fields (mass assignment). Rate-limit auth endpoints.

## 10. Business-rule constraints (see PROJECT_ANALYSIS.md, source docs)
Ordinary invitation ≠ seat hold; free seats = capacity − confirmed − active holds; invited/pending/waitlisted/held/confirmed are distinct states; waitlist offers need explicit acceptance and create no debt; Pay cash ≠ Cash received ≠ Paid; receipts/adjustments are immutable; Follow ≠ Favourite ≠ Join; a role title grants nothing; delegation cannot widen scope/expiry; private fields never leave the API.

## 11. Source-of-truth rules
Priority: newest explicit correction → newest product decision → Handoff → earlier approved → mockups → sample data. Sample names/prices/dates in mockups are illustrative. Labels: **DOC / WORK / TECH / OPEN**. An OPEN item is never silently decided — put it in `OPEN_DECISIONS.md` and make the behavior configurable/unimplemented.

## 12. MUST NOT
No wallet, card payments, bank transfer, video analysis, football-career import, message broker. No hard-coded users, `paid=true`, mock services, allow-all permissions, admin bypass. No real phone numbers from the source docs. No editing applied migrations. No in-memory locks/idempotency.

## 13. Definition of Done
Persistence + migration + service rules + OpenAPI-documented endpoints + tests (incl. concurrency where relevant) + audit for sensitive actions + typecheck/lint/test/build green + report updated honestly.

## 14. Documentation
`../PROJECT_ANALYSIS.md`, `../IMPLEMENTATION_REPORT.md`, `../BACKEND_IMPLEMENTATION_PLAN.md`, `../BACKEND_ACCEPTANCE_MATRIX.md`, `../OPEN_DECISIONS.md`, `../BACKEND_IMPLEMENTATION_REPORT.md`. Originals (Downloads/Telegram Desktop): `LetsGo_Development_Handoff_2026-09-22*.md`, `LetsGo_Decisions_2026-09-21*.html`, `LetsGo_Approved_UI_Designs_2026-09-24*.pdf`.

## 15. Known OPEN decisions
See `../OPEN_DECISIONS.md` (casual-game cash receiver, recommendation ranking, recovery verification specifics, password policy specifics, badge criteria, rating weights, media/push providers, deposits/refund/weather, divisible-pitch rules, language list).

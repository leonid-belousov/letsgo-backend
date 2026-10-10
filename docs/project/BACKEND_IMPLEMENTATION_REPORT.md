# Backend Implementation Report

Labels: DOC · WORK · TECH · OPEN (see OPEN_DECISIONS.md). Date: 2026-09-30.

## 1. Architecture after implementation
NestJS 11 modular monolith over PostgreSQL 16 / Prisma 7. Kernel (`src/common`): auth guard, error envelope, idempotency, pagination, policy/permissions, audit, notifier, clock, tx helpers. `src/modules`: access, auth, users, privacy, games (+invitations, participation, maintenance), payments, clubs, venues, bookings, tournaments, social, search, media, posts, chat, activity, notifications, results, ratings, achievements, moderation, admin, health. Built in parallel by sub-agents on a frozen schema/kernel; the lead integrated and verified.

## 2–3. Domains
**Completed (persistence + rules + API + tests):** auth/sessions, users/profile/privacy/blocks, grants & delegation, games/invitations/holds/waitlist, payments (cash), clubs, venues, bookings, tournaments, follow/favourites/saved, search, media (dev storage), posts/comments/reactions/mentions, chat, activity, notifications (in-app + delivery abstraction), results/MVP/stats, ratings, achievements, moderation, admin/recovery/audit-read/account deletion.

**Partial / not built (honest list) — superseded by `BACKEND_FINALIZATION_REPORT.md`:** the gaps listed here in the first pass (Google/Apple verification logic, media EXIF/thumbnails, capacity and team edits, automatic next wave, fee-change acceptance, tournament booking validation, post-start withdrawal, head-to-head/fair-play tie-breaks, recent searches, venue-needs-attention) were implemented in the finalization stage. What remains is product-, credential- or infrastructure-dependent and is classified there.

## 4–6. Database, migrations, API
~60 models (`prisma/schema.prisma`). Migrations: `init_domain`; `invariants` (btree_gist/pg_trgm, CHECKs, exclusion constraint `pitch_occupancy_no_overlap`, immutability triggers on receipts / adjustments / consents / audit / match revisions, partial uniques, trigram indexes); `tournament_player_fee_unique`. OpenAPI: 270 paths / 349 schemas at `/docs/openapi.json`. Groups: auth, me/users, privacy/blocks, grants, games/invitations/participation, payments, clubs, venues/pitches/requests, bookings/calendar, tournaments, follows/favourites/saved, discovery, search, media, posts/comments/tag-requests, chat, activity, notifications, matches/stats, ratings, achievements, reports, admin.

## 7–8. Authentication and sessions (TECH)
E-mail or E.164 phone + password, no OTP (DOC). scrypt via `node:crypto` (parameters stored per hash, rehash on login, dummy verification for unknown accounts). 15-minute JWT bound to a Session row that is checked on every request (immediate revocation). Opaque 256-bit refresh token stored hashed, rotated on every use; replaying an old token revokes the session. Session list/revoke, logout-all, change-password (revokes other devices). Rate limits: global 120/min, 10/min on auth. Recovery: staff-approved single-use token.

## 9. Authorization and capabilities
`PolicyService`: structural authority (club owner, event organiser, tournament organiser) + `RoleGrant` (scope, expiry, source grant, can-pass-on, further-delegation). Delegation cannot widen scope or expiry, no cycles or self-grants; revoking cascades in one transaction and independent grants survive. Role titles grant nothing. Capabilities are computed by the same calls that guard mutations. There is no admin flag: staff rights are scoped platform grants.

## 10–13. Idempotency, concurrency, bookings, money
- Idempotency record is committed in the same transaction as the work (restart-safe); same key with a different payload ⇒ `IDEMPOTENCY_CONFLICT`; required for Cash received and adjustments.
- Seats, holds, offers and team moves serialise on `SELECT … FOR UPDATE` of the Event (race tests: last seat ⇒ exactly one winner).
- Booking overlap: exclusion constraint over atomic pitch parts (whole/half/quarter); concurrent test has exactly one winner.
- Money: integer minor units; Pay cash ≠ Cash received; receipts and adjustments immutable by trigger; refund due ≠ refunded; partial payments; self-confirmation refused.

## 14–16. Audit, notifications, media
`AuditService` writes in the same transaction for grants, sessions, cash, corrections, recovery, moderation, cancellations (secret-looking keys scrubbed; rows immutable). `Notifier` writes ActivityItem / Notification / system chat card atomically; delivery goes through `NotificationDeliveryProvider` (log provider only). Media uses a `MediaStorage` abstraction with local disk, size/type/magic-byte checks and short-lived signed URLs that re-check access.

## 17–19. Tests and acceptance
29 suites / 223 tests against real PostgreSQL (unit, HTTP e2e, concurrency, clock-driven expiry) plus `npm run test:migrations` (rebuild from zero, drift check, DB-level invariants). Mapping in `BACKEND_ACCEPTANCE_MATRIX.md`. Device checks S24-01…S24-14 were not run.

## 20. Security review (backend scope)
Checked: object-level access (neutral NOT_FOUND for inaccessible objects), mass assignment (whitelist + forbidNonWhitelisted), token/secret leakage (log redaction, query strings stripped from request logs, hashes never returned), private-field DTO separation, role and delegation escalation (tests), raw SQL (no `*Unsafe` calls anywhere), rate limiting, admin scope, audit immutability, no real personal data or secrets in the repo (synthetic data only).
Fixes made during review: kernel SQLSTATE extraction, unread counts for system cards, invitation answered on direct join, global throttler.
Residual risks: docker-compose dev DB credentials are placeholders; a concurrent double refresh revokes the session (deliberate); rate limits are per instance (needs a shared store to scale out); `trust proxy` not configured; pg “concurrent query” deprecation warning inside Prisma transactions (fine on pg 8).

## 21–22. Technical decisions and dependencies
UUIDv7 ids, timestamptz, `/v1` prefix, keyset cursors, optimistic `version`, scrypt, in-transaction side effects (no broker), advisory lock for scoped conversations, Nest 11 pin. Dependency added this stage: `@nestjs/throttler`.

## 23–27. Commands and results
`npm install`, `npm run db:up`, `npx prisma migrate deploy` (up to date), `npm run prisma:generate`, `npm run typecheck` ✅, `npm run lint` ✅, `npm test` ✅ 223/223, `npm run build` ✅, `npm run test:migrations` ✅. Real server: `/health` ok, `/health/ready` database up, `/docs` 200, `/docs/openapi.json` valid.

## 28. Known limitations
Section 3 plus OPEN_DECISIONS.md #17–#24. No client code changed this stage; `api:generate` in web/mobile is expected to work but was not run.

## 29. Start command
```bash
cd lets_go_back && npm run db:up && npx prisma migrate deploy && npm run dev
```

## 30. Recommended next stage
Run `api:generate` in `lets_go_front` / `lets_go_mobile`; build the first client slice (Home → invited game → Confirm → Pay cash → Cash received) on the generated types; resolve the OPEN items that block UI (recommendation ranking, language list, casual-game cash receiver); schedule the device runs.

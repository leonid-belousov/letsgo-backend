# Backend Finalization Report

Stage: BACKEND FINALIZATION / GAP-CLOSURE (2026-09-30). Scope: `lets_go_back` only. No UI work; clients were touched only to validate the generated OpenAPI contract.

## 1. Baseline
Start of stage: 29 suites / 223 tests green, typecheck/lint/build green, 3 migrations. Nothing was reimplemented; every change below extends an existing module.

## 2. Final result
| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npx jest` | **42 suites / 338 tests passed** (real PostgreSQL 16) |
| `npm run build` | clean |
| `npm run test:migrations` (temporary DB from zero, drift + invariants) | passed |
| `prisma generate`, `prisma migrate status` | up to date, 6 migrations |
| Real server (`node dist/main.js`) | `/health` 200, `/health/ready` 200 (`database: up`), `/docs` 200, `/docs/openapi.json` 200 |
| OpenAPI | 291 paths / 338 operations, 0 duplicate operationIds |
| Client contract | `npm run api:generate` succeeds in `lets_go_front` and `lets_go_mobile`; both projects typecheck with the generated `schema.d.ts` |
| Marker grep (TODO/FIXME/HACK/NotImplemented/501/temporary/placeholder/mock/allowAll) | no stubs. Hits reviewed: "temporary hold/guest" (domain wording) and tournament *fixture placeholders* (domain feature: "A1", "Winner of…"). No `Unsafe` raw SQL; all raw SQL is tagged `$queryRaw`/`Prisma.sql` |

## 3. What changed (by gap)
| Gap | Result |
|---|---|
| Automatic next invitation wave | `InvitationsService.nextWave`, driven by `MaintenanceService.runOnce` (persistent, advisory-locked, `JobRun` rows). Per-game `autoNextWave`. Waitlist is served first; nothing is invited when no place is free |
| Booking cancelled ⇒ venue needs attention | cancel / reject / every hold-expiry path flag linked events (`venueNeedsAttention`, reason, time), audit + notification; `POST /v1/games/:id/booking` re-attaches and clears the flag |
| Price change after confirmation | `FeeAmendment` flow (`/v1/games/:id/fee-amendments`, `/v1/payments/amendments/*`); direct edit answers 409 `FEE_AMENDMENT_REQUIRED` |
| Recent searches | `POST/GET/DELETE /v1/search/recent`, dedupe, cap 20, access re-checked on read |
| Media EXIF stripping + thumbnails | sharp pipeline at finalize: orientation applied, all metadata dropped, WebP `thumb`/`card` variants, pixel/animation/mismatch guards, variant URLs re-check access |
| Tournament fixtures vs real bookings | `/tournaments/:id/bookings`; scheduler clips to CONFIRMED windows; codes WINDOW_UNCONFIRMED, OUTSIDE_BOOKED_WINDOW, WINDOW_LOST, RESOURCE_UNAVAILABLE, warning UNBOOKED; pitch locked exclusively in apply. DB now enforces one tournament per booking (unique) |
| Tournament withdrawal after start | `EntryWithdrawal`: POSTPONE / TECHNICAL_RESULT (explicit scores) / REPLACEMENT / END_PARTICIPATION; played results never changed |
| Tie-breakers | head-to-head (configured metrics, optional sub-group re-apply) and fair-play (configured card weights) — refuse without configuration. `lots` and draw resolution remain unsupported (not defined in the documents) |
| Post-publication capacity / team edits | safe edits only; below confirmed+holds+offers ⇒ refused; format change with matches ⇒ `MATCHES_EXIST`; non-empty team removal ⇒ `TEAM_REDISTRIBUTION_UNDEFINED` |
| Google / Apple | jose 5.10 (jose 6 is ESM-only and breaks Jest/CJS). RS256, iss/aud/exp/iat, single-use hashed nonce, no e-mail merging, link/unlink with last-login-method protection. No client ids ⇒ 503 `PROVIDER_UNAVAILABLE` |
| Notification retry state | `attempts`, `nextAttemptAt`, `lastError` (class name only), exponential backoff to 60 min, `NOTIFICATION_MAX_ATTEMPTS` |

## 4. Schema and migrations
New migrations (all forward-only, applied on a clean DB by `test:migrations`):
- `20260930091120_finalization_additions` — Event (`autoNextWave`, venue-attention fields), Notification retry columns, MediaAsset/`MediaVariant`, `FeeAmendment` (+ partial unique one pending per obligation), `JobRun`, `RecentSearch`, `AuthNonce`, `TournamentBooking`, `EntryWithdrawal`, partial indexes for invitation deadlines and notification retry.
- `20260930113131_fk_lookup_indexes` — index review result: eight foreign keys had no leading index (`Event.bookingId`, `Event.venueId`, `Booking.configurationId`, `PitchOccupancy.calendarBlockId`, `PitchConfigurationPart.partId`, `ClubEntry.clubId`, `PostMedia.mediaId`, `ModerationAction.reportId`). `Event.bookingId` is on the hot path of booking cancellation.
- `20260930120000_tournament_booking_single_owner` — unique `TournamentBooking.bookingId`.

## 5. New endpoints (all in OpenAPI)
`POST /games/:id/booking` · `POST|GET /games/:id/fee-amendments` · `GET /payments/amendments/mine` · `POST /payments/amendments/:id/accept|reject|cancel` · `POST|GET|DELETE /search/recent`, `DELETE /search/recent/:id` · `GET /media/:id/url?variant=` · `GET|POST|DELETE /tournaments/:id/bookings` · `POST /tournaments/:id/entries/:eid/withdrawal` · `POST …/withdrawals/:wid/resolve` · `GET /tournaments/:id/withdrawals` · `POST /auth/nonce`, `/auth/link/google|apple`, `GET /auth/identities`, `DELETE /auth/identities/:id` · `POST /admin/maintenance/run`, `GET /admin/maintenance/runs` (PLATFORM grant `admin.maintenance.run`).

## 6. Background processes
One job: `MaintenanceService.runOnce`. It expires holds/invitations/offers, promotes the waitlist, sends the automatic next wave, auto-cancels under-filled games, expires booking holds, dispatches pending/retryable notifications and purges expired idempotency keys and nonces. Triggers: built-in interval (`MAINTENANCE_INTERVAL_SECONDS`, default 30, `0` disables), `npm run maintenance:tick` (external scheduler), `POST /v1/admin/maintenance/run`. No state is held in memory: everything is derived from database timestamps, a `pg_try_advisory_xact_lock` makes parallel instances collapse into one (`SKIPPED`), every run is a `JobRun` row, every step is idempotent. Restart-safety is covered by `finalization-games.e2e-spec.ts`. The old in-process timers in games and notifications were removed.

## 7. Tests (pre-contract-addendum snapshot)
The finalization slice itself added coverage to the 40-suite / 325-test baseline: finalization-games (auto wave, capacity, amendment-required, AC-40, retry), bookings-venue-attention (6), fee-amendments (7), media-processing (10), search-recent (7), auth-providers (+unconfigured, nonce), tournaments-bookings, tournaments-withdrawals, tournaments-tiebreakers, throttle (429, forged `X-Forwarded-For`, `TRUST_PROXY=true` refused), env spec. The contract addendum below brings the verified total to 42 suites / 337 tests. `BACKEND_ACCEPTANCE_MATRIX.md` names the exact suite/scenario per row.

## 8. Concurrency verification (real PostgreSQL)
Covered by parallel tests, all green in the final run: last seat (one winner), waitlist offer acceptance, booking overlap (exclusion constraint, six parallel), cash received twice (one receipt), fee-amendment single pending + acceptance, maintenance runs in parallel (one executes, others SKIPPED), nonce single use (6 parallel consumes ⇒ 1), Apple/Google parallel first sign-in, recent-search duplicates, tournament apply vs foreign booking (no overlap or flagged `RESOURCE_UNAVAILABLE`), ownership transfer. Nothing relies on in-memory locks.

## 9. Security review findings
- Raw SQL: tagged templates only, all parameterised; no `*Unsafe`.
- BOLA: every new object id goes through `PolicyService` (amendments, bookings attach, withdrawals, identities return 404 for foreign ids, recent searches are per-user and re-resolved through visibility ⇒ `{unavailable:true}`).
- Leakage: identity DTO has no subject/token; audit metadata holds provider name only; notification `lastError` stores the error class name; pino request serializer strips query strings (media signed tokens).
- Media: canonical original re-encoded without metadata; signed variant URLs re-check access every call.
- Rate limiting: global throttler, tight limits on auth; **per process only** (OPEN #28). Forged `X-Forwarded-For` does not evade the limit by default; `TRUST_PROXY` must be explicit (hops or subnets), `true` is refused at startup.
- Idempotency replay: claim and stored response live in the work transaction.
- Fixed in this stage: `FK` index gap; unique booking-per-tournament enforced in the database instead of the service only.
- `npm audit`: findings are in transitive dependencies of @nestjs/swagger, js-yaml, mysql2 and prisma's config chain (dev tooling); none in sharp or jose. Not fixable without breaking upgrades.

## 10. pg "client is already executing a query" warning
Traced with `--trace-deprecation`. The stack is `PgTransaction.queryRaw` ← Prisma `client-engine-runtime` `interpretNode` → `Array.map`: Prisma's own query interpreter fires the child queries of a relation load in parallel on the single connection of an interactive transaction. It is not our code, has no functional effect on pg 8.23 (queries are queued), and pg will remove the behaviour in 9.0. Not fixable locally without dropping nested `include` in transactions; **TECH_DEBT_NON_BLOCKING** — re-check when Prisma ships an adapter update, before moving to pg 9.

## 11. Remaining items, one class each
| Item | Class |
|---|---|
| Casual-game cash receiver rule (row 1) | BLOCKED_PRODUCT_DECISION |
| Recommended-feed ranking algorithm (2), rating weights (6), badge criteria (5) | BLOCKED_PRODUCT_DECISION |
| Team redistribution rule when removing a non-empty team (20) | BLOCKED_PRODUCT_DECISION |
| Player rejects a new fee; raise from free; reduction below received (25, 26) | BLOCKED_PRODUCT_DECISION |
| Refund of paid fees on post-start withdrawal; new club after start (23); lots / draw resolution (14) | BLOCKED_PRODUCT_DECISION |
| Deposits, refund, weather (8); divisible-pitch rules (7); support recovery proof (4) | BLOCKED_PRODUCT_DECISION |
| Google / Apple client ids | BLOCKED_EXTERNAL_CREDENTIALS |
| Push provider (FCM/APNs) | BLOCKED_EXTERNAL_CREDENTIALS |
| Production media storage / CDN / Range | BLOCKED_EXTERNAL_INFRASTRUCTURE |
| Shared rate-limit store across instances | BLOCKED_EXTERNAL_INFRASTRUCTURE |
| Real venue data / pilot import (10) | BLOCKED_PRODUCT_DECISION |
| HEIC uploads | TECH_DEBT_NON_BLOCKING (clients convert) |
| pg concurrent-query warning | TECH_DEBT_NON_BLOCKING |
| npm audit transitive findings | TECH_DEBT_NON_BLOCKING |
| Typed stage columns for head-to-head / fair-play settings (currently in stage config JSON) | TECH_DEBT_NON_BLOCKING |
| Venue-needs-attention, amendment, recent-search and withdrawal screens | MOBILE_IMPLEMENTED; web/provider sign-in remain CLIENT_REQUIRED |
| Whistle icon, keyboard and remaining reset/filter polish (AC-01/02/07/10/11/21/22/24/25/50) | PARTIAL_CLIENT; supported game filters and web reset are implemented, device/accessibility polish remains |
| Galaxy S24 Ultra checks S24-01…14; push and geolocation permissions | DEVICE_REQUIRED |
| Everything else implementable in the backend | COMPLETE |

No implementable gap is placed in a BLOCKED class.

## 12. Notes for clients
`lets_go_mobile` had no `openapi-typescript` dependency; it was added as a dev dependency (installed with `--legacy-peer-deps` because of the Expo TypeScript 6 peer range) so that `npm run api:generate` works; the generated `src/api/schema.d.ts` was overwritten in both clients. Both typecheck.

## 13. Test-suite stability (found and fixed during final validation)
Repeated full runs exposed flakes; all were test or configuration defects, none a product bug:
- **PostgreSQL `too many clients`**: 16 jest workers × default pool of 10 exceeded `max_connections=100`. Added `DB_POOL_MAX` (default 10, documented in README/.env.example), tests use 4, jest `maxWorkers: 8`.
- Tests reading the first page of a shared-database list (organiser-rating sort, moderation queue, recovery cases) now page through cursors until their own row appears.
- Media variants are now ordered deterministically (width, then thumb before card).
- Signed-URL tamper test flipped the last base64url character, which can carry unused bits; it now alters a character inside the token.
Final: three consecutive full runs 40 suites / 325 tests green; `test:migrations` passed.

## 14. Addendum — contract fixes found by the mobile client (2026-10-01)
The freeze stayed in force except for concrete contract defects proven by the generated client. Backend now: **42 suites / 337 tests** (lint, typecheck, build, `test:migrations` green), 291 paths / 338 operations.
- OpenAPI completeness: query DTOs of `users/username-available` and `grants`; response bodies of `me/blocks`, the three `unread-count` endpoints and the invitation-create endpoints; `MyClubInvitationDto` no longer collides with the game DTO; explicit types for nullable strings/numbers and free-form objects. `test/openapi-contract.e2e-spec.ts` (4 tests) guards query parameters, response bodies, bare-object properties and unique operation ids.
- New contract: `PATCH /v1/me/profile` accepts `avatarId` (own READY photo, or `null`); `PostAuthorDto.avatarId`; `TagRequestDto.targetName/targetHandle`; `Idempotency-Key` documented on post create/publish. `test/profile-avatar.e2e-spec.ts`.
- Test hygiene: shared-database list assertions page via `test/support/paging.ts`; a global-count race in `bookings-venue-attention` removed.
- Post media export capability: `PostCapabilitiesDto.canSaveMedia` is false for user-authored posts whose `PrivacyPolicy.externalMediaSharing` is disabled and true when enabled; covered by `test/posts.e2e-spec.ts` and present in the regenerated OpenAPI client schema.
- Club media wiring: `CreateClubDto` and `UpdateClubDto` accept `logoMediaId`/`coverMediaId`; service validation requires the current user’s `READY` `PHOTO` asset, supports `null` clearing, and preserves permission/version/idempotency rules. Covered by `test/clubs.e2e-spec.ts`.
- Product gaps surfaced by the approved boards and **not** implemented (candidates, need a deliberate decision): tournament times/deadlines/extras/payment options, result-confirmation step, draw lots, club-vs-club readiness, results-manager assignment, game mini-league standings, extra game filters, external-booking rental/cash fields. Listed in `MOBILE_IMPLEMENTATION_REPORT.md` §6.
- Permission catalogue vertical slice: authenticated `GET /v1/grants/catalog` with an optional `resourceType` filter now returns the server-owned permission names, applicable scopes, and delegation flags. It is descriptive only and never grants access. Covered by `test/access.e2e-spec.ts` and documented in OpenAPI.

## 15. Specification filter contract addendum (2026-10-01)

- `GameListQuery` now documents and validates `surfaces`, `settings`, `amenities`, inclusive duration bounds in minutes, `minOrganiserRating`, and `radiusKm` with required coordinate validation.
- `GamesService.buildWhere` applies OR inside each CSV group and AND between groups. Pitch filters use existing `Pitch` data; duration uses `Event.startsAt/endsAt`; organiser rating uses the active organiser-rating mean; radius uses existing venue coordinates and excludes unknown coordinates only when radius is requested. Existing privacy/block filtering and keyset/computed sorting remain unchanged.
- Focused game coverage is included in `test/games.e2e-spec.ts`; the final backend run is **42 suites / 338 tests** green, with typecheck/lint/build, six-migration status and 20 migration checks green.

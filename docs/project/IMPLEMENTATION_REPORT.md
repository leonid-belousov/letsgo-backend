# Let'sGo — Foundation Implementation Report (2026-09-30)

Legend: **DOC** = documented requirement · **TECH** = technical implementation decision · **OPEN** = open question.

## 1. Documentation analyzed
- Decisions HTML v1.19 (all 48 sections, text extracted; embedded images not individually inspected).
- Development Handoff rev 1.18 (full).
- Approved UI PDF (74 pages / 73 boards): all captions extracted; boards 2 (Home), 21 (Filters), 37 (Create game) inspected visually and colors sampled. The remaining boards were not viewed individually; their content is covered by the text documents.
- Output: [PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md).

## 2. Important product conclusions
Backend-enforced permissions returned as capabilities (DOC); no OTP, phone/email+password or Google, Apple on iOS (DOC/working); Pay cash → Cash received → Paid, no bank transfer, no gateway (DOC); invited/confirmed/pending/waitlisted/held are distinct states (DOC); atomic last-seat and booking overlap (DOC); first slice = Home → invited game → confirm → Pay cash → Cash received (DOC).

## 3. Architecture
Three independent npm projects; clients depend on the backend API only. Typed clients to be generated from `/docs/openapi.json`.

## 4–5. Projects and structure
- `lets_go_back`: `src/{common/{errors,permissions,pagination,idempotency},config,infrastructure/prisma,modules/health}`, `prisma/`, `docker-compose.yml`, `test/`.
- `lets_go_front`: `src/{api,routes,design,i18n,stores,test}`.
- `lets_go_mobile`: `src/{app/(tabs),app/create,api,design,stores,i18n}`.

## 6. Libraries
- Back: NestJS 11, Prisma 7 + adapter-pg, pg, @nestjs/config, zod, @nestjs/swagger, nestjs-pino, helmet, class-validator/transformer, @nestjs/jwt + passport (foundation only, unused yet), Jest/ts-jest/supertest, ESLint/Prettier.
- Front: React 19, Vite, react-router-dom 7, TanStack Query, react-hook-form, @hookform/resolvers, zod, zustand, Vitest + Testing Library, openapi-typescript.
- Mobile: Expo SDK 57 (RN 0.86), expo-router, expo-secure-store, TanStack Query, RHF, zod, zustand, safe-area-context, expo-image, expo-image-picker, expo-linking, expo-notifications, jest-expo + RNTL. Geolocation and external auth providers remain out of scope; media picker and sharing are implemented where the product flow requires them.

## 7. Configuration created
`.env.example` (all three), strict tsconfig (all), ESLint, Prettier, EditorConfig, .gitignore, READMEs, root README, docker-compose (local Postgres), Prisma config, OpenAPI at `/docs`, error envelope + codes, env validation, log redaction, helmet, CORS allow-list, validation pipe (whitelist).

## 8–10. Commands and results (all executed)
| Check | Back | Front | Mobile |
|---|---|---|---|
| install | ✅ | ✅ | ✅ |
| typecheck | ✅ | ✅ | ✅ |
| lint | ✅ | ✅ | ✅ |
| prettier | ✅ | ✅ | ✅ |
| tests | ✅ 7 | ✅ 5 | ✅ 4 |
| build | ✅ `nest build` | ✅ `vite build` | JS bundle for Android compiled via Metro (6.6 MB) |
| start | ✅ real server + Postgres 16 in Docker: `/health` ok, `/health/ready` `{"database":"up"}`, `/docs` and `/docs/openapi.json` 200, CORS header for :5173 | ✅ Vite served `/` 200 | ✅ Metro `packager-status:running` |
| other | `prisma generate` ✅, `migrate status`: no migrations (expected, no models) | — | `expo install --check` "up to date"; expo-doctor 19/21 |

## 11. Failed / not verified
- expo-doctor: 2 checks failed only because `exp.host` was unreachable (network), not because of project errors.
- No Android emulator/device, no iOS: **no runtime UI verification**, no TalkBack/keyboard/large-font testing. S24-01…S24-14 not executed; nothing claims S24 Ultra compatibility.
- Browser pane declined the localhost URL, so the web UI was checked via HTTP only (not visually).
- `npm audit`: transitive advisories under Prisma tooling (back) and 14 moderate under Expo tooling (mobile); auto-fix would force breaking upgrades (Prisma 8 RC), not applied.
- Prisma migrations dir empty (no models by design).

## 12. Open business questions
See PROJECT_ANALYSIS §29 (ranking algorithm, language list and font, recovery/password policy, casual-game cash receiver, badge criteria, divisible-pitch rules, booking deposit/weather policy, media/push providers, store accounts, Vazisubani manager linking, etc.).

## 13. Technical decisions made by me (TECH)
npm as sole package manager; NestJS **11** (Nest 12 is ESM-only, broke Jest/CJS); Prisma 7 with adapter-pg; zod env validation; class-validator DTOs; TypeScript 5.9 in front (peer ranges of typescript-eslint/openapi-typescript; mobile uses Expo's 6.0); `react-dom@19.2.3` added to mobile to satisfy expo-router peers; error envelope shape and extra codes (`UNAUTHENTICATED, NOT_FOUND, INTERNAL`); liveness/readiness split; Docker Compose Postgres; Android/iOS package id placeholder `com.letsgo.mobile`; light-only theme; system font stack; error codes mirrored by hand until OpenAPI generation; `orientation: default`.

## 14. Taken from documentation (DOC)
Route groups and bottom nav; central "+" actions; error codes; colors/radii/48 dp targets; Pay grey/Pay cash; no dark theme designed; no fixed card height; approved user-facing error texts; capabilities names; idempotency/atomicity/pagination requirements.

## 15. Intentionally NOT implemented
Auth logic, any business entity/schema, invitation/cash flows, all product screens, payment gateway, video analysis, external-career import, store deployment, OAuth credentials, push/media/geolocation. The Vazisubani phone numbers in the docs were not copied into the repo.

## 16. Start commands
```bash
# backend
cd lets_go_back && cp .env.example .env && npm run db:up && npm run dev      # :3000, docs at /docs
# web
cd lets_go_front && cp .env.example .env && npm run dev                      # :5173
# mobile
cd lets_go_mobile && cp .env.example .env && npm start                       # Metro :8081; a/i in the CLI or `npm run android`
```

## 17. Recommended next task
Vertical-slice step 1: backend `User/AuthIdentity/Session` + Prisma migration, password auth (no OTP), capability-returning `/me`; then Event/Participation/Invitation/SeatHold and PaymentObligation/CashReceipt with idempotency keys, tested against AC-04/05/06/31/41/42/43.


---
Update 2026-09-30: the backend implementation stage is documented in BACKEND_IMPLEMENTATION_REPORT.md (the foundation-only statements above are historical).

## Continuation verification — 2026-10-01

The current implementation was re-verified across all three projects after the mobile completion pass:

| Project | Typecheck | Lint | Tests | Build/export |
|---|---|---|---|---|
| `lets_go_back` | clean | clean | 42 suites / 338 tests | `nest build` clean; migrations passed |
| `lets_go_front` | clean | clean | 14 files / 43 tests | `vite build` passed; chunk-size advisory only; OpenAPI client regenerated |
| `lets_go_mobile` | clean | 0 errors / 0 warnings | 39 suites / 216 tests with `--detectOpenHandles` | Android and iOS Expo exports exit 0; Expo only logs a post-export forced-exit message; OpenAPI client regenerated |

Implemented in this continuation: server-authoritative `canSaveMedia` derived from `PrivacyPolicy.externalMediaSharing`, capability-gated media export through the native share sheet, organiser navigation from game cards, club logo/cover upload controls backed by the real media pipeline, and Jest teardown/warning fixes. Direct gallery insertion, physical Samsung/iOS/TalkBack checks, provider credentials, push delivery, production media/CDN, and unresolved board-only product decisions remain explicitly open.

Full-repository `prettier --check` is not clean because of pre-existing documentation/config/generated-schema files (back: 10, front: 2, mobile: 11 including graph cache). Changed source files and the implementation plan pass targeted Prettier checks; no unrelated formatting sweep was applied.

### Continuation 2 — web auth and club media contract (2026-10-01)

- Web credential sign-in/sign-up now calls the real backend, keeps access/refresh tokens memory-only, refreshes once on 401, and guards incomplete profiles with `GET /v1/me`.
- The incomplete-profile guard now opens a real `PATCH /v1/me/profile` form for nickname, username, date of birth, city, and bio; the flow is covered by a page-level test.
- Backend club create/update now accepts only the owner’s `READY` `PHOTO` assets for `logoMediaId`/`coverMediaId`; `null` clears them, with optimistic versioning and permission checks preserved.
- OpenAPI schemas were regenerated in both clients. Direct gallery insertion, provider credentials, physical-device checks, and product-decision gaps remain outside this code-only continuation.

Scope note: `lets_go_front` now has real auth/profile flow plus Home games feed and game detail/join flow. Other business routes listed in `src/routes/router.tsx` remain explicit `PlaceholderPage` entries and are not reported as completed here.

### Continuation 3 - live Android emulator verification (2026-10-01)

- Started AVD `Pixel_9a` (Android 16), installed the debug APK through `npm run android`, and verified the backend health endpoint returned 200.
- Ran the synthetic sign-up/profile flow, native date picker, Home, game details/request-to-join, filters, search, Discovery, Activity/Messages, Profile, Settings/Privacy, Sign-in & devices, Notifications, notification preferences, create-game wizard, eight deep links, font scale 2.0 and landscape smoke checks.
- The app process remained `MainActivity` throughout the deep-link and orientation checks. The emulator stylus prompt was dismissed; no application crash or red screen was observed.
- The club-create screen now renders logo/cover controls; both opened Android 16 Photos picker and cancellation returned to the form without application errors. No real image was available in the empty emulator gallery, so a complete upload/finalize against a selected file was not claimed.
- One picker tap immediately after Fast Refresh encountered Expo's stale `ActivityResultLauncher`; a force-stop/relaunch and lifecycle-rotation rerun passed, so this is tracked as a dev-session lifecycle note rather than a clean-launch crash.
- The synthetic test account retains one pending join request because the leave confirmation was intentionally dismissed; no external or physical-device test is claimed.

### Continuation 4 — remaining vertical slices and final verification (2026-10-01)

- Backend added the authenticated, server-owned permission catalogue `GET /v1/grants/catalog` with optional `resourceType` filtering. It is descriptive only and never grants access; access tests cover authentication, filtering, and exclusion of platform-only permissions from club results.
- Web Home now renders the typed games feed from the backend; `/games/:gameId` renders a real game detail page with join/request-to-join/leave mutations, query invalidation, and an `Idempotency-Key`. The route-level mutation is covered by the frontend test suite.
- Mobile tournament sponsor URLs now have a guarded browser action: only `http`/`https` values are opened after `Linking.canOpenURL`; invalid or unsupported values stay in-app.
- OpenAPI was regenerated in both clients: **291 paths / 338 operations**, with unique operation ids.
- Pre-continuation-5 rerun: backend **42 suites / 337 tests**, typecheck/lint/build/migrations green; web **7 files / 20 tests**, typecheck/lint/build green; mobile **38 suites / 210 tests**, typecheck/lint green, Android and iOS Expo exports exit 0.
- Runtime status after verification: backend `/health` returned `{"status":"ok"}`, Metro returned `packager-status:running`, and Android `emulator-5554` remained on `com.letsgo.mobile/.MainActivity`.
- Remaining work is intentionally explicit: product-decision gaps (tournament times/deadlines/extras, draw lots, results-manager and mini-league rules, booking/refund policy), external credentials/providers (Google/Apple, FCM/APNs, production media/CDN), non-Android/iOS simulator and accessibility/device matrices, and web/mobile screens for backend flows not yet represented in the UI. No Samsung-specific compatibility claim is made.

### Continuation 5 — search/filter and server-owned permissions (2026-10-01)

- Web `/search` and `/filters` now use typed `GET /v1/search`, URL-synchronised query/type filters, grouped result cards, and loading/error/empty states. Route tests cover query submission and filter navigation.
- Mobile club role editing now reads `GET /v1/grants/catalog?resourceType=CLUB`; server `resources` and `delegable` flags control known UI rows. Unknown permissions are intentionally omitted until product copy exists, and a catalogue failure uses the previous safe local mapping. The endpoint remains descriptive and never grants access.
- Latest client verification before the filter-contract pass: web **8 files / 22 tests**, typecheck/lint/build green; mobile **38 suites / 212 tests**, typecheck/lint green. Backend was **42 suites / 337 tests** and **291 paths / 338 operations**.

### Continuation 6 — specification filter contract and final regression (2026-10-01)

- The approved filter boards and hand-off require pitch surface/setting/facilities, duration, organiser-rating threshold, and distance. The backend now exposes typed `GET /v1/games` query fields `surfaces`, `settings`, `amenities`, `durationMinMinutes`, `durationMaxMinutes`, `minOrganiserRating`, and `radiusKm`; CSV groups are OR, groups are AND, and radius requires validated `lat`/`lng`.
- Mobile Home filters now serialize those fields through the generated client, include active chips/no-match relaxations, and reset them without restoring stale amenity text. Web GamesFeed exposes the same supported fields, native geolocation/radius, and a reset action that preserves city and sort.
- Final regression after starting the local Postgres service: backend **42 suites / 338 tests** passed; `typecheck`, lint, build, migration status and **20 migration checks** passed. Web **8 files / 24 tests** passed with typecheck/lint/build. Mobile **39 suites / 216 tests** passed with typecheck/lint and targeted Prettier. Attempts made while Postgres was stopped were not counted as successful checks; all reported green results were rerun after the service was restored.
- Runtime remains explicit: backend `/health` returned 200; Metro/emulator checks are reported in the mobile report. Pixel_9a Android 16 evidence is not a Samsung/physical-device claim.
- The fresh Android debug rebuild installed and opened `MainActivity` on `emulator-5554`; Home and the new filter controls were visible through UIAutomator, with no fatal or ReactNativeJS error in the captured log.

### Continuation 7 — web profile and privacy settings (2026-10-01)

- Replaced the web placeholders for `/me` and `/settings` with real pages. Profile edits use `PATCH /v1/me/profile` and optimistic `version`; settings use `GET/PATCH /v1/me/privacy`, list active sessions from `GET /v1/auth/sessions`, and revoke non-current sessions with `DELETE /v1/auth/sessions/{id}`. The current session can be signed out locally.
- Added route tests for profile save, privacy save, and session revocation. Web verification is now **9 files / 26 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- At this checkpoint, the other business routes were still explicit `PlaceholderPage` entries; the later Continuation 8 and 9 sections record the discovery, entity-detail, and create-game slices that followed.

### Continuation 8 — web discovery (2026-10-01)

- Replaced the `/discovery` placeholder with typed cards from the existing backend list contracts: `GET /v1/clubs`, `GET /v1/venues`, and upcoming `GET /v1/tournaments?when=UPCOMING`. Search applies to the contracts that support `q` (clubs and venues); each card links to the existing entity route.
- Replaced the club detail placeholder with a typed `/v1/clubs/{id}` page and capability-driven join/request/cancel/leave action using an idempotency key. The route test verifies the join request and header.
- Added route tests for all three discovery list responses, search serialization, and club membership. Web verification is now **10 files / 28 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- Added read-only typed tournament and venue detail pages (`GET /v1/tournaments/{id}` and `GET /v1/venues/{id}`), including the venue’s published pitch list. Added route coverage for both details. Web verification is now **10 files / 29 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- Cursor “load more”, create club/tournament flows, pitch detail/booking, and the remaining chat/activity/payment routes are still explicit follow-up slices; the discovery page does not fabricate unsupported fields.

### Continuation 9 — web create-game flow (2026-10-01)

- Replaced the `/games/new` placeholder with a typed create form. It sends the required `CreateGameDto` fields to `POST /v1/games`, converts native `datetime-local` values to UTC ISO instants, includes a fresh `Idempotency-Key`, and navigates to the returned game id. Venue/booking selectors are intentionally not invented because their selection contracts are separate endpoints.
- Added a route test for payload defaults, publication flag, idempotency header, and post-create navigation. Web verification is now **10 files / 30 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.

### Continuation 10 — web club and tournament creation (2026-10-01)

- Replaced `/clubs/new` and `/tournaments/new` placeholders with typed forms. They submit `CreateClubDto`/`CreateTournamentDto` to the real POST endpoints, include idempotency keys, validate required fields, and navigate to the returned entity detail route.
- Added route tests for both payloads, headers, and post-create navigation. Web verification is now **11 files / 32 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- Remaining placeholders are now limited to public profiles, pitch detail/booking, chat, activity, and payments; external credentials and board-only product decisions remain separate.

### Continuation 11 — web public profiles (2026-10-01)

- Replaced `/people/:userId` with a viewer-aware read-only page backed by `GET /v1/users/{id}`. It renders only fields present in `PublicProfileDto` and does not infer private data or invent follow/message actions.
- Added route coverage for the typed public-profile response. Web verification is now **12 files / 33 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- Remaining web placeholders are pitch detail/booking, chat, activity, and payments; their mutations depend on separate booking/social/payment flows.

### Continuation 12 — web pitch details and booking request (2026-10-01)

- Replaced `/pitches/:pitchId` with typed pitch details from `GET /v1/pitches/{id}` and a booking link when the server marks the pitch bookable.
- Replaced `/bookings/new` with a contract-safe booking request form. It loads the pitch configuration and latest terms, sends `CreateBookingDto` to `POST /v1/bookings` with an idempotency key, and shows the returned booking status.
- Added route coverage for pitch rendering/linking and booking payload/terms. Web verification is now **13 files / 35 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean.
- Remaining web placeholders are chat, activity, and payments; cursor pagination and richer booking management remain follow-up work.

### Continuation 13 — web chat, activity, and payments (2026-10-01)

- Replaced the last web route placeholders with typed pages: `/chat` lists conversations via `GET /v1/chat/conversations`, `/activity` uses `GET /v1/activity`, and `/me/payments` uses `GET /v1/me/payments`.
- Chat now opens a conversation, loads `GET /v1/chat/conversations/{id}/messages`, marks it read, and sends text through the typed POST endpoint with an idempotency key. Activity and payment pages display only server-provided fields.
- Added four inbox route tests. Web verification is now **14 files / 40 tests** passed; typecheck, lint (`--max-warnings 0`), Prettier on changed files, and Vite build are clean. `router.tsx` no longer contains any `PlaceholderPage` route.
- Remaining work is pagination/load-more, booking management actions, payment mutations, and product/provider integrations.

### Continuation 14 — web payment actions (2026-10-01)

- `PaymentsPage` now renders `Pay cash` and `Confirm cash` only when the server-provided `ObligationCapabilitiesDto` allows those actions.
- `Pay cash` calls `POST /v1/payments/obligations/{id}/pay-cash`; `Confirm cash` calls `POST /v1/payments/obligations/{id}/cash-received` with the entered amount and a fresh `Idempotency-Key`.
- Online payment remains hidden because the contract marks `canPayOnline` false at launch (no gateway). Correction/refund UI remains unimplemented until a product flow is specified.
- Added a route test covering both cash mutations and idempotency. Web verification is now **14 files / 40 tests** passed; typecheck, lint (`--max-warnings 0`), targeted Prettier, and Vite build are clean.
- Backend and mobile source were not changed in this continuation; their latest verified baselines remain **42 suites / 338 tests** and **39 suites / 216 tests** respectively.

### Continuation 15 — web booking management and pagination (2026-10-01)

- Added `/bookings`, backed by `GET /v1/bookings/mine`, with server-side status filtering and cursor-based `Load more` pagination.
- Active user bookings expose a confirmed-by-server cancellation action through `POST /v1/bookings/{id}/cancel`, with a fresh `Idempotency-Key`; terminal statuses do not render the action.
- Profile now links directly to My bookings and My payments so both personal flows are discoverable.
- Added coverage for first-page rendering, cursor loading, cancellation payload/header, and route data flow. Web verification is now **14 files / 42 tests** passed; typecheck, lint (`--max-warnings 0`), and targeted Prettier pass; Vite build passes with only the non-fatal bundle-size advisory noted below.
- Added capability-gated venue-staff booking inbox on pitch details: cursor listing via `GET /v1/pitches/{id}/bookings` and confirm/hold/reject/complete mutations through the typed booking commands. These controls render only when the pitch reports `canManageBookings`.
- Final regression in this pass: backend **42 suites / 338 tests** passed in 323.654 s; front **14 files / 42 tests** passed; mobile **39 suites / 216 tests** passed; all three typechecks/lints passed; Android and iOS Expo exports both completed successfully (Expo emitted its known forced-exit notice after export). Vite emitted only its non-fatal bundle-size advisory (500.38 kB minified JS chunk).

### Continuation 16 — web pitch calendar and venue tools (2026-10-01)

- Capability-gated pitch manager tools now read the next seven days from `GET /v1/pitches/{id}/calendar`.
- Venue managers can add external bookings through `POST /v1/pitches/{id}/bookings/external`, create blocks through `POST /v1/pitches/{id}/blocks`, and remove blocks through `DELETE /v1/pitches/{id}/blocks/{blockId}`. All writes use the server contract and refresh the calendar/booking inbox.
- The manager route test covers calendar loading, external booking payload/idempotency, block payload, and booking decision actions. Web remains **14 files / 42 tests** passed; typecheck/lint/targeted Prettier pass; Vite build passes with the non-fatal 503.90 kB minified chunk advisory.

### Continuation 17 — web notifications (2026-10-02)

- Added `/notifications`, backed by cursor-paginated `GET /v1/notifications`, with unread rendering and `POST /v1/notifications/read`.
- Notifications are discoverable from the profile page; the route test covers server payload rendering and mark-read request serialization.
- Frontend verification is now **14 files / 43 tests** passed; typecheck, lint, targeted Prettier, and Vite build pass. The only build message is the existing non-fatal bundle-size advisory (505.44 kB minified JS chunk).

### Continuation 18 — notification preferences (2026-10-02)

- The web notifications screen now reads server-owned preferences from `GET /v1/notifications/preferences` and updates each category with `PUT /v1/notifications/preferences`.
- No categories or defaults are invented client-side; the UI renders exactly the preference rows returned by the backend.
- Full frontend verification remains **14 files / 43 tests** passed; typecheck/lint/targeted Prettier pass; Vite build passes with the non-fatal 506.38 kB minified chunk advisory.

### Continuation 19 — read-only scope re-audit (2026-10-02)

This is a documentation/code-graph audit, not a fresh test run. Latest test/build results remain those recorded above and in the backend/mobile reports.

- **Product decisions before implementation:** `OPEN_DECISIONS.md` still identifies unresolved policies for tournament/game board-only behavior (#30), cash receiver (#1), ranking/ratings/badges (#2/#5/#6), booking deposits/refunds/weather (#8), languages/theme (#11), support/legal handling (#16), team redistribution (#20), tournament withdrawal/refunds (#23), and fee-change outcomes (#25/#26). No client behavior should be invented for these.
- **Backend product-contract gaps:** tournament times/deadlines/extras/payment options/result confirmation/draw resolution; club-vs-club readiness/invites; results-manager assignment and game mini-league standings; conditional/guaranteed booking type; external-booking rental/cash fields; and pitch-close refund amounts remain absent from the approved backend/client contract. `MOBILE_IMPLEMENTATION_REPORT.md` §6 and `OPEN_DECISIONS.md` #30 are the source of truth for this list.
- **External services/infrastructure:** Google/Apple sign-in still needs credentials; push delivery needs FCM/APNs configuration; production media storage/CDN and shared rate-limit storage need providers/infrastructure. Current backend rate limiting is in-memory per process (`BACKEND_FINALIZATION_REPORT.md` §9 and §11).
- **Client/product gaps:** mobile acceptance rows 21–22 (external social links and return state from an external editor) are OPEN; localization beyond English is also OPEN (#11). The frontend's latest reported unit/build checks are green, but no browser-based end-to-end run against the live backend is recorded for the continuation-18 notification-preferences flow.
- **Device/runtime evidence still missing:** physical Android and iOS runtime/accessibility/lifecycle checks, including TalkBack, split-screen, process death/offline recovery, partial photo access, large media, and performance/memory. Existing Android evidence is from a Pixel_9a Android 16 emulator; iOS evidence is JS export only. The acceptance matrix still labels its hardware section `S24-*`; treat that only as a legacy checklist, not a Samsung requirement or an S24 acceptance claim.
- **Non-blocking technical debt:** PostgreSQL/Prisma concurrent-query deprecation warning, transitive `npm audit` findings, HEIC upload support, tournament stage settings stored in JSON, and the web bundle-size advisory remain documented. The Vite advisory is not a failed build.
- **Latest recorded automated baseline (not rerun in this audit):** backend 42 suites / 338 tests; frontend 14 files / 43 tests; mobile 39 suites / 216 tests. Typecheck/lint/build or Expo exports are reported green in the preceding continuation entries.

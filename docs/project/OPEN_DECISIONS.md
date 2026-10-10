# OPEN Decisions

Unresolved *product* questions. The backend is built so each can be decided later without restructuring; none is silently decided. Config keys are TECH switches, not product decisions.

| # | Question | Source | Backend handling now |
|---|---|---|---|
| 1 | Who receives cash for a **casual game without a club** | Decisions §17/§45 | No implicit receiver. Env `CASUAL_CASH_RECEIVER_POLICY` = `EXPLICIT_ONLY` (default: organiser must explicitly grant `event.cash.confirm`) or `ORGANISER`. |
| 2 | Home "Recommended" ranking algorithm and weights | §4/§13 | `RECOMMENDED` sort is deterministic placeholder = starting soon then id; documented; no scoring invented. |
| 3 | Password policy specifics (length/complexity/breach list) | §37/§46.18 | Only minimum length 8 (config) — TECH floor, not a product rule. |
| 4 | Support-assisted account recovery verification | §46.18 | Case workflow exists (staff records verification note, issues single-use token); *what* counts as sufficient proof is not encoded. |
| 5 | Badge criteria (Fair play, Leadership); referee/organiser card metrics | §5/§46.17 | Manual award by staff/club only (`Achievement`); no auto-criteria. |
| 6 | Rating weights / venue vs pitch aggregation | §9/§15 | Simple mean (WORK §46.17); venue aggregate = mean of pitch ratings not defined → exposed per subject only. |
| 7 | Divisible-pitch rules/UI | §10 | Data model (parts + configurations + DB exclusion) only; no format-rule semantics. |
| 8 | Deposits, free-cancel window, refund and weather policy | §8/§41 | Booking states + `holdExpiresAt`; no automatic deposit/refund/weather cancellation. Refund due/Refunded records exist. |
| 9 | Production **provider** for media storage/CDN/Range and for push delivery | §18/§46.12 | RESOLVED IN CODE, provider OPEN: `MediaStorage` and `NotificationDeliveryProvider` abstractions; local disk + log providers only. EXIF stripping, orientation and WebP `thumb`/`card` variants are implemented provider-neutrally (sharp). Choosing S3/CDN/FCM/APNs needs credentials/infrastructure. |
| 10 | Real venue hours/prices/availability; pilot import (Sprenty/Vazisubani) | §36–§48 | No seed data; rules per pitch entered by managers. Real phone numbers not stored. |
| 11 | Language list, font, dark theme | §3 | Not backend. |
| 12 | Default for "Open this place if invitation expires" (club invites) | §30.5 | Field exists, default `false`. |
| 13 | Whether waitlisted/pending users may read game chat | §46.14 | Working rule implemented: only confirmed + staff read/post; others receive announcements via activity. |
| 14 | Playoff draw resolution beyond the recorded shoot-out; lots (`lots`) tie-break | §44.3 | Head-to-head (configured metrics, optional sub-group re-apply) and fair-play (configured card weights) are implemented and refuse to run without their configuration. Unknown criteria such as `lots` are rejected; ties beyond the configured criteria are flagged and ordered only by the organiser's recorded `tie-resolution`. |
| 15 | Google/Apple **credentials** (client ids) and web token storage | §37 | Verification logic (jose, JWKS, iss/aud/exp/nonce, no e-mail merging) is implemented and tested with local keys. Without `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS` the endpoints answer 503 `PROVIDER_UNAVAILABLE` (no fake success). |
| 16 | Support-visible report handling SLA / retention periods / legal text | §46.18 | Not encoded. |
| 17 | Waitlist offer declined/expired: does the player keep their queue position? | Handoff §14 silent | WORK choice implemented: decline or expiry removes the player from the queue; offers reserve the seat. |
| 18 | Closed / invite-only games (mentioned, never specified) | Decisions §19/§46.9 | Published games are listed publicly; invitations are per-user. No private-event model invented. |
| 19 | *(closed)* Automatic next wave at the priority deadline | Handoff §3 | IMPLEMENTED: persistent maintenance job (`MAINTENANCE_INTERVAL_SECONDS`, `npm run maintenance:tick`, `POST /v1/admin/maintenance/run`); per-game flag `autoNextWave`. |
| 20 | How to **redistribute** confirmed players when a team is removed or capacity shrinks below confirmed people | Decisions §12 | Safe edits are implemented (grow, shrink above confirmed+holds, empty-team removal). Removing a non-empty team is refused with 409 `TEAM_REDISTRIBUTION_UNDEFINED`. |
| 21 | *(closed)* Price change after players confirmed | Handoff §16 | IMPLEMENTED as a fee amendment needing each player's acceptance (`/v1/games/:id/fee-amendments`). Consequences of a refusal are rows 25/26. |
| 22 | Rating author visible to recipient; password re-entry for DELETE /me; null opening hours meaning; removed member self-rejoin | agent assumptions | Conservative defaults: no author shown, no re-entry, unrestricted, re-invite required. |
| 23 | Tournament: what a **new** club may do after start; refund of paid fees on post-start withdrawal; published change of format/price/age | Decisions §24/§44 | Withdrawal after start is implemented as a mechanism (postpone / technical result with explicit scores / replacement of an existing accepted or pending entry / end of participation). Paid fees are left untouched, no automatic refund. Rule fields stay locked once clubs entered. |
| 24 | *(merged into row 9)* | | |
| 25 | A player **rejects** a proposed fee change: must they leave the game, keep the old fee, or is the organiser asked to decide? | Handoff §16 / Decisions §17 | Nothing automatic. Amendment becomes REJECTED, the obligation keeps its old amount, the proposer is notified; the organiser can remove the player or propose again. |
| 26 | Fee change while nobody owes yet: game was **free** (no obligation exists) and the price is raised; and a **reduction** below what was already received | Handoff §16 | Free → paid: confirmed players have no obligation, so no amendment is created (they owe nothing until they re-join); price applies to new joiners only. Reduction accepted after payment: excess is recorded as REFUND_DUE (no money considered moved) — refund policy itself stays OPEN (row 8). |
| 27 | HEIC/HEIF uploads | §18 | Not accepted: sharp cannot decode HEVC. Clients convert to JPEG/PNG/WebP or a provider that decodes HEIC is chosen. |
| 28 | Rate-limit storage across several instances | TECH | Limits are per process (in-memory). A shared store (Redis) needs infrastructure; `THROTTLE_STORAGE` currently supports `memory` only. |
| 29 | Tournament booking windows: should a tournament without attached bookings be allowed to schedule? | Decisions §24 | Allowed with a non-blocking `UNBOOKED` warning, but foreign bookings/blocks on the pitch always block (`RESOURCE_UNAVAILABLE`). |
| 30 | Board-only tournament/game capabilities with no backend field: tournament start/end times, registration & squad deadlines, extras, payment options, result-confirmation step, club-vs-club readiness, results-manager assignment, game mini-league standings | Approved UI boards 33, 36, 45, 53–66 | Not implemented on backend or mobile; the client shows only what the API supports. Needs a product decision before any backend work (`MOBILE_IMPLEMENTATION_REPORT.md` §6). |

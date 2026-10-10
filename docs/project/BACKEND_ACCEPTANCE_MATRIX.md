# Backend Acceptance Matrix (AC-01 … AC-52)

Status values: **IMPLEMENTED_BACKEND** (backend behaviour exists and is covered by an automated test) · **CLIENT_REQUIRED** (needs UI work; backend supplies the data) · **DEVICE_REQUIRED** (needs an Android/iOS run) · **OPEN** (product decision unresolved) · **NOT_APPLICABLE_BACKEND**.
Tests live in `lets_go_back/test/*.e2e-spec.ts` (real PostgreSQL).

| AC | Scenario | Status | Backend evidence |
|---|---|---|---|
| 01 | Whistle icon parity Home/Details | CLIENT_REQUIRED | API exposes `refereeIncluded` + `refereeAssigned` separately (games) |
| 02 | Invitation frame covers only the invited game | CLIENT_REQUIRED | `GET /games/invitations/mine` returns one game per invitation (vertical-slice) |
| 03 | Invitation outside filters pinned with explanation | IMPLEMENTED_BACKEND | `matchesFilters` flag (games.e2e “feed … pinned + flagged”) |
| 04 | Expired/cancelled ⇒ old Confirm dead, pin removed | IMPLEMENTED_BACKEND | games.e2e AC-04 + cancellation tests (410 EXPIRED, not in `mine`) |
| 05 | 10 confirmed of 12, holds 0 ⇒ 10/12, 2 left | IMPLEMENTED_BACKEND | games.e2e AC-05 |
| 06 | Capacity 12, confirmed 10, holds 2 ⇒ 0 public, holder sees own hold | IMPLEMENTED_BACKEND | games.e2e AC-06 |
| 07 | Club required fields keep `*`, Preview active | CLIENT_REQUIRED | clubs validation (required name/username/city) tested in clubs.e2e |
| 08 | Missing city / taken handle ⇒ error, input kept | IMPLEMENTED_BACKEND (server side) | clubs.e2e username race + validation (`CONFLICT` field=username) |
| 09 | Double-submit Create club ⇒ one club | IMPLEMENTED_BACKEND | clubs.e2e same-key + race |
| 10 | Keyboard over last field | DEVICE_REQUIRED | — |
| 11 | Organiser name inside card opens organiser profile | CLIENT_REQUIRED | organiser summary + role stats endpoints |
| 12 | Player/Referee of one person, separate ratings/history | IMPLEMENTED_BACKEND | results.e2e-spec.ts «hidden stats/history…» (per-role `primaryRole` PLAYER vs ORGANISER stats, lines ~227/234); ratings.e2e-spec.ts «upsert, mean rounded…» (ratings per subject role) |
| 13 | Follow private profile ⇒ Requested, history hidden | IMPLEMENTED_BACKEND | social.e2e + privacy.e2e |
| 14 | Favourite changes nothing else, no notification | IMPLEMENTED_BACKEND | social.e2e |
| 15 | Saved post that became closed loses preview/media | IMPLEMENTED_BACKEND | social.e2e / posts.e2e (neutral unavailable) |
| 16 | Public→Private narrows sections/previews | IMPLEMENTED_BACKEND | privacy.e2e (audience cap, posts narrowed) |
| 17 | Private→Public does not reveal followers-only | IMPLEMENTED_BACKEND | privacy.e2e |
| 18 | Approved tag does not widen audience | IMPLEMENTED_BACKEND | posts.e2e mentions |
| 19 | Visitor of owner sees no cash/edit/devices/payments | IMPLEMENTED_BACKEND | privacy.e2e public DTO; payments 404 for strangers |
| 20 | Author forbids export ⇒ no Save media | IMPLEMENTED_BACKEND (flag `externalMediaSharing` stored; enforced in media URL access) | privacy + media suites |
| 21 | Unavailable Instagram/TikTok has no dead action | CLIENT_REQUIRED | — |
| 22 | Return from external editor ≠ “Published” | CLIENT_REQUIRED | — |
| 23 | Three Gios with different handles | IMPLEMENTED_BACKEND | search.e2e (distinct ids, true total) |
| 24 | Zero results, alternatives name the changed filter | CLIENT_REQUIRED | list endpoint supports existing filters plus pitch surface/setting/amenity, duration, organiser-rating and radius predicates; counts remain computable by client per alternative |
| 25 | Reset all keeps city and sort | CLIENT_REQUIRED | — |
| 26 | Sort applies immediately | CLIENT_REQUIRED | all six sorts implemented server-side (games.e2e, games-sorts.e2e) |
| 27 | Finished tournament excluded from Upcoming | IMPLEMENTED_BACKEND | tournaments.e2e-spec.ts «list: Upcoming hides finished/cancelled, Any time shows them» |
| 28 | Main sponsor change updates one mini-label | IMPLEMENTED_BACKEND | tournaments-squads-docs.e2e-spec.ts «sponsors: editable in every stage…, one Main sponsor on the card» |
| 29 | Accepted club with missing consents not “ready” | IMPLEMENTED_BACKEND | tournaments-squads-docs.e2e-spec.ts «documents…» (`ready:false` with `REP_CONSENT_MISSING`, then `ready:true`) and tournaments.e2e-spec.ts «start refuses with a concrete problem list» |
| 30 | New mandatory document version ⇒ new consent, history kept | IMPLEMENTED_BACKEND | tournaments-squads-docs.e2e-spec.ts «new version needs new consent while history stays»; Consent immutability in `npm run test:migrations` |
| 31 | Two answers for the last seat ⇒ one wins | IMPLEMENTED_BACKEND | games.e2e AC-31 (+ waitlist variant) |
| 32 | Under-age sees game, joins only via exception | IMPLEMENTED_BACKEND | games.e2e AC-32 (+ invitation variant) |
| 33 | Waitlist seat = offer with deadline, no auto-join/debt | IMPLEMENTED_BACKEND | games.e2e AC-33 |
| 34 | Revoked parent grant ⇒ dependent gone, independent kept | IMPLEMENTED_BACKEND | access.e2e AC-34 |
| 35 | Club staff cannot manage another club’s pitch/game | IMPLEMENTED_BACKEND | access.e2e AC-35; venues.e2e per-object permissions |
| 36 | Only 30 free minutes: booking refused, block allowed | IMPLEMENTED_BACKEND | bookings.e2e |
| 37 | 90 min with 30-min extension off ⇒ refused; old 90 survives | IMPLEMENTED_BACKEND | bookings.e2e (rules version preserved) |
| 38 | Concurrent overlapping bookings ⇒ one wins | IMPLEMENTED_BACKEND | bookings.e2e (six concurrent, exclusion constraint) |
| 39 | Paid rental not auto-cancelled for low turnout | IMPLEMENTED_BACKEND | game auto-cancel never touches bookings (games.e2e) |
| 40 | Pitch cancelled ⇒ game/chat/history kept, “Venue needs attention” | IMPLEMENTED_BACKEND (state + notification + re-attach) / CLIENT_REQUIRED (banner UI) | bookings-venue-attention.e2e-spec.ts (cancel/reject/hold-expiry set `venueNeedsAttention`, chat/participants kept, finished games untouched); finalization-games.e2e-spec.ts «AC-40 attach booking» clears the flag |
| 41 | Pay cash + approval ≠ Paid | IMPLEMENTED_BACKEND | vertical-slice |
| 42 | Cash received twice ⇒ one receipt | IMPLEMENTED_BACKEND | vertical-slice (same key; new key after paid → 409) |
| 43 | Player cannot mark own payment | IMPLEMENTED_BACKEND | vertical-slice (403; receiver’s own needs another receiver) |
| 44 | Deleting club post keeps confirmed result | IMPLEMENTED_BACKEND | posts.e2e soft delete; results independent of posts |
| 45 | Non-participant / self rating refused | IMPLEMENTED_BACKEND | ratings.e2e-spec.ts «eligibility: finished game, confirmed players only, no self-rating…» |
| 46 | Private participant keeps public protocol | IMPLEMENTED_BACKEND | results.e2e-spec.ts «hidden stats/history return { hidden: true }…» and «unconfirmed protocols are invisible to strangers…» |
| 47 | Known phone without password ⇒ no access | IMPLEMENTED_BACKEND | auth.e2e |
| 48 | No geolocation/push/photo ⇒ working alternative | IMPLEMENTED_BACKEND (server has no dependency on them) / CLIENT_REQUIRED | notification prefs SKIPPED path (comms.e2e) |
| 49 | Report ⇒ ticket, no auto-block | IMPLEMENTED_BACKEND | moderation.e2e-spec.ts «creates a receipt, dedupes identical open reports… never blocks or reveals the reporter» |
| 50 | Network loss keeps draft; targeted retry | CLIENT_REQUIRED (+ server idempotent uploads/publish) | media.e2e retry-no-duplicate; posts idempotent publish |
| 51 | Half of big pitch booked ⇒ parts/whole blocked, other half free | IMPLEMENTED_BACKEND | bookings.e2e whole/half/quarter |
| 52 | Partial cash ⇒ Partially paid + exact remainder | IMPLEMENTED_BACKEND | vertical-slice |

S24-01…S24-14 (Galaxy S24 Ultra): DEVICE_REQUIRED — not executed anywhere.

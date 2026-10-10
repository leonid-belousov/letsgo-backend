# Let'sGo — Project Analysis

Compiled 2026-09-30 from the three source documents:

| Short name | File | Notes |
|---|---|---|
| **Decisions** | `LetsGo_Decisions_2026-09-21 (6).html` (v1.19, 58 MB, text + embedded images) | Read in full (all 48 sections, text). |
| **Handoff** | `LetsGo_Development_Handoff_2026-09-22 (2).md` (rev 1.18, 607 lines) | Read in full. Same material as Decisions §46 without images. |
| **UI PDF** | `LetsGo_Approved_UI_Designs_2026-09-24 (1).pdf` (74 pages, 73 boards) | Every board title/caption extracted; representative boards rendered and inspected visually (Home, Filters, Create game, etc.). Boards are raster mockups of screens already described in the text. |

Legend used throughout: **[DOC]** documented requirement · **[WORK]** working decision stated in the docs (chosen by the product owner's delegate, not separately negotiated) · **[OPEN]** unresolved · **[TECH]** technical decision made by the architect.

Source priority applied: newest explicit correction → newest explicit user decision → Handoff → earlier approved requirements → earlier mockups → sample data. All names, faces, prices, ratings, dates, distances, sponsors (Arunas, Sham, VERTA, GEL 15, 10/12, …) are **illustrative** and must never be hard-coded as product data.

---

## 1. Product overview

Let'sGo is a mobile-first (Android + iOS) football platform for Georgia (Tbilisi first): players find/join/organise casual games and club-vs-club games, run clubs, book pitches, and run tournaments; it has a social layer (profiles, posts, follow, favourites, discovery, share), chat/activity, ratings/achievements, and cash-based fee tracking. **[DOC]** Backend is the source of truth for business state and permissions. Web is not a mandated product ("existence of a web version is not added as an obligation" — Handoff §25), but the brief requests a React web client foundation. **[TECH]**

## 2. Primary user roles

- **Person** — one identity; can act as **Player**, **Organiser**, **Referee** (separate ratings/stats, shared account). Primary role on Home = role with most completed events; tie → keep current; new profile → Player. **[DOC]**
- **Visitor / guest of a profile** — another user (or an unauthenticated visitor of a public link: read-only public overview; Follow/Favourite/Join/Like/Comment/Message need login, then return to the origin object without auto-executing the action). **[DOC]**
- **Club owner / Founder** (Founder = historical creator, Owner = current control) and delegated **club staff** (free-text role titles; titles grant nothing). **[DOC]**
- **Team captain / match-event editor / Results manager** (scoped, delegated). **[DOC]**
- **Tournament chief organiser** (exactly one) + up to two **assistants** (module-scoped). **[DOC]**
- **Club representative** (responsible for club entry in a tournament). **[DOC]**
- **Pitch/venue manager** ("responsible" per pitch). **[DOC]**
- **Let'sGo staff / admin** (venue-request review, moderation, account recovery). **[DOC]**
- **Sponsor** — no account; content managed by organiser. **[DOC]**

## 3. Main product domains

See domain map (§ end of this section). Domains follow the Handoff data-model table (§20) and route registry (§11):

Auth · Users/Profiles · Privacy · Social (Follow, Favourite, SavedPost, Block) · Games/Events (+Participation, Invitations/SeatHolds, Waitlist) · Clubs (Membership, RoleGrant/delegation) · Venues/Pitches · Bookings/Calendar · Tournaments (Stages, Fixtures, Standings, Documents/Consents, Sponsors) · Payments (Obligation, CashReceipt, Adjustment) · Chat · Activity · Posts/Media · Ratings & Achievements · Moderation (Report, AuditEvent) · Admin.

### Domain map (adjusted after reading docs)

```
Auth            AuthIdentity, Session/Device, provider linking, recovery (no OTP)
Users           User, Profile (nickname, @handle, DOB private, city), roles-as-activity (Player/Organiser/Referee)
Privacy         PrivacyPolicy (per-section audiences), Block, visibility resolution
Social          Follow (requested/accepted), Favourite, SavedPost, Mention/TagRequest, Share
Games           Event(kind: casual|club_v_club|training), Match, TeamEntry, Participation, GameRules (min/max/age/auto-cancel)
Invitations     Invitation, SeatHold (priority waves), WaitlistOffer, age exceptions
Clubs           Club, Membership, RoleGrant (can_use / can_pass_on / scope / expiry / source), Club awards, ownership transfer
Venues          Venue, Pitch, PitchPart (divisible pitches), BookingRules, managers, Community pitch, paid-pitch request
Bookings        Booking (requested/held/confirmed/rejected/cancelled/completed), CalendarBlock, ExternalBooking, terms version
Tournaments     Tournament, Stage, Fixture, Standing, RuleDocument/DocumentVersion/Consent, Sponsor/SponsorAsset, ClubEntry
Payments        PaymentObligation, CashReceipt, Adjustment, Refund records (immutable history)
Chat            Conversation, Message (personal, game, club, system)
Activity        ActivityItem (social + operational feed, read state)
Media           MediaAsset (uploading/processing/ready/failed), private delivery, posts
Posts           Post, Comment, Reaction (part of Social/Media boundary — kept in a `posts` module later)
Notifications   push/in-app preferences, reminders, neutral push for closed events
Ratings         Rating (1–5 per author/subject/role/match), MVP vote
Achievements    Achievement (system + Club award), badges (New joiner, Fair play, Leadership)
Moderation      Report, Block interplay, support tickets
Admin           staff review queues, account recovery, catalog import
```
Not invented: wallet, card payments, video analysis, external-career import (explicitly deferred).

## 4. Main entities

`User, AuthIdentity, Session, PrivacyPolicy, Block, Follow, Favourite, SavedPost, Club, Membership, RoleGrant, Venue, Pitch, BookingRules, Booking, CalendarBlock, Event, Match, TeamEntry, Participation, Invitation, SeatHold, WaitlistOffer, TournamentStage, Fixture, Standing, RuleDocument, DocumentVersion, Consent, Sponsor, SponsorAsset, Post, MediaAsset, Mention, Comment, Reaction, Achievement, Rating, MatchEvent, PaymentObligation, CashReceipt, Adjustment, Conversation, Message, ActivityItem, Report, AuditEvent` **[DOC – Handoff §20]**. People and clubs use stable internal IDs plus an entity type; `@username` unique per type, case-insensitive; never a permission key. **[WORK]**

## 5. Authentication requirements

- **No SMS/email codes (OTP)** at signup/login; no "test mode" label, no special login links, no 40-user cap. **[DOC, direct]**
- Working scheme: phone **or** email + password, **or** Google sign-in; **Sign in with Apple** on iOS (Guideline 4.8). Session persisted on device. **[WORK]**
- Unverified contact never becomes "verified"; knowing someone's phone/email must not log into or grant roles. **[DOC]**
- Recovery: linked provider; password change in an active session after current password; or support-verified recovery. No secret questions. **[WORK]**
- Sessions/devices list, sign-out per device / everywhere; contact change, provider linking = audited separate actions; no auto-merge by free-typed email. **[WORK]**
- Complete profile: nickname, @username, DOB, city (geolocation may suggest; refusal → manual). No position/level. **[DOC]**
- Delete account shows owned clubs, events, bookings, money obligations. **[WORK]**
- **[OPEN]** password policy specifics, exact recovery flow with support, legal text/retention periods, Google/Apple credentials (not created).

## 6. Authorization and permission model

- Backend authoritative. Every write checks: authentic actor → action → scope → unexpired → dependent grants → current version/capacity. **[DOC]**
- Responses carry **allowed actions** (`canFollow, canMessage, canJoin, canApprove, canConfirmCash`, …); clients never derive rights from role text or cached buttons. **[DOC]**
- Role titles grant nothing. Grants: **Can use / Can pass on**, scope (club / squad / events / one game), expiry, source grant. Delegation cannot widen scope or lengthen expiry, no cycles, no self-escalation; revoking/expiring a source recomputes dependents; independent grants survive. Massive revoke shows affected people/objects. **[DOC]**
- Money rights are separate: view fees, confirm cash, change terms/amounts, correct records, confirm actual refund. **[DOC]**
- Club role ≠ pitch manager ≠ tournament organiser ≠ final result arbiter of others' games. **[DOC]**
- Tournament: 1 chief + ≤2 assistants with module permissions (applications, schedule, protocols, cash, sponsors). **[DOC]**
- Ownership transfer: owner → specific account → recipient accepts; last owner cannot leave. **[DOC]**
- Publishing as club/tournament/venue requires separate publish permission; actual author logged. **[DOC]**

## 7. Privacy model

- Profile Public/Private; per-section audience (Everyone/Followers/Only me): posts, history/stats/awards/clubs/ratings, city, age (default Only me), followers/following list (hiding also hides counters), messages (Everyone / People I follow / Nobody), invitations, mentions, review-tags, external media sharing. Private caps at Followers. **[DOC]**
- Public→Private narrows immediately; Private→Public does NOT reveal followers-only posts. Manual "Only me" preserved. **[DOC]**
- Never public: full DOB, phone, email, documents, payments, staff notes, exact geolocation. Organisers get only "eligible / exception required". **[DOC]**
- Closed post content must not leak via notification title, search snippet, counter, recommendation, link preview. Private media not on permanently public URLs; photo geo-metadata not published. **[DOC]**
- Official public match protocol keeps its own audience even if a participant later goes private. **[DOC]**
- Block: stops messages/follow/tags, removes social links and recommendations; does not cancel bookings, debts, confirmed squads or official results. **[DOC]**
- Public API models must be separate from private/owner models (no hidden-field-hiding in UI). **[DOC]** → DTO split enforced in backend design. **[TECH]**

## 8. Main navigation / routes

Bottom nav (icons only, no labels): Home · Discovery (compass) · centre "+" · Chat · own avatar. Active tab reflects route. Nav hidden on forms/keyboard. **[DOC]**

Route registry groups (Handoff §11): Authentication (welcome, sign in/up, complete profile, recovery/devices) · Home · Search/All results · Filters/More filters · Sort popover · Discovery (For you/Following/Favourites) · Profiles (person/role/history, my profile/settings, follow requests) · Posts (create/edit/drafts, details/comments/media viewer, tag requests) · Share sheet · Report/Block/Support · Chat/Activity · Games (details/players/waitlist, create/preview/manage, squad/priority/guest search, requests/age exceptions, match details/editor/confirm result, rate) · Clubs (create/preview/page, members/invitations/requests, roles/delegation/log, awards/training, settings/transfer/archive) · Tournaments (page/entry/participation, create/preview/manage, schedule/tables/brackets, documents/consents, sponsors/media) · Venues (venue/pitch/reviews, book pitch/terms/result, booking→create/attach game, my venues/calendar/rules, external booking/block slot, community/paid pitch) · Payments (my payments/cash collection, cancellation/refund record) · Admin.

"+" menu: **Create game, Create club, Create tournament, Book pitch, Create post**; each own route. **[DOC]** Deep links open current object with access re-check; unavailable → neutral "This content isn't available" + Back. **[DOC]**

## 9. Main player flow

Onboarding (Welcome → sign up → Complete profile) → Home (personal card, pinned invitations, feed, Search/Today/Sort/Filters) → Game details → Join / Request to join / Join waitlist / Confirm invitation → Pay cash → (responsible) Cash received → Paid ✓ → Game chat → result/ratings. **[DOC]**

**First vertical slice (Handoff §22):** Home → invited game → invitation details → Confirm → Pay cash → Cash received. Verifies data models and permissions. **[DOC]**

## 10. Game lifecycle

Draft → Preview (no publish) → Published → (registration/joining) → [min-players check / optional auto-cancel] → Started → Finished → Result draft → awaiting confirmation → Confirmed → Corrected (versioned) | Cancelled. **[DOC + TECH naming]**
- Create game: single scrollable form; sticky Preview (grey until required fields valid); Save draft always; black `*` for required, red only on concrete errors. **[DOC]**
- Format 5v5/7v7/9v9/11v11 + More (6v6/8v8/10v10) — quick-four later city-frequency based **[OPEN algorithm]**; teams 2/3/4; substitutes per team; capacity = teams×(on-pitch+subs); minimum confirmed separate from capacity; waitlist separate. **[DOC]**
- Joining: Auto-accept / Approve requests; one age band (Any/35+/40+/45+/50+) + "Allow younger players to request" (individual approval even with auto-accept); age computed at event start in event timezone. **[DOC]**
- Price per player (0 = free), pitch status (Pitch booked / Booking pending / Community pitch), services Referee/Video/Water/Bibs, notes. **[DOC]**
- Auto-cancel: off by default (recommendation); condition + check time; never silent. Paid guaranteed rental never auto-cancelled for low turnout. **[DOC/WORK]**
- Multi-team: Set up teams & schedule page; captains; player moves; 4→3 reduction preserves played results. **[DOC]**
- Results: captains record events; organiser (or Results manager) final-confirms; post-confirmation corrections versioned with reason/log. Match is the sole source of official stats. **[DOC]**
- Timezones: event dates stored with venue timezone; "Tomorrow" never stored. **[DOC]**

## 11. Invitations / reservations / waitlist logic

- Separate states: **invited, confirmed, pending approval, waitlisted, seat-offered, reserved (seat hold)**. **[DOC]**
- Ordinary invitation does not reserve; **priority invitation** holds a seat until deadline ("Your place is held until …"); holds ≤ available capacity. Public free = capacity − confirmed − active holds. **[DOC]**
- Decline releases hold immediately; next wave runs at deadline (or organiser invites earlier); late response never displaces an already-confirmed player; concurrent last seat → server confirms exactly one. Deadline change notifies recipients, cannot expand capacity. **[DOC]**
- Multiple guests in the first wave; Guest and Priority independent flags; guest ≠ permanent club member. **[DOC]**
- Home: active personal invitations pinned above feed (not hidden by filters; "Your invitation · outside current filters"), sorted by nearest deadline then start; no Accept/Decline on compact card; one `event_id` never duplicated. Expired → "Invitation expired" + Join/Waitlist as allowed; old Confirm dead. Reminder once, 1h before deadline, only if unanswered/not revoked. **[DOC/WORK]**
- Waitlist: explicit accept of an offered seat (default 30 min, not past registration end), order = join time with documented manual override; no automatic debt/registration. **[WORK]**
- One person cannot hold confirmed seats on two teams of one event; moves are atomic. **[DOC]**
- Club-v-club: own club + targeted club invites (held) + open seats ("Looking for N clubs") coexist; club Accepted ≠ Ready; invited club not ready; held seat not open. **[DOC]**

## 12. Club lifecycle

Create (name*, unique @username*, city*; optional logo/cover/about/formats; default Public + Approve requests) → Preview → Create club (idempotent, draft per account) → owner page with Invite players / Add first post / Assign roles (no auto-send). Membership: Members / Requests / Invited separate lists; Follow ≠ Join. Roles & delegation (see §6). Club posts (public / members), mentions with review, awards (Club award ≠ system badges), games & trainings (no fake opponent), tournament entries, settings, transfer ownership, archive (shows active obligations, doesn't cancel them). Leaving a club keeps history/payments. **[DOC]**

## 13. Venue and pitch booking lifecycle

- Venue ≠ Pitch. Paid pitches published by Let'sGo team only; users add free **Community pitch** or submit paid-pitch request (name, city+map point, ≥1 photo mandatory) → Let'sGo staff (shown as "Let'sGo", not a person) approve / request details / decline. Contributor ≠ owner. **[DOC]**
- Divisible pitches: physical-resource conflict (whole vs halves vs quarters); manager defines compatibility. **[DOC]**
- Calendar: 30-min grid; "+" → Add booking (External) / Block this slot; booking min **60 min**, step 30 or 60 by per-pitch "Allow 30-min extensions"; start may be :30; server re-validates continuity/hours/step; existing bookings survive rule changes. External booking: Pitch*, Date*, Starts*, Duration*, Name/team*; phone/notes optional staff-only; occupies slot. **[DOC]**
- Booking states: requested / held (visible expiry) / confirmed / rejected / cancelled / completed; "Pitch booked" only with proper confirmation; manual organiser mark ≠ platform verification (source shown). **[DOC]**
- After booking: Create game / Attach existing / Do later; no second booking; hours crossing midnight show "+1 day". Booking cancellation → game "Venue needs attention". **[DOC]**
- Terms/cancellation version stored and accepted before confirmation. **[DOC]**
- **[OPEN]** real venue hours, availability, deposit/free-cancel windows (3 min was an example), weather policy details.

## 14. Tournament lifecycle

Draft → Preview → **Publish (opens registration; not gated on full entries/consents/bookings)** → Registration/Waitlist → Registration closed → **Start (checks clubs, squad eligibility, active pitches, schedule conflicts)** → Live → Finished; also Postponed / Cancelled (distinct). **[DOC]**
- Structures: Groups+playoffs, League, Knockout, Custom stages; byes; season/multi-day with rounds and roster locks; divisions with explicit promotion rules. **[DOC]**
- Reference scenario: 8 clubs, groups A/B of 4, one round; Golden A1–B2, B1–A2 + final; Silver A3–B4, B3–A4 + final; 12+6=18 matches. Scheduler validates per-club rest, transitions, reserve; match length ≠ booking length. **[DOC]**
- Tie-break rules, points (3/1/0 in example only), playoff draw resolution, fair-play weights configured in advance. **[DOC]**
- Documents: multiple files any language, audience Club rep / Players / Both, versioned; each person consents personally; new mandatory version → re-consent, old kept. Club accepted ≠ squad ready. **[DOC]**
- Sponsors: many; organiser picks one "Main sponsor" for the card; editable any time. **[DOC]**
- Club withdrawing after start → per published regulations (postpone / technical result / replacement / end); played results preserved. **[DOC]**
- Tournament card statuses: Registration open, Waitlist open, Registration closed, Starts soon, Live, Finished, Postponed, Cancelled. **[DOC]**

## 15. Payments / Pay cash / Cash received lifecycle

- **Pay** visible, grey, disabled (no payment integration); **Pay cash** active; **no Bank transfer**. **[DOC]**
- Flow: Pay cash chosen → responsible notified in Chat → participation confirmed (separate) → **Cash received** (only authorised receiver) → **Paid ✓** with amount, time, real author. Per obligation (payer + club/team + game/tournament), not global. **[DOC]**
- Obligation types: player fee, club tournament fee, pitch rental — separate. Waitlisted/unfilled seats produce no debt. **[DOC]**
- Player cannot mark themselves Paid; responsible's own fee confirmed by another receiver. Idempotent (double tap/retry = one receipt). **[DOC]**
- Partial: Record partial cash → Partially paid + remainder; overpayment not hidden in wallet. Corrections = new adjusting record with reason; Refund due ≠ Refunded. **[DOC/WORK]**
- Fee changes require notification + acceptance; receipts never rewritten. **[WORK]**
- **[OPEN]** casual game without club: who receives; deposit/refund rules; payment gateway/wallet/Georgian legal model (out of scope).

## 16. Chat and Activity requirements

- Chat: personal, game chat (confirmed + staff; waitlisted/pending get announcements + contact to responsible only), club chat, tournament announcements — separate audiences; system cards (invitations with Confirm/Decline, cash confirmation requests). Send disabled if access lost. **[DOC]**
- Activity: unified social + operational list, reachable from Chat and Discovery bell; viewing does not accept an invitation; Mark all read = read state only; items link to current object; closed-event push neutral by default. **[DOC]**
- Unread red badge on game chat entry. **[DOC]**

## 17. Social functionality

Follow (not following → requested (private) / following (public); cancel request; remove follower), Favourites (private gold star, undo, no notify), Saved posts (bookmark), Join separate; Follow venue vs pitch differ, no feed duplicates; Discovery: For you (freshness/city/connections; no fake AI %), Following, Favourites (All/People/Clubs/Events/Places); categories All/Photos&video/People/Clubs/Tournaments/Pitches; posts (like, comment, share, bookmark, report), mentions/tag requests (Show on profile / Keep off / Remove / Report), stable pagination, "You're all caught up". **[DOC]**

## 18. Media requirements

v1 limits: ≤10 media/post, photo ≤20 MB, video ≤500 MB & ≤5 min, text ≤2000 chars. States uploading/processing/ready/failed with per-file Retry/Remove; failed media never published; no permanent public URLs for private media; strip geo metadata; thumbnails for cards (no full-res decode); videos autoplay muted only in view, off in data-saver. Storage provider **[OPEN]** (not chosen). **[DOC/WORK]**

## 19. Moderation / reporting requirements

Report reasons Spam / Harassment / Inappropriate content / Impersonation / Other + optional text; ticket number returned; no promise of removal; reporter identity never revealed; Block is separate explicit choice; moderator actions carry reason + audit log; support access logged; comment closing/removal within author/moderator scope. **[DOC]**

## 20. Notifications requirements

Push separate from Follow; social updates default to in-app Following (no push per post); own-event/booking notifications have separate settings; neutral push for closed events; invitation reminder 1h before deadline; changes to deadlines/times/fees notify affected people; failed external channels/denied push/geo all have working alternatives. Delivery provider **[OPEN]**. **[DOC/WORK]**

## 21. Search / filter / sort behavior

- Search: exact `@username` first, then nickname; case-insensitive; stale-response cancel; 3–4 previews per type + `View all N` (true N visible to viewer); People/Clubs/Events/Places labelled; private data not indexed; recent searches clearable. **[DOC]**
- Filters: sections Game (Type Casual/Tournament/Club v club; Format) → When → Where (city, distance, venue/pitch) → Price (per player; Free only) → Pitch (setting, surface) → Age (single) → People (organiser; players I follow) → Game extras (Referee, Video, Available spots, Pitch booked) → More filters (duration, organiser rating, facilities). OR within group, AND across. Draft vs applied; live count; Show N results; Reset all (keeps city + sort); zero results shows concrete alternatives with real counts (amber, never red); stale absolute date kept with "This date has passed". Availability = one choice Any/Open spots/Open spots or waitlist. **[DOC]**
- Sort (immediate, popover anchored to button, persisted per account): **Recommended, Starting soon, Nearest, Price: low to high, Organiser rating, Recently added**; ties → start, then stable ID. Label is **Nearest** (superseded "Nearest first"/"Nearest field"). **[DOC]**
- **[OPEN]** Recommended ranking algorithm.

## 22. Mobile-specific requirements

Safe areas / edge-to-edge; keyboard-safe forms with sticky bottom bar above keyboard (no double-inset); Back handling order keyboard → popup → route, unsaved-changes dialog (Save draft / Discard / Continue editing); state survives rotation, split-screen, return from Share/Gallery/Maps/provider sign-in, process death; offline banner with retry, drafts not lost; optimistic UI only for like/favourite; place/booking/role/Paid confirmed by server; submit buttons de-duplicated + server idempotency; video/media lifecycle; deep links; share via system sheet (no fake platform buttons). **[DOC]**

## 23. Android-specific requirements

Android is first priority. Touch targets ≥ **48×48 dp** (icon 20–24 ≠ target; no overlapping invisible padding); TalkBack labels; large font (Android 14 non-linear up to 200 %) and Screen zoom must not clip → cards grow (no fixed height); layouts respond to window width (control widths 320/360/384/412/480), not device name; edge-to-edge (target SDK 35+); gesture and 3-button nav; Samsung Keyboard + Gboard + floating keyboard; multi-window / rotation; tables & calendar may scroll horizontally with sticky headers, cells ≥48 dp; Sharesheet not iOS look; image decoding sized to view; S24-01…S24-14 acceptance plan (**not yet executed on any device**). Samsung Galaxy S24 Ultra is a mandatory acceptance device but nothing may be hard-coded to it. **[DOC]**

## 24. iOS-specific requirements

Touch target 44×44 pt; Sign in with Apple when Google offered (4.8); TestFlight external testing is a distribution channel, not a product mode; UIActivityViewController for share; iOS must stay compatible from day one. No iOS runtime verification exists. **[DOC]**

## 25. Data consistency requirements

Confirmed count = confirmed only; separate states listed in §11; official stats derive only from confirmed matches (dedupe across tournament/profile views); ratings recomputed from valid ratings (simple mean, 1 decimal, count; none → no rating shown); corrections versioned; club/tournament counts (6/8 clubs = accepted, not applications; Ready separate); bookings' interval + timezone; unique handle per type; tags never change squads/payments/results; deleting a post never deletes the match; user deletion doesn't erase others' official protocol. **[DOC]**

## 26. Idempotency / concurrency requirements

Idempotency keys for: Cash received, object creation (club/game/booking/tournament/post), invitation responses, join/leave, uploads/publishing (Retry must not duplicate post). Atomic checks for: last seat, booking overlap (incl. divisible resources), seat holds, team moves (release+claim in one op), username uniqueness at create time. Optimistic versioning (`VERSION_CHANGED`) for editable resources. Stable pagination (keyset cursors). Deep link/share re-check visibility each open. **[DOC]**

## 27. API error requirements

Codes (mandatory): `VALIDATION, ACCESS_DENIED, EXPIRED, CAPACITY_CHANGED, BOOKING_CONFLICT, VERSION_CHANGED, UPLOAD_FAILED`. Messages: "That place was just taken." (CAPACITY_CHANGED), "This time is no longer available." (BOOKING_CONFLICT), "You no longer have access to this action." (ACCESS_DENIED), "Invitation expired" (EXPIRED), "This username is taken." (a VALIDATION detail with field `username`), "Couldn't load this. Try again." (server error), "You're offline". Errors must never become infinite spinner or false Paid. **[DOC]** Additional infrastructural codes (`NOT_FOUND`, `UNAUTHENTICATED`, `INTERNAL`) and the exact envelope shape are **[TECH]** decisions.

## 28. Acceptance criteria overview

AC-01…AC-52 (Handoff §21) cover: whistle icon parity, invitation frame, filter-outside invitations, expiry, capacity math (10/12, holds), club creation (asterisks, idempotent), keyboard, nested navigation targets, role separation, follow/favourite/private profile, tag & share privacy, search duplicates, filter zero-results, sort, tournament visibility/sponsor, consent readiness, last-seat race, age exception, waitlist offer, delegation revocation, scope enforcement, calendar/step rules (AC-36/37/38/51), cash (AC-41/42/43/52), ratings (AC-45), protocol privacy (AC-46), login without ownership (AC-47), resilience (AC-48/50), report (AC-49). Plus S24-01…S24-14 device plan. Not implemented now; architecture keeps them automatable (pure domain services + server-side permission engine + idempotency layer). **[DOC]**

## 29. Open / unresolved decisions

1. Recommendation/ranking algorithm and weights; city format-frequency period.
2. Password/recovery specifics; legal texts, retention periods; Google/Apple credentials; iOS/Google Play accounts, distribution channel.
3. Final language list (docs: English mockups, RU/KA text mentioned; **no approved list**); font (visual reference: English Premier League app — exact font/licence not fixed).
4. Casual game without club: who receives cash; partial/refund corner cases.
5. Auto-badge criteria (Fair play, Leadership); referee/organiser card metrics; tie-break of primary role over period.
6. Rating aggregation weights for venue vs pitches; anti-abuse.
7. Captain edit boundaries / result lock-reopen details; 4→3 team recalculation rules.
8. Divisible pitch configuration UI and rules.
9. Booking deposits, free-cancel window, weather policy.
10. Media storage provider, push provider, video-analysis provider (deferred), AI assistant (deferred).
11. Community pitch moderation and contributor edit limits.
12. Whether waitlisted users get chat access beyond announcements; default for "Open this place if invitation expires".
13. Pilot data import (Tfilisi/Sprenty catalog, PR №2) — publication deferred by product owner.
14. Web client as a product: not mandated by docs (the brief requests it as a technical project).
15. Real venue hours/prices/availability; Vazisubani manager phone-linking mechanism (numbers exist in docs; **not** copied into this repo — real personal data).

## 30. Requirements that must NOT be implemented (superseded / excluded)

Bank transfer & bank details; SMS/email OTP screens ("Send/Enter/Resend code"); "test mode" label; special login links; 40-tester cap; top "Let'sGo +" bar and football-ball logo; big search field, "Games near you", "Find a venue", distance-enable prompt on Home; All/Open-spots toggles on Home; Tbilisi Cup ad carousel on Home; labels under nav icons, "My games"/"Inbox"; SHAM/@Sham on personal card; "/5" after rating; six skill stats on personal card; Played/Organised/Refereed footer; blue icons; "New"/empty-star/0 for unrated organiser; Join/Accept buttons or arrows on compact game card; referee figure/flag/red-yellow-card icon; pitch icon before booking status; "No booking needed"/"Community field"/"First come first served"; rating next to child pitch, "(32)", "at", 180° arrow; What's-included page and Game-chat arrow; big bottom-sheet Sort; wizard Details→Options→Review and "Next: options"; ambiguous "Player limit"; max=min; single-guest-only invite; club logos replacing whistle/camera (rejected); "Nearest field"/"Nearest first" label; users adding paid pitches directly; payment gateway, wallet, AI video analysis, external football-career import, ads system, web-version obligation. Also: illustrative sample values must not become defaults.

---

## Design tokens extracted from the PDF (sampled from rendered boards)

| Token | Value | Source |
|---|---|---|
| Primary action (mint) | `#5AE5C4` (Show N results, toggles `#45DAB5`) | Filters board |
| Selected chip bg | `#A2F2D9` | Filters |
| Screen bg (light) | `#EEF4F4` (mockup canvas), cards `#FFFFFF` | Filters |
| Brand teal (FAB, prices) | `#017374` FAB / `#0C7F7F` price | Home |
| Top accent bar | `#01A8A0` | PDF frame (not app) |
| Invitation frame border | `#67C3BD` ~2 px, band bg `#E6F7F4` | Home |
| Pitch booked | mint bg `#E1F1EE`, teal text | Home |
| Booking pending | bg `#FDEFE7`, dark brown-orange text | Home |
| Community pitch | bg `#EBEBF6`, dark text | Home |
| Secondary text | `#B2B5BB` / neutral grey | Filters |
| Text/icons | near-black (neutral, not blue) | text §3 |
| Amber (helpful alternative) | soft amber outline, never red for empty results | text |
| Error | red only for concrete field error | text |
Typography: clean humanist sans (mock resembles Premier League app; **font unresolved**); numerals bold for time/price; GEL currency smaller than amount. Radii: cards ~16 px, chips ~10–12 px, pill status badges, circular FAB (~56–64). Spacing ~8/12/16. Contrast ≥ 4.5:1 for body text. Dark theme not designed → no auto-invert. Icon set: outlined black; shared `RefereeIcon` (whistle, 20–24 px). Buttons: primary mint filled with black text; secondary outlined; disabled grey; toggles mint.

# Backend Implementation Plan

Labels: DOC documented · WORK working decision in docs · TECH technical decision · OPEN unresolved.

## 1. Domain dependency graph
```
common kernel (auth guard, errors, idempotency, pagination, permissions/policy, audit, clock)
   └─ auth ─ users/profile ─ privacy ─ social(block/follow/fav)
                     │
                     ├─ clubs(+membership, RoleGrant delegation) ──┐
                     ├─ venues ─ bookings ───────────────────────┐ │
                     └─ games(events, teams, participation) ◄────┘ │
                          ├─ invitations(+seat holds) ─ waitlist    │
                          ├─ payments(obligation, cash receipt) ◄───┤
                          └─ matches/results ─ ratings/achievements │
   tournaments (entries, stages, fixtures, documents/consents, sponsors) ◄─ clubs, bookings, payments
   posts/media/comments/mentions ─ chat ─ activity ─ notifications ◄─ every domain writes in-tx
   moderation/reports ─ admin(staff grants, venue requests, recovery) ─ audit (cross-cutting)
```

## 2. Implementation order
1. Conventions (`/v1`, kernel, clock, errors) 2. Prisma schema + migrations (+ SQL constraints/triggers) 3. auth/session 4. users/profile/privacy/block 5. policy + RoleGrant delegation 6. **vertical slice**: games → invitations/holds/waitlist → payments (Pay cash → Cash received) 7. clubs 8. venues/bookings 9. tournaments 10. social (follow/favourite/search) 11. media/posts/comments/mentions 12. chat 13. activity/notifications 14. matches/ratings/achievements 15. moderation/admin/audit 16. OpenAPI, tests, AC matrix, security review.
Steps 1–6 by the lead (they define the conventions); steps 7–15 partly parallelised across sub-agents on top of the fixed schema and kernel.

## 3. Database entity plan
See `prisma/schema.prisma` (single owner: lead). Groups: identity (User, Profile, PrivacyPolicy, AuthIdentity, Session, AccountRecoveryCase, Block, Follow, Favourite, SavedPost); authz (RoleGrant, OwnershipTransfer); clubs (Club, Membership); venues (Venue, Pitch, PitchPart, PitchConfiguration(+Part), BookingRules, BookingTerms, Booking, CalendarBlock, PitchOccupancy, VenueRequest); games (Event, EventTeam, Participation, Invitation, SeatHold, WaitlistOffer, Match, MatchEvent, MatchRevision, MvpVote); payments (PaymentObligation, CashReceipt, Adjustment); tournaments (Tournament, ClubEntry, ClubEntryPlayer, TournamentStage, Fixture, Standing, RuleDocument, DocumentVersion, Consent, Sponsor, SponsorAsset); content (MediaAsset, Post, PostMedia, Comment, Reaction, Mention); comms (Conversation, ConversationMember, Message, ActivityItem, Notification, NotificationPreference); trust (Rating, Achievement, Report, ModerationAction, AuditEvent); infra (IdempotencyRecord).
Not modelled (out of approved scope): wallet, cards, bank transfer, video analysis, career import.

## 4. API groups (`/v1`)
auth · me · users/profiles · privacy · blocks · follows/favourites/saved · search · events(games) · invitations · participation/waitlist · payments · clubs · venues/pitches · bookings/calendar · tournaments · posts/comments/reactions/mentions/tag-requests · media · conversations/messages · activity · notifications · ratings/achievements · reports · admin.

## 5. Permission architecture
`PolicyService.can(actor, permission, resource)`: (a) structural — club owner ⇒ all club permissions; event organiser ⇒ event management; (b) `RoleGrant` rows (revokedAt null, not expired) on the resource or its container (event→club); (c) platform staff grants (`PLATFORM`). Titles never matter. Delegation validated at creation (source valid, canPassOn, same permission, scope ⊆ source, expiry ≤ source, no cycle, further-delegation flag); revoke cascades to dependents in one transaction; independent grants untouched. Capabilities builders per resource return `{canJoin,…}` from the same policy functions used by mutations (single source).

## 6. Concurrency strategy (TECH)
Event row `FOR UPDATE` for join/confirm/hold/offer/team-move; unique (eventId,userId) on Participation; exclusion constraints on `PitchOccupancy` (per atomic pitch part, tstzrange, active only) for bookings & blocks (divisible pitches expand to parts); unique indexes for handles/contacts/entries; partial unique for one pending ownership transfer.

## 7. Idempotency strategy (TECH)
`IdempotencyRecord(user,scope,key)` claimed inside the work transaction; request hash mismatch → `IDEMPOTENCY_CONFLICT`; duplicate → stored response replay. Required for cash received, invitation reply, join/leave, creates (club, game, booking, tournament, post), publish.

## 8. Audit strategy
`AuditService.record(tx, …)` in the same tx for: grants/revokes, ownership transfer, cash/adjustments, result correction, account recovery, staff actions, moderation, booking override. Metadata scrubbed of secret-looking keys; rows immutable via trigger.

## 9. Testing strategy
Unit (pure domain: capacity math, delegation rules, booking grid, cursor codec), integration (real PG via services), e2e HTTP (supertest), concurrency (Promise.all on real DB), migrations-from-zero test. Factories with random synthetic data.

## 10. Acceptance mapping
`BACKEND_ACCEPTANCE_MATRIX.md` (AC-01…AC-52 → IMPLEMENTED_BACKEND / CLIENT_REQUIRED / DEVICE_REQUIRED / OPEN / NOT_APPLICABLE_BACKEND).

## 11. OPEN decisions
See `OPEN_DECISIONS.md`.

## 12. Risks
Scale of scope vs. depth (mitigation: shared kernel first, module tests mandatory); Prisma 7 + raw SQL constraints interplay (mitigation: real-DB tests); sub-agent drift (mitigation: frozen schema/kernel, narrow test modules, lead review); no git repo (no worktree isolation — agents own disjoint directories); Windows/Node 25 tooling quirks.

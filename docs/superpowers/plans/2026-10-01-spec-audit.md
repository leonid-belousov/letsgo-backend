# LetsGo specification audit and filter completion plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the approved PDF, development handoff, and decisions with the current backend, web, and mobile implementation, then close only verified gaps that the existing data model and contract can support.

**Architecture:** Treat the backend as the authority for visibility, capabilities, pagination, and filter semantics. Extend the existing `GameListQuery`/`buildWhere` contract for pitch/venue-backed filters, regenerate typed clients, and expose the same filters in mobile and web surfaces without inventing provider or product-decision rules.

**Tech Stack:** NestJS/Prisma/PostgreSQL; React/Vite/TanStack Query; Expo React Native; OpenAPI-generated TypeScript; Jest/Vitest/RNTL.

**Spec:** `C:/Users/LION_ID/Downloads/Telegram Desktop/LetsGo_Development_Handoff_2026-09-22 (2).md`, `C:/Users/LION_ID/Downloads/Telegram Desktop/LetsGo_Decisions_2026-09-21 (6).html`, and `C:/Users/LION_ID/Downloads/Telegram Desktop/LetsGo_Approved_UI_Designs_2026-09-24 (1).pdf`.

## Global Constraints

- Server remains the authority for permissions, visibility, capacity, pagination, and idempotency.
- OR applies inside one filter group; AND applies between groups.
- Unknown distance is sorted last; no invented coordinates or ratings.
- Android touch targets remain at least 48 dp; forms remain keyboard-safe.
- Do not add OAuth credentials, push providers, production media/CDN, or physical-device claims without external inputs.
- Preserve existing OpenAPI generation and do not hand-write client DTOs.

## Review Focus

- Missing pitch/venue query inputs must not silently look like implemented UI filters: add backend contract tests and mobile query tests.
- Nullable pitch data and unknown coordinates/ratings must remain valid and sort/filter deterministically.
- Cursor pagination must stay stable for computed filters and existing sorts.
- Filter reset must preserve city context and independent sort, matching the handoff.
- Generated clients must typecheck after every contract change.

### Task 1: Backend game filter contract

**Files:**
- Modify: `lets_go_back/src/modules/games/dto.ts`
- Modify: `lets_go_back/src/modules/games/games.service.ts`
- Test: `lets_go_back/test/games-search.e2e-spec.ts` (or the existing game search suite)

- [ ] Add typed optional filters backed by existing `Venue`/`Pitch` data: pitch setting/surface/amenity, duration range, organiser rating threshold, and distance radius when coordinates are supplied.
- [ ] Extend `buildWhere` with AND semantics and leave unknown/null data visible unless the selected filter explicitly requires it.
- [ ] Add e2e coverage for positive/negative matches, no-location validation, unknown distance/rating ordering, and cursor stability.
- [ ] Run focused game search tests, typecheck, lint, build, and migrations.

### Task 2: Mobile filter surface

**Files:**
- Modify: `lets_go_mobile/src/stores/feedFilters.ts`
- Modify: `lets_go_mobile/src/features/home/FiltersScreen.tsx`
- Modify: `lets_go_mobile/src/features/home/hooks.ts`
- Test: `lets_go_mobile/src/stores/feedFilters.test.ts` and the smallest relevant screen test

- [ ] Add controls for the supported backend filters, preserving draft/applied/reset semantics and accessible labels.
- [ ] Serialize values through the generated client only; do not show controls for unsupported product decisions.
- [ ] Verify no-results alternatives and reset behavior remain deterministic.

### Task 3: Web contract and UI parity

**Files:**
- Regenerate: `lets_go_front/src/api/schema.d.ts`
- Modify: `lets_go_front/src/features/games/hooks.ts`, `lets_go_front/src/features/search/pages.tsx` or the games filter surface
- Test: affected Vitest route tests

- [ ] Regenerate the client from the running OpenAPI document.
- [ ] Expose only the supported filters in the existing web flow, with loading/error/empty states.
- [ ] Run frontend tests, typecheck, lint, build, and Prettier.

### Task 4: Whole-spec verification and reporting

**Files:**
- Modify: `IMPLEMENTATION_REPORT.md`, `BACKEND_FINALIZATION_REPORT.md`, `MOBILE_IMPLEMENTATION_REPORT.md`, acceptance matrices

- [ ] Re-run backend, web, and mobile tests plus Android/iOS Expo exports.
- [ ] Verify backend health, Metro, emulator activity, and the protected catalogue endpoint.
- [ ] Mark each acceptance item only as implemented, device-required, or open with evidence; do not convert external/product blockers into code claims.
- [ ] Record remaining gaps and exact commands/results.

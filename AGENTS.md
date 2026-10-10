# AGENTS.md — lets_go_back

Instructions for any coding agent or sub-agent working in `lets_go_back`. Also read `CLAUDE.md`.

## Allowed scope
Only `lets_go_back/**` plus root documentation files explicitly named in the task. Do not touch `lets_go_front` / `lets_go_mobile` code. Do not re-initialize NestJS/Prisma/Docker; extend what exists.

## Authoritative documents
`PROJECT_ANALYSIS.md`, `BACKEND_IMPLEMENTATION_PLAN.md`, `OPEN_DECISIONS.md`, and the original product documents. If a rule is unclear, read the original; if still unclear, record an OPEN item.

## Architecture constraints
- Layers: Controller (HTTP) → Service (application/domain) → Prisma. Controllers never contain business rules.
- Shared kernel in `src/common/*` (auth, errors, idempotency, pagination, permissions, audit, time, transactions). Reuse it; do not duplicate.
- **Module ownership**: each module owns its tables' write logic. Other modules read via the owner's exported service, never by writing into its tables. Cross-module writes that must be atomic accept a `Tx` (Prisma transaction client) from the caller.
- Dependency rules: no circular imports; `common/*` and `infrastructure/*` never import from `modules/*`. Do not edit another module's files except to add exports you need (keep edits minimal).
- `src/app.module.ts`: add only your own module import line.
- Schema: `prisma/schema.prisma` is owned by the lead. Need a change? Make a minimal additive change, create a new migration, and mention it in your report.

## Database rules
UUIDv7 ids, `timestamptz`, integer money. Use DB constraints for invariants (unique, check, exclusion, trigger) in migration SQL — not just app code. Never edit an applied migration; add a new one. All multi-row business writes run in one transaction. Use `SELECT … FOR UPDATE` (or constraints) for races — never in-process locks.

## API rules
`/v1` prefix, explicit request/response DTOs with class-validator + `@nestjs/swagger` decorators (`@ApiTags`, `@ApiBearerAuth`, `@ApiOkResponse`, error docs). Lists use keyset cursor pagination. Mutations that must not double-apply take the `Idempotency-Key` header and go through `IdempotencyService`. Editable resources carry `version` and return `VERSION_CHANGED` on stale writes. Errors: `ApiError` with a documented `ErrorCode`.

## Security rules
- Never infer authorization from role names alone.
- Never trust capabilities supplied by a client.
- Never expose owner/private DTO fields through public DTOs.
- Never modify immutable financial history in place.
- Never solve race conditions only in application memory.
- Never introduce an unresolved product decision as if it were approved.
- Never log passwords, access tokens, refresh tokens, session secrets, OAuth secrets, contact verification secrets or private document data.
Check object-level access on every id (IDOR/BOLA); whitelist DTO fields; use parameterised SQL only.

## Logging
pino via nestjs-pino; redaction is configured centrally. Log operation, ids, request id, duration, error code — never payload bodies with secrets.

## Migration rules
`npx prisma migrate dev --create-only --name <name>` then append custom SQL if needed; run `npx prisma migrate deploy`; prove a clean database reproduces the schema (`npm run test:migrations`).

## Testing rules
Use factories in `test/support` (synthetic data only; random suffixes, no shared fixtures, no truncating shared tables). Integration tests hit real PostgreSQL. Cover: happy path, permission denial, validation, idempotent retry, and any race the module owns. When several agents work in parallel, compose narrow Nest testing modules instead of importing the full `AppModule`, and only fix compile errors in your own directories.

## Concurrency / idempotency / permission requirements
Seats/holds/team moves lock the Event row; bookings rely on exclusion constraints; cash uses `IdempotencyService` + immutable receipts; every mutating endpoint calls `PolicyService` (or an explicit ownership check) before acting.

## Review checklist
- [ ] Permission check on every object id · [ ] DTO leaks nothing private · [ ] transaction boundary correct · [ ] idempotency/version where required · [ ] audit event for sensitive action · [ ] OpenAPI decorators · [ ] tests incl. denial + race · [ ] no `any`/unsafe cast · [ ] OPEN items not silently decided · [ ] typecheck/lint/test/build green.

## Forbidden shortcuts
TODO endpoints returning success, hard-coded users/`paid=true`, fake capability arrays, empty service methods, mock repositories in production, allow-all/admin bypass, `catch {}` that hides failures, skipping tests for "later", copying sample data or real phone numbers from documents.

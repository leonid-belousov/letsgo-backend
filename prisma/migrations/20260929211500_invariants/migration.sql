-- Invariants Prisma cannot express. Reviewed as part of the schema contract.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Handles are stored lowercase (case-insensitive uniqueness via the plain unique index).
ALTER TABLE "Profile" ADD CONSTRAINT profile_username_lower CHECK (username IS NULL OR username = lower(username));
ALTER TABLE "Club"    ADD CONSTRAINT club_username_lower    CHECK (username = lower(username));

-- Search (nickname / name prefix + fuzzy)
CREATE INDEX profile_nickname_trgm ON "Profile" USING gin (lower(nickname) gin_trgm_ops);
CREATE INDEX profile_username_trgm ON "Profile" USING gin (username gin_trgm_ops);
CREATE INDEX club_name_trgm        ON "Club"    USING gin (lower(name) gin_trgm_ops);
CREATE INDEX club_username_trgm    ON "Club"    USING gin (username gin_trgm_ops);

-- Events
ALTER TABLE "Event" ADD CONSTRAINT event_time_order CHECK ("endsAt" > "startsAt");
ALTER TABLE "Event" ADD CONSTRAINT event_format_range CHECK ("formatPlayers" BETWEEN 5 AND 11);
ALTER TABLE "Event" ADD CONSTRAINT event_team_range CHECK ("teamCount" BETWEEN 2 AND 4);
ALTER TABLE "Event" ADD CONSTRAINT event_capacity_positive CHECK (capacity > 0 AND "substitutesPerTeam" >= 0);
ALTER TABLE "Event" ADD CONSTRAINT event_price_nonneg CHECK ("priceMinor" >= 0);
ALTER TABLE "Event" ADD CONSTRAINT event_min_confirmed CHECK ("minConfirmed" IS NULL OR ("minConfirmed" > 0 AND "minConfirmed" <= capacity));

-- Bookings & occupancy: DB-level double-booking prevention (including divisible pitches,
-- because every booking/block occupies each atomic PitchPart it covers).
ALTER TABLE "Booking" ADD CONSTRAINT booking_time_order CHECK ("endsAt" > "startsAt");
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT occupancy_time_order CHECK ("endsAt" > "startsAt");
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT occupancy_one_owner CHECK (("bookingId" IS NOT NULL) <> ("calendarBlockId" IS NOT NULL));
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT pitch_occupancy_no_overlap
  EXCLUDE USING gist ("partId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("releasedAt" IS NULL);
ALTER TABLE "CalendarBlock" ADD CONSTRAINT block_time_order CHECK ("endsAt" > "startsAt");

-- Money
ALTER TABLE "PaymentObligation" ADD CONSTRAINT obligation_amount_nonneg CHECK ("amountMinor" >= 0 AND "paidMinor" >= 0 AND "refundDueMinor" >= 0 AND "refundedMinor" >= 0);
ALTER TABLE "PaymentObligation" ADD CONSTRAINT obligation_one_payer CHECK (("payerUserId" IS NOT NULL) <> ("payerClubId" IS NOT NULL));
ALTER TABLE "CashReceipt" ADD CONSTRAINT receipt_amount_positive CHECK ("amountMinor" > 0);
CREATE UNIQUE INDEX cash_receipt_idem ON "CashReceipt" ("obligationId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- Ratings
ALTER TABLE "Rating" ADD CONSTRAINT rating_score_range CHECK (score BETWEEN 1 AND 5);

-- Tournaments
ALTER TABLE "Fixture" ADD CONSTRAINT fixture_distinct_sides CHECK ("homeEntryId" IS NULL OR "awayEntryId" IS NULL OR "homeEntryId" <> "awayEntryId");
ALTER TABLE "Tournament" ADD CONSTRAINT tournament_fee_nonneg CHECK ("feeMinor" >= 0);

-- Only one pending ownership transfer per club
CREATE UNIQUE INDEX ownership_transfer_one_pending ON "OwnershipTransfer" ("clubId") WHERE status = 'PENDING';

-- Self-relations that make no sense
ALTER TABLE "Block"  ADD CONSTRAINT block_not_self  CHECK ("blockerId" <> "blockedId");

-- Immutable historical records
CREATE FUNCTION letsgo_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cash_receipt_immutable BEFORE UPDATE OR DELETE ON "CashReceipt" FOR EACH ROW EXECUTE FUNCTION letsgo_forbid_mutation();
CREATE TRIGGER adjustment_immutable   BEFORE UPDATE OR DELETE ON "Adjustment"  FOR EACH ROW EXECUTE FUNCTION letsgo_forbid_mutation();
CREATE TRIGGER consent_immutable      BEFORE UPDATE OR DELETE ON "Consent"     FOR EACH ROW EXECUTE FUNCTION letsgo_forbid_mutation();
CREATE TRIGGER audit_event_immutable  BEFORE UPDATE OR DELETE ON "AuditEvent"  FOR EACH ROW EXECUTE FUNCTION letsgo_forbid_mutation();
CREATE TRIGGER match_revision_immutable BEFORE UPDATE OR DELETE ON "MatchRevision" FOR EACH ROW EXECUTE FUNCTION letsgo_forbid_mutation();

-- DropIndex
DROP INDEX "TournamentBooking_bookingId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "TournamentBooking_bookingId_key" ON "TournamentBooking"("bookingId");


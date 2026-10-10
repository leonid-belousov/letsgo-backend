-- One player-fee obligation per (tournament, player); club fees are already unique on (kind, tournamentId, payerClubId).
CREATE UNIQUE INDEX obligation_tournament_player_unique ON "PaymentObligation" (kind, "tournamentId", "payerUserId") WHERE "tournamentId" IS NOT NULL AND "payerUserId" IS NOT NULL;

-- CreateEnum
CREATE TYPE "FeeAmendmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING_RESOLUTION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "WithdrawalResolution" AS ENUM ('POSTPONE', 'TECHNICAL_RESULT', 'REPLACEMENT', 'END_PARTICIPATION');

-- DropIndex
DROP INDEX "club_username_trgm";

-- DropIndex
DROP INDEX "profile_username_trgm";

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "autoNextWave" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "venueAttentionAt" TIMESTAMPTZ(3),
ADD COLUMN     "venueAttentionReason" TEXT,
ADD COLUMN     "venueNeedsAttention" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "metadataStripped" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "FeeAmendment" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "oldAmountMinor" INTEGER NOT NULL,
    "newAmountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "status" "FeeAmendmentStatus" NOT NULL DEFAULT 'PENDING',
    "proposedById" UUID NOT NULL,
    "respondedById" UUID,
    "respondedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "report" JSONB,
    "error" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentSearch" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "query" TEXT,
    "entityType" TEXT,
    "entityId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaVariant" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "id" UUID NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentBooking" (
    "tournamentId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "attachedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentBooking_pkey" PRIMARY KEY ("tournamentId","bookingId")
);

-- CreateTable
CREATE TABLE "EntryWithdrawal" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING_RESOLUTION',
    "resolution" "WithdrawalResolution",
    "resolutionNote" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "replacementEntryId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntryWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeeAmendment_obligationId_status_idx" ON "FeeAmendment"("obligationId", "status");

-- CreateIndex
CREATE INDEX "FeeAmendment_participantId_status_createdAt_idx" ON "FeeAmendment"("participantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FeeAmendment_eventId_status_idx" ON "FeeAmendment"("eventId", "status");

-- CreateIndex
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");

-- CreateIndex
CREATE INDEX "RecentSearch_userId_lastUsedAt_idx" ON "RecentSearch"("userId", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecentSearch_userId_dedupeKey_key" ON "RecentSearch"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_storageKey_key" ON "MediaVariant"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_assetId_label_key" ON "MediaVariant"("assetId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "AuthNonce_nonceHash_key" ON "AuthNonce"("nonceHash");

-- CreateIndex
CREATE INDEX "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");

-- CreateIndex
CREATE INDEX "TournamentBooking_bookingId_idx" ON "TournamentBooking"("bookingId");

-- CreateIndex
CREATE INDEX "EntryWithdrawal_tournamentId_status_idx" ON "EntryWithdrawal"("tournamentId", "status");

-- CreateIndex
CREATE INDEX "EntryWithdrawal_entryId_idx" ON "EntryWithdrawal"("entryId");

-- AddForeignKey
ALTER TABLE "MediaVariant" ADD CONSTRAINT "MediaVariant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one PENDING fee amendment per obligation.
CREATE UNIQUE INDEX fee_amendment_one_pending ON "FeeAmendment" ("obligationId") WHERE status = 'PENDING';
-- Deadline scan indexes used by the maintenance job.
CREATE INDEX invitation_pending_deadline ON "Invitation" ("respondBy") WHERE status = 'PENDING' AND "respondBy" IS NOT NULL;
CREATE INDEX notification_retry ON "Notification" (delivery, "nextAttemptAt") WHERE delivery IN ('PENDING','FAILED');

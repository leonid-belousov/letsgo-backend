-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'PHONE', 'GOOGLE', 'APPLE');

-- CreateEnum
CREATE TYPE "Audience" AS ENUM ('EVERYONE', 'FOLLOWERS', 'ONLY_ME');

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "MessagePolicy" AS ENUM ('EVERYONE', 'FOLLOWING', 'NOBODY');

-- CreateEnum
CREATE TYPE "InvitationPolicy" AS ENUM ('EVERYONE', 'FOLLOWING', 'CLUB_MEMBERS', 'NOBODY');

-- CreateEnum
CREATE TYPE "MentionPolicy" AS ENUM ('EVERYONE', 'FOLLOWING', 'NOBODY');

-- CreateEnum
CREATE TYPE "FollowTargetType" AS ENUM ('USER', 'CLUB', 'VENUE', 'PITCH', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "FollowStatus" AS ENUM ('REQUESTED', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "FavouriteTargetType" AS ENUM ('USER', 'CLUB', 'EVENT', 'VENUE', 'PITCH', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "GrantResourceType" AS ENUM ('PLATFORM', 'CLUB', 'EVENT', 'VENUE', 'PITCH', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "ClubVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ClubJoinMode" AS ENUM ('OPEN', 'APPROVE_REQUESTS', 'INVITE_ONLY');

-- CreateEnum
CREATE TYPE "ClubStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('MEMBER', 'REQUESTED', 'INVITED', 'LEFT', 'REMOVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VenueKind" AS ENUM ('PAID', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "VenueStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "PitchSurface" AS ENUM ('ARTIFICIAL', 'NATURAL', 'HARD_COURT', 'OTHER');

-- CreateEnum
CREATE TYPE "PitchSetting" AS ENUM ('INDOOR', 'OUTDOOR', 'COVERED');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('LETSGO', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'HELD', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ConfirmationSource" AS ENUM ('VENUE', 'SYSTEM', 'ORGANISER_MANUAL');

-- CreateEnum
CREATE TYPE "VenueRequestStatus" AS ENUM ('PENDING', 'NEEDS_INFO', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('CASUAL', 'CLUB_V_CLUB', 'TRAINING');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'STARTED', 'FINISHED', 'RESULT_PENDING', 'RESULT_CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventJoinMode" AS ENUM ('AUTO_ACCEPT', 'APPROVE_REQUESTS');

-- CreateEnum
CREATE TYPE "AgeBand" AS ENUM ('NONE', 'A35', 'A40', 'A45', 'A50');

-- CreateEnum
CREATE TYPE "PitchStatus" AS ENUM ('PITCH_BOOKED', 'BOOKING_PENDING', 'COMMUNITY_PITCH');

-- CreateEnum
CREATE TYPE "ParticipationStatus" AS ENUM ('PENDING_APPROVAL', 'CONFIRMED', 'WAITLISTED', 'DECLINED', 'WITHDRAWN', 'CANCELLED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ParticipationSource" AS ENUM ('SELF_JOIN', 'INVITATION', 'WAITLIST_OFFER', 'ORGANISER_ADDED', 'AGE_EXCEPTION');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SeatHoldReleaseReason" AS ENUM ('CONFIRMED', 'DECLINED', 'EXPIRED', 'REVOKED', 'EVENT_CANCELLED');

-- CreateEnum
CREATE TYPE "WaitlistOfferStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MatchEventType" AS ENUM ('GOAL', 'OWN_GOAL', 'YELLOW_CARD', 'RED_CARD');

-- CreateEnum
CREATE TYPE "ObligationKind" AS ENUM ('EVENT_FEE', 'TOURNAMENT_CLUB_FEE', 'TOURNAMENT_PLAYER_FEE', 'PITCH_RENTAL');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('CORRECTION', 'REFUND_DUE', 'REFUND_PAID', 'WAIVER');

-- CreateEnum
CREATE TYPE "TournamentDuration" AS ENUM ('ONE_DAY', 'MULTI_DAY', 'SEASON');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeMode" AS ENUM ('FREE', 'PER_CLUB', 'PER_PLAYER');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('APPLIED', 'INVITED', 'ACCEPTED', 'WAITLISTED', 'REJECTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EntryPlayerStatus" AS ENUM ('INVITED', 'CONFIRMED', 'DECLINED', 'REMOVED');

-- CreateEnum
CREATE TYPE "StageKind" AS ENUM ('GROUP', 'LEAGUE', 'KNOCKOUT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FixtureStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentAudience" AS ENUM ('CLUB_REPS', 'PLAYERS', 'BOTH');

-- CreateEnum
CREATE TYPE "ConsentRole" AS ENUM ('CLUB_REP', 'PLAYER');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "PostAuthorType" AS ENUM ('USER', 'CLUB', 'TOURNAMENT', 'VENUE');

-- CreateEnum
CREATE TYPE "PostAudience" AS ENUM ('PUBLIC', 'FOLLOWERS', 'CLUB_MEMBERS', 'ONLY_ME');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DELETED');

-- CreateEnum
CREATE TYPE "MentionTargetType" AS ENUM ('USER', 'CLUB');

-- CreateEnum
CREATE TYPE "MentionStatus" AS ENUM ('PENDING_REVIEW', 'SHOWN', 'HIDDEN', 'REMOVED');

-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('DIRECT', 'EVENT', 'CLUB', 'TOURNAMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'SYSTEM_CARD');

-- CreateEnum
CREATE TYPE "NotificationDelivery" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RatingSubject" AS ENUM ('PLAYER', 'ORGANISER', 'REFEREE', 'PITCH', 'VENUE');

-- CreateEnum
CREATE TYPE "AchievementType" AS ENUM ('NEW_JOINER', 'FAIR_PLAY', 'LEADERSHIP', 'TROPHY', 'CLUB_AWARD');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'IMPERSONATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('POST', 'COMMENT', 'USER', 'CLUB', 'EVENT', 'TOURNAMENT', 'VENUE', 'MESSAGE', 'MEDIA');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('OPEN', 'APPROVED', 'DECLINED', 'REDEEMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "userId" UUID NOT NULL,
    "nickname" TEXT,
    "username" TEXT,
    "dateOfBirth" DATE,
    "city" TEXT,
    "bio" TEXT,
    "avatarId" UUID,
    "visibility" "ProfileVisibility" NOT NULL DEFAULT 'PUBLIC',
    "completedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PrivacyPolicy" (
    "userId" UUID NOT NULL,
    "postsAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "historyAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "statsAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "awardsAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "clubsAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "ratingsAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "cityAudience" "Audience" NOT NULL DEFAULT 'EVERYONE',
    "ageAudience" "Audience" NOT NULL DEFAULT 'ONLY_ME',
    "followListAudience" "Audience" NOT NULL DEFAULT 'FOLLOWERS',
    "messagePolicy" "MessagePolicy" NOT NULL DEFAULT 'FOLLOWING',
    "invitationPolicy" "InvitationPolicy" NOT NULL DEFAULT 'EVERYONE',
    "mentionPolicy" "MentionPolicy" NOT NULL DEFAULT 'FOLLOWING',
    "reviewTags" BOOLEAN NOT NULL DEFAULT true,
    "externalMediaSharing" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PrivacyPolicy_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "passwordHash" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshHash" TEXT,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountRecoveryCase" (
    "id" UUID NOT NULL,
    "contactProvider" "AuthProvider" NOT NULL,
    "contactSubject" TEXT NOT NULL,
    "userId" UUID,
    "message" TEXT,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" UUID,
    "verificationNote" TEXT,
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AccountRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" UUID NOT NULL,
    "followerId" UUID NOT NULL,
    "targetType" "FollowTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "status" "FollowStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favourite" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetType" "FavouriteTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favourite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedPost" (
    "userId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedPost_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateTable
CREATE TABLE "RoleGrant" (
    "id" UUID NOT NULL,
    "granteeId" UUID NOT NULL,
    "resourceType" "GrantResourceType" NOT NULL,
    "resourceId" UUID,
    "permission" TEXT NOT NULL,
    "canPassOn" BOOLEAN NOT NULL DEFAULT false,
    "furtherDelegation" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" UUID NOT NULL,
    "sourceGrantId" UUID,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipTransfer" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Club" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "about" TEXT,
    "logoMediaId" UUID,
    "coverMediaId" UUID,
    "visibility" "ClubVisibility" NOT NULL DEFAULT 'PUBLIC',
    "joinMode" "ClubJoinMode" NOT NULL DEFAULT 'APPROVE_REQUESTS',
    "preferredFormats" TEXT[],
    "founderId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "ClubStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "roleTitle" TEXT,
    "showTitle" BOOLEAN NOT NULL DEFAULT true,
    "invitedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMPTZ(3),
    "leftAt" TIMESTAMPTZ(3),

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameLocal" TEXT,
    "kind" "VenueKind" NOT NULL,
    "status" "VenueStatus" NOT NULL DEFAULT 'DRAFT',
    "city" TEXT NOT NULL,
    "district" TEXT,
    "address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "timezone" TEXT NOT NULL,
    "about" TEXT,
    "createdById" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pitch" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "surface" "PitchSurface",
    "setting" "PitchSetting",
    "lengthM" DECIMAL(6,2),
    "widthM" DECIMAL(6,2),
    "formats" TEXT[],
    "amenities" TEXT[],
    "pricePerHourMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GEL',
    "status" "VenueStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Pitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PitchPart" (
    "id" UUID NOT NULL,
    "pitchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PitchPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PitchConfiguration" (
    "id" UUID NOT NULL,
    "pitchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT,

    CONSTRAINT "PitchConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PitchConfigurationPart" (
    "configurationId" UUID NOT NULL,
    "partId" UUID NOT NULL,

    CONSTRAINT "PitchConfigurationPart_pkey" PRIMARY KEY ("configurationId","partId")
);

-- CreateTable
CREATE TABLE "BookingRules" (
    "pitchId" UUID NOT NULL,
    "minDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "gridMinutes" INTEGER NOT NULL DEFAULT 30,
    "allowHalfHourExtension" BOOLEAN NOT NULL DEFAULT false,
    "openingHours" JSONB,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingRules_pkey" PRIMARY KEY ("pitchId")
);

-- CreateTable
CREATE TABLE "BookingTerms" (
    "id" UUID NOT NULL,
    "pitchId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "pitchId" UUID NOT NULL,
    "configurationId" UUID NOT NULL,
    "bookedById" UUID,
    "source" "BookingSource" NOT NULL DEFAULT 'LETSGO',
    "status" "BookingStatus" NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "holdExpiresAt" TIMESTAMPTZ(3),
    "externalName" TEXT,
    "externalPhone" TEXT,
    "staffNote" TEXT,
    "priceMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GEL',
    "rulesVersion" INTEGER NOT NULL,
    "termsVersion" INTEGER,
    "termsAcceptedAt" TIMESTAMPTZ(3),
    "confirmationSource" "ConfirmationSource",
    "confirmedById" UUID,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarBlock" (
    "id" UUID NOT NULL,
    "pitchId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PitchOccupancy" (
    "id" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "bookingId" UUID,
    "calendarBlockId" UUID,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PitchOccupancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueRequest" (
    "id" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "address" TEXT,
    "comment" TEXT,
    "photoMediaIds" TEXT[],
    "status" "VenueRequestStatus" NOT NULL DEFAULT 'PENDING',
    "staffNote" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "resultingVenueId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "kind" "EventKind" NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "organiserId" UUID NOT NULL,
    "clubId" UUID,
    "venueId" UUID,
    "pitchId" UUID,
    "bookingId" UUID,
    "title" TEXT,
    "timezone" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "formatPlayers" INTEGER NOT NULL,
    "teamCount" INTEGER NOT NULL DEFAULT 2,
    "substitutesPerTeam" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL,
    "minConfirmed" INTEGER,
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GEL',
    "pitchStatus" "PitchStatus",
    "pitchStatusSource" "ConfirmationSource",
    "joinMode" "EventJoinMode" NOT NULL DEFAULT 'APPROVE_REQUESTS',
    "ageBand" "AgeBand" NOT NULL DEFAULT 'NONE',
    "allowYounger" BOOLEAN NOT NULL DEFAULT false,
    "refereeIncluded" BOOLEAN NOT NULL DEFAULT false,
    "videoIncluded" BOOLEAN NOT NULL DEFAULT false,
    "waterIncluded" BOOLEAN NOT NULL DEFAULT false,
    "bibsIncluded" BOOLEAN NOT NULL DEFAULT false,
    "refereeUserId" UUID,
    "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "payCashEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "autoCancelEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCancelCheckAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTeam" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT,
    "colour" TEXT,
    "captainId" UUID,
    "clubId" UUID,

    CONSTRAINT "EventTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participation" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "teamId" UUID,
    "status" "ParticipationStatus" NOT NULL,
    "isSubstitute" BOOLEAN NOT NULL DEFAULT false,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "source" "ParticipationSource" NOT NULL,
    "ageExceptionRequested" BOOLEAN NOT NULL DEFAULT false,
    "ageExceptionApprovedById" UUID,
    "waitlistedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Participation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "invitedById" UUID NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "waveNumber" INTEGER NOT NULL DEFAULT 1,
    "respondBy" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatHold" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "teamId" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "releaseReason" "SeatHoldReleaseReason",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistOffer" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "participationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "WaitlistOfferStatus" NOT NULL DEFAULT 'OFFERED',
    "offeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WaitlistOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "fixtureId" UUID,
    "homeTeamId" UUID,
    "awayTeamId" UUID,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "status" "MatchStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMPTZ(3),
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMPTZ(3),
    "mvpVotingClosesAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "type" "MatchEventType" NOT NULL,
    "teamId" UUID,
    "playerId" UUID NOT NULL,
    "assistById" UUID,
    "minute" INTEGER,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchRevision" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MvpVote" (
    "matchId" UUID NOT NULL,
    "voterId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MvpVote_pkey" PRIMARY KEY ("matchId","voterId")
);

-- CreateTable
CREATE TABLE "PaymentObligation" (
    "id" UUID NOT NULL,
    "kind" "ObligationKind" NOT NULL,
    "payerUserId" UUID,
    "payerClubId" UUID,
    "eventId" UUID,
    "tournamentId" UUID,
    "bookingId" UUID,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GEL',
    "status" "ObligationStatus" NOT NULL DEFAULT 'OPEN',
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "refundDueMinor" INTEGER NOT NULL DEFAULT 0,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "payCashRequestedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashReceipt" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "receivedById" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "CashReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Adjustment" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "deltaMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logoMediaId" UUID,
    "organiserId" UUID NOT NULL,
    "city" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "duration" "TournamentDuration" NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "formatPlayers" INTEGER NOT NULL,
    "ageBand" "AgeBand" NOT NULL DEFAULT 'NONE',
    "allowYounger" BOOLEAN NOT NULL DEFAULT false,
    "feeMode" "FeeMode" NOT NULL DEFAULT 'FREE',
    "feeMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GEL',
    "status" "TournamentStatus" NOT NULL DEFAULT 'DRAFT',
    "waitlistOpen" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "maxClubs" INTEGER,
    "minClubs" INTEGER,
    "minPlayersPerClub" INTEGER,
    "maxPlayersPerClub" INTEGER,
    "mainSponsorId" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubEntry" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "status" "EntryStatus" NOT NULL,
    "submittedById" UUID NOT NULL,
    "decidedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ClubEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubEntryPlayer" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "EntryPlayerStatus" NOT NULL DEFAULT 'INVITED',
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "ageExceptionApprovedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubEntryPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentStage" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StageKind" NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fixture" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "groupLabel" TEXT,
    "homeEntryId" UUID,
    "awayEntryId" UUID,
    "homePlaceholder" TEXT,
    "awayPlaceholder" TEXT,
    "pitchId" UUID,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "scheduleVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "FixtureStatus" NOT NULL DEFAULT 'SCHEDULED',
    "homeScore" INTEGER,
    "awayScore" INTEGER,

    CONSTRAINT "Fixture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Standing" (
    "id" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "groupLabel" TEXT NOT NULL DEFAULT '',
    "entryId" UUID NOT NULL,
    "played" INTEGER NOT NULL DEFAULT 0,
    "won" INTEGER NOT NULL DEFAULT 0,
    "drawn" INTEGER NOT NULL DEFAULT 0,
    "lost" INTEGER NOT NULL DEFAULT 0,
    "goalsFor" INTEGER NOT NULL DEFAULT 0,
    "goalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Standing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleDocument" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "audience" "DocumentAudience" NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT,
    "currentVersionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "fileMediaId" UUID NOT NULL,
    "checksum" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ConsentRole" NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sponsor" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logoMediaId" UUID,
    "externalUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorAsset" (
    "id" UUID NOT NULL,
    "sponsorId" UUID NOT NULL,
    "mediaId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMPTZ(3),

    CONSTRAINT "SponsorAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "visibility" "MediaVisibility" NOT NULL DEFAULT 'PRIVATE',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMPTZ(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "authorType" "PostAuthorType" NOT NULL DEFAULT 'USER',
    "authorEntityId" UUID NOT NULL,
    "audience" "PostAudience" NOT NULL DEFAULT 'PUBLIC',
    "body" TEXT,
    "achievementId" UUID,
    "eventId" UUID,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "commentsClosed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMedia" (
    "postId" UUID NOT NULL,
    "mediaId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("postId","mediaId")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "parentId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reaction" (
    "postId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("postId","userId","type")
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "targetType" "MentionTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "status" "MentionStatus" NOT NULL DEFAULT 'SHOWN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "eventId" UUID,
    "clubId" UUID,
    "tournamentId" UUID,
    "directKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMember" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMPTZ(3),
    "lastReadAt" TIMESTAMPTZ(3),
    "muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "senderId" UUID,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "cardType" TEXT,
    "cardPayload" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityItem" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" UUID,
    "objectType" TEXT NOT NULL,
    "objectId" UUID NOT NULL,
    "payload" JSONB,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "ActivityItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "objectType" TEXT,
    "objectId" UUID,
    "dedupeKey" TEXT,
    "delivery" "NotificationDelivery" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","category")
);

-- CreateTable
CREATE TABLE "Rating" (
    "id" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "subjectType" "RatingSubject" NOT NULL,
    "subjectId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "extended" JSONB,
    "editableUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "hiddenAt" TIMESTAMPTZ(3),

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" UUID NOT NULL,
    "type" "AchievementType" NOT NULL,
    "recipientId" UUID NOT NULL,
    "clubId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "grantedById" UUID,
    "sourceMatchId" UUID,
    "sourceTournamentId" UUID,
    "awardedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "ticketNumber" SERIAL NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "text" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" UUID NOT NULL,
    "reportId" UUID,
    "moderatorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_username_key" ON "Profile"("username");

-- CreateIndex
CREATE INDEX "Profile_city_idx" ON "Profile"("city");

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_subject_key" ON "AuthIdentity"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_previousRefreshHash_key" ON "Session"("previousRefreshHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountRecoveryCase_tokenHash_key" ON "AccountRecoveryCase"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountRecoveryCase_status_createdAt_idx" ON "AccountRecoveryCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE INDEX "Follow_targetType_targetId_status_idx" ON "Follow"("targetType", "targetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_targetType_targetId_key" ON "Follow"("followerId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "Favourite_userId_createdAt_idx" ON "Favourite"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Favourite_userId_targetType_targetId_key" ON "Favourite"("userId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "RoleGrant_granteeId_resourceType_resourceId_idx" ON "RoleGrant"("granteeId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "RoleGrant_sourceGrantId_idx" ON "RoleGrant"("sourceGrantId");

-- CreateIndex
CREATE INDEX "RoleGrant_resourceType_resourceId_idx" ON "RoleGrant"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_clubId_status_idx" ON "OwnershipTransfer"("clubId", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_toUserId_status_idx" ON "OwnershipTransfer"("toUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Club_username_key" ON "Club"("username");

-- CreateIndex
CREATE INDEX "Club_city_idx" ON "Club"("city");

-- CreateIndex
CREATE INDEX "Club_ownerId_idx" ON "Club"("ownerId");

-- CreateIndex
CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");

-- CreateIndex
CREATE INDEX "Membership_clubId_status_idx" ON "Membership"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_clubId_userId_key" ON "Membership"("clubId", "userId");

-- CreateIndex
CREATE INDEX "Venue_city_status_idx" ON "Venue"("city", "status");

-- CreateIndex
CREATE INDEX "Pitch_venueId_idx" ON "Pitch"("venueId");

-- CreateIndex
CREATE INDEX "PitchPart_pitchId_idx" ON "PitchPart"("pitchId");

-- CreateIndex
CREATE INDEX "PitchConfiguration_pitchId_idx" ON "PitchConfiguration"("pitchId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingTerms_pitchId_version_key" ON "BookingTerms"("pitchId", "version");

-- CreateIndex
CREATE INDEX "Booking_pitchId_startsAt_idx" ON "Booking"("pitchId", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_bookedById_startsAt_idx" ON "Booking"("bookedById", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_status_holdExpiresAt_idx" ON "Booking"("status", "holdExpiresAt");

-- CreateIndex
CREATE INDEX "CalendarBlock_pitchId_startsAt_idx" ON "CalendarBlock"("pitchId", "startsAt");

-- CreateIndex
CREATE INDEX "PitchOccupancy_partId_startsAt_idx" ON "PitchOccupancy"("partId", "startsAt");

-- CreateIndex
CREATE INDEX "PitchOccupancy_bookingId_idx" ON "PitchOccupancy"("bookingId");

-- CreateIndex
CREATE INDEX "VenueRequest_status_createdAt_idx" ON "VenueRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VenueRequest_requestedById_idx" ON "VenueRequest"("requestedById");

-- CreateIndex
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_organiserId_startsAt_idx" ON "Event"("organiserId", "startsAt");

-- CreateIndex
CREATE INDEX "Event_clubId_startsAt_idx" ON "Event"("clubId", "startsAt");

-- CreateIndex
CREATE INDEX "Event_pitchId_startsAt_idx" ON "Event"("pitchId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventTeam_eventId_index_key" ON "EventTeam"("eventId", "index");

-- CreateIndex
CREATE INDEX "Participation_eventId_status_idx" ON "Participation"("eventId", "status");

-- CreateIndex
CREATE INDEX "Participation_userId_status_idx" ON "Participation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Participation_eventId_userId_key" ON "Participation"("eventId", "userId");

-- CreateIndex
CREATE INDEX "Invitation_inviteeId_status_respondBy_idx" ON "Invitation"("inviteeId", "status", "respondBy");

-- CreateIndex
CREATE INDEX "Invitation_eventId_status_idx" ON "Invitation"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_eventId_inviteeId_key" ON "Invitation"("eventId", "inviteeId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatHold_invitationId_key" ON "SeatHold"("invitationId");

-- CreateIndex
CREATE INDEX "SeatHold_eventId_releasedAt_expiresAt_idx" ON "SeatHold"("eventId", "releasedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "WaitlistOffer_eventId_status_expiresAt_idx" ON "WaitlistOffer"("eventId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "WaitlistOffer_userId_status_idx" ON "WaitlistOffer"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Match_fixtureId_key" ON "Match"("fixtureId");

-- CreateIndex
CREATE INDEX "Match_eventId_idx" ON "Match"("eventId");

-- CreateIndex
CREATE INDEX "MatchEvent_matchId_idx" ON "MatchEvent"("matchId");

-- CreateIndex
CREATE INDEX "MatchEvent_playerId_idx" ON "MatchEvent"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchRevision_matchId_version_key" ON "MatchRevision"("matchId", "version");

-- CreateIndex
CREATE INDEX "PaymentObligation_payerUserId_status_idx" ON "PaymentObligation"("payerUserId", "status");

-- CreateIndex
CREATE INDEX "PaymentObligation_eventId_status_idx" ON "PaymentObligation"("eventId", "status");

-- CreateIndex
CREATE INDEX "PaymentObligation_tournamentId_status_idx" ON "PaymentObligation"("tournamentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentObligation_kind_eventId_payerUserId_key" ON "PaymentObligation"("kind", "eventId", "payerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentObligation_kind_tournamentId_payerClubId_key" ON "PaymentObligation"("kind", "tournamentId", "payerClubId");

-- CreateIndex
CREATE INDEX "CashReceipt_obligationId_idx" ON "CashReceipt"("obligationId");

-- CreateIndex
CREATE INDEX "Adjustment_obligationId_idx" ON "Adjustment"("obligationId");

-- CreateIndex
CREATE INDEX "Tournament_status_startsOn_idx" ON "Tournament"("status", "startsOn");

-- CreateIndex
CREATE INDEX "Tournament_organiserId_idx" ON "Tournament"("organiserId");

-- CreateIndex
CREATE INDEX "ClubEntry_tournamentId_status_idx" ON "ClubEntry"("tournamentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClubEntry_tournamentId_clubId_key" ON "ClubEntry"("tournamentId", "clubId");

-- CreateIndex
CREATE INDEX "ClubEntryPlayer_entryId_idx" ON "ClubEntryPlayer"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubEntryPlayer_tournamentId_userId_key" ON "ClubEntryPlayer"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentStage_tournamentId_index_key" ON "TournamentStage"("tournamentId", "index");

-- CreateIndex
CREATE INDEX "Fixture_tournamentId_startsAt_idx" ON "Fixture"("tournamentId", "startsAt");

-- CreateIndex
CREATE INDEX "Fixture_stageId_round_idx" ON "Fixture"("stageId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "Standing_stageId_groupLabel_entryId_key" ON "Standing"("stageId", "groupLabel", "entryId");

-- CreateIndex
CREATE INDEX "RuleDocument_tournamentId_idx" ON "RuleDocument"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- CreateIndex
CREATE INDEX "Consent_userId_idx" ON "Consent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_versionId_userId_key" ON "Consent"("versionId", "userId");

-- CreateIndex
CREATE INDEX "Sponsor_tournamentId_idx" ON "Sponsor"("tournamentId");

-- CreateIndex
CREATE INDEX "SponsorAsset_sponsorId_idx" ON "SponsorAsset"("sponsorId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_createdAt_idx" ON "MediaAsset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Post_status_publishedAt_id_idx" ON "Post"("status", "publishedAt", "id");

-- CreateIndex
CREATE INDEX "Post_authorType_authorEntityId_publishedAt_idx" ON "Post"("authorType", "authorEntityId", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_id_idx" ON "Comment"("postId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Mention_targetType_targetId_status_idx" ON "Mention"("targetType", "targetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Mention_postId_targetType_targetId_key" ON "Mention"("postId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_directKey_key" ON "Conversation"("directKey");

-- CreateIndex
CREATE INDEX "Conversation_eventId_idx" ON "Conversation"("eventId");

-- CreateIndex
CREATE INDEX "Conversation_clubId_idx" ON "Conversation"("clubId");

-- CreateIndex
CREATE INDEX "Conversation_tournamentId_idx" ON "Conversation"("tournamentId");

-- CreateIndex
CREATE INDEX "ConversationMember_userId_idx" ON "ConversationMember"("userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_id_idx" ON "Message"("conversationId", "id");

-- CreateIndex
CREATE INDEX "ActivityItem_recipientId_createdAt_id_idx" ON "ActivityItem"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityItem_recipientId_dedupeKey_key" ON "ActivityItem"("recipientId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_recipientId_createdAt_id_idx" ON "Notification"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_delivery_createdAt_idx" ON "Notification"("delivery", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientId_dedupeKey_key" ON "Notification"("recipientId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Rating_subjectType_subjectId_idx" ON "Rating"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_authorId_subjectType_subjectId_eventId_key" ON "Rating"("authorId", "subjectType", "subjectId", "eventId");

-- CreateIndex
CREATE INDEX "Achievement_recipientId_awardedAt_idx" ON "Achievement"("recipientId", "awardedAt");

-- CreateIndex
CREATE INDEX "Achievement_clubId_idx" ON "Achievement"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_ticketNumber_key" ON "Report"("ticketNumber");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ModerationAction_targetType_targetId_idx" ON "ModerationAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx" ON "AuditEvent"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_userId_scope_key_key" ON "IdempotencyRecord"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyPolicy" ADD CONSTRAINT "PrivacyPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleGrant" ADD CONSTRAINT "RoleGrant_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleGrant" ADD CONSTRAINT "RoleGrant_sourceGrantId_fkey" FOREIGN KEY ("sourceGrantId") REFERENCES "RoleGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pitch" ADD CONSTRAINT "Pitch_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchPart" ADD CONSTRAINT "PitchPart_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchConfiguration" ADD CONSTRAINT "PitchConfiguration_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchConfigurationPart" ADD CONSTRAINT "PitchConfigurationPart_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "PitchConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchConfigurationPart" ADD CONSTRAINT "PitchConfigurationPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "PitchPart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRules" ADD CONSTRAINT "BookingRules_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingTerms" ADD CONSTRAINT "BookingTerms_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "PitchConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBlock" ADD CONSTRAINT "CalendarBlock_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT "PitchOccupancy_partId_fkey" FOREIGN KEY ("partId") REFERENCES "PitchPart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT "PitchOccupancy_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchOccupancy" ADD CONSTRAINT "PitchOccupancy_calendarBlockId_fkey" FOREIGN KEY ("calendarBlockId") REFERENCES "CalendarBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_pitchId_fkey" FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTeam" ADD CONSTRAINT "EventTeam_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participation" ADD CONSTRAINT "Participation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRevision" ADD CONSTRAINT "MatchRevision_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MvpVote" ADD CONSTRAINT "MvpVote_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentObligation" ADD CONSTRAINT "PaymentObligation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashReceipt" ADD CONSTRAINT "CashReceipt_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntry" ADD CONSTRAINT "ClubEntry_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntry" ADD CONSTRAINT "ClubEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEntryPlayer" ADD CONSTRAINT "ClubEntryPlayer_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ClubEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentStage" ADD CONSTRAINT "TournamentStage_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fixture" ADD CONSTRAINT "Fixture_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fixture" ADD CONSTRAINT "Fixture_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "TournamentStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Standing" ADD CONSTRAINT "Standing_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "TournamentStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleDocument" ADD CONSTRAINT "RuleDocument_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RuleDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorAsset" ADD CONSTRAINT "SponsorAsset_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

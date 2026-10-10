import type { GrantResourceType } from '@prisma/client';

/**
 * Permission catalogue. A permission is an *action*; role titles never grant anything.
 * `delegable: false` permissions can only be given by the structural authority (owner /
 * organiser / staff admin) and can never be passed on.
 */
export const Permission = {
  // Club
  CLUB_MEMBERS_INVITE: 'club.members.invite',
  CLUB_MEMBERS_APPROVE: 'club.members.approve',
  CLUB_MEMBERS_REMOVE: 'club.members.remove',
  CLUB_SQUAD_MANAGE: 'club.squad.manage',
  CLUB_GAMES_ORGANISE: 'club.games.organise',
  CLUB_CAPTAINS_APPOINT: 'club.captains.appoint',
  CLUB_RESULTS_RECORD: 'club.results.record',
  CLUB_RESULTS_CONFIRM: 'club.results.confirm',
  CLUB_POSTS_PUBLISH: 'club.posts.publish',
  CLUB_POSTS_MANAGE: 'club.posts.manage',
  CLUB_MENTIONS_MODERATE: 'club.mentions.moderate',
  CLUB_PROFILE_EDIT: 'club.profile.edit',
  CLUB_AWARDS_MANAGE: 'club.awards.manage',
  CLUB_MONEY_VIEW: 'club.money.view',
  CLUB_MONEY_CONFIRM_CASH: 'club.money.confirmCash',
  CLUB_MONEY_CHANGE_FEES: 'club.money.changeFees',
  CLUB_MONEY_CORRECT: 'club.money.correct',
  CLUB_MONEY_REFUND: 'club.money.refund',
  CLUB_TOURNAMENT_ENTER: 'club.tournaments.enter',
  CLUB_BOOKINGS_REQUEST: 'club.bookings.request',
  // Event (game)
  EVENT_MANAGE: 'event.manage',
  EVENT_SQUAD_MANAGE: 'event.squad.manage',
  EVENT_REQUESTS_DECIDE: 'event.requests.decide',
  EVENT_RESULTS_RECORD: 'event.results.record',
  EVENT_RESULTS_CONFIRM: 'event.results.confirm',
  EVENT_MONEY_VIEW: 'event.money.view',
  EVENT_CASH_CONFIRM: 'event.cash.confirm',
  EVENT_CASH_CORRECT: 'event.cash.correct',
  EVENT_FEES_CHANGE: 'event.fees.change',
  // Venue / pitch (granted by Let'sGo staff; managers may delegate booking work)
  VENUE_MANAGE: 'venue.manage',
  PITCH_MANAGE: 'pitch.manage',
  PITCH_CALENDAR_MANAGE: 'pitch.calendar.manage',
  PITCH_BOOKINGS_DECIDE: 'pitch.bookings.decide',
  // Tournament (assistants receive module permissions; max two assistants)
  TOURNAMENT_MANAGE: 'tournament.manage',
  TOURNAMENT_APPLICATIONS: 'tournament.applications',
  TOURNAMENT_SCHEDULE: 'tournament.schedule',
  TOURNAMENT_PROTOCOLS: 'tournament.protocols',
  TOURNAMENT_CASH: 'tournament.cash',
  TOURNAMENT_SPONSORS: 'tournament.sponsors',
  // Platform staff (scoped; there is no blanket admin flag)
  ADMIN_VENUE_REQUESTS: 'admin.venueRequests.review',
  ADMIN_REPORTS: 'admin.reports.moderate',
  ADMIN_RECOVERY: 'admin.accounts.recover',
  ADMIN_CATALOG: 'admin.catalog.manage',
  ADMIN_ACHIEVEMENTS: 'admin.achievements.grant',
  ADMIN_AUDIT_READ: 'admin.audit.read',
  ADMIN_STAFF: 'admin.staff.manage',
  ADMIN_MAINTENANCE: 'admin.maintenance.run',
} as const;

export type PermissionName = (typeof Permission)[keyof typeof Permission];

interface PermissionDef {
  resources: GrantResourceType[];
  delegable: boolean;
}

const club = (delegable = true): PermissionDef => ({ resources: ['CLUB'], delegable });
const event = (delegable = true): PermissionDef => ({ resources: ['EVENT'], delegable });

export const PERMISSION_CATALOG: Record<PermissionName, PermissionDef> = {
  'club.members.invite': club(),
  'club.members.approve': club(),
  'club.members.remove': club(false),
  'club.squad.manage': { resources: ['CLUB', 'EVENT'], delegable: true },
  'club.games.organise': club(),
  'club.captains.appoint': club(),
  'club.results.record': { resources: ['CLUB', 'EVENT'], delegable: true },
  'club.results.confirm': club(),
  'club.posts.publish': club(),
  'club.posts.manage': club(),
  'club.mentions.moderate': club(),
  'club.profile.edit': club(false),
  'club.awards.manage': club(),
  'club.money.view': club(),
  'club.money.confirmCash': club(),
  'club.money.changeFees': club(false),
  'club.money.correct': club(false),
  'club.money.refund': club(false),
  'club.tournaments.enter': club(),
  'club.bookings.request': club(),
  'event.manage': event(),
  'event.squad.manage': event(),
  'event.requests.decide': event(),
  'event.results.record': event(),
  'event.results.confirm': event(),
  'event.money.view': event(),
  'event.cash.confirm': event(),
  'event.cash.correct': event(false),
  'event.fees.change': event(false),
  'venue.manage': { resources: ['VENUE'], delegable: false },
  'pitch.manage': { resources: ['PITCH', 'VENUE'], delegable: false },
  'pitch.calendar.manage': { resources: ['PITCH', 'VENUE'], delegable: true },
  'pitch.bookings.decide': { resources: ['PITCH', 'VENUE'], delegable: true },
  'tournament.manage': { resources: ['TOURNAMENT'], delegable: false },
  'tournament.applications': { resources: ['TOURNAMENT'], delegable: false },
  'tournament.schedule': { resources: ['TOURNAMENT'], delegable: false },
  'tournament.protocols': { resources: ['TOURNAMENT'], delegable: false },
  'tournament.cash': { resources: ['TOURNAMENT'], delegable: false },
  'tournament.sponsors': { resources: ['TOURNAMENT'], delegable: false },
  'admin.venueRequests.review': { resources: ['PLATFORM'], delegable: false },
  'admin.reports.moderate': { resources: ['PLATFORM'], delegable: false },
  'admin.accounts.recover': { resources: ['PLATFORM'], delegable: false },
  'admin.catalog.manage': { resources: ['PLATFORM'], delegable: false },
  'admin.achievements.grant': { resources: ['PLATFORM'], delegable: false },
  'admin.audit.read': { resources: ['PLATFORM'], delegable: false },
  'admin.staff.manage': { resources: ['PLATFORM'], delegable: false },
  'admin.maintenance.run': { resources: ['PLATFORM'], delegable: false },
};

export function isKnownPermission(value: string): value is PermissionName {
  return Object.prototype.hasOwnProperty.call(PERMISSION_CATALOG, value);
}

/**
 * An event-level permission is also satisfied by the equivalent grant on the event's club,
 * so a club coach with `club.squad.manage` can run the club's games without per-event grants.
 */
export const EVENT_TO_CLUB_PERMISSION: Partial<Record<PermissionName, PermissionName>> = {
  'event.manage': 'club.games.organise',
  'event.squad.manage': 'club.squad.manage',
  'event.requests.decide': 'club.members.approve',
  'event.results.record': 'club.results.record',
  'event.results.confirm': 'club.results.confirm',
  'event.money.view': 'club.money.view',
  'event.cash.confirm': 'club.money.confirmCash',
  'event.cash.correct': 'club.money.correct',
  'event.fees.change': 'club.money.changeFees',
};

/** Pitch-level permission satisfied by a venue-level grant of the same name. */
export const PITCH_INHERITS_VENUE = true;

import { Injectable } from '@nestjs/common';
import type { ConsentRole, DocumentVersion, RuleDocument, Tournament } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import {
  ConsentDto,
  ConsentMatrixDto,
  DocumentDto,
  DocumentVersionDto,
  RemindResultDto,
  RequiredDocumentDto,
  type ConsentRequestDto,
  type CreateDocumentDto,
  type NewDocumentVersionDto,
  type RemindDto,
  type UpdateDocumentDto,
} from './dto/documents.dto';
import {
  ACTIVE_ENTRY,
  NOT_AVAILABLE,
  TournamentAccess,
  lockTournament,
} from './tournament-access.service';
import { assertReadyMedia } from './tournament-support';

type DocWithVersions = RuleDocument & { versions: DocumentVersion[] };

const versionDto = (v: DocumentVersion): DocumentVersionDto => ({
  id: v.id,
  version: v.version,
  fileMediaId: v.fileMediaId,
  checksum: v.checksum,
  createdAt: v.createdAt.toISOString(),
});

/**
 * Documents and PERSONAL consents (Decisions §33, §44.7).
 *  - versions are append-only; a new version needs a new personal acceptance from the audience,
 *    older acceptances stay as history (Consent rows are immutable in the DB);
 *  - a club representative accepts as CLUB_REP for himself and can NEVER accept for players;
 *  - opening a file is not consent: the only way to accept is the explicit consent call naming
 *    the version the person saw.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
  ) {}

  private toDto(d: DocWithVersions): DocumentDto {
    const versions = [...d.versions].sort((a, b) => b.version - a.version);
    const current = versions.find((v) => v.id === d.currentVersionId) ?? null;
    return {
      id: d.id,
      tournamentId: d.tournamentId,
      title: d.title,
      audience: d.audience,
      mandatory: d.mandatory,
      language: d.language,
      currentVersion: current ? versionDto(current) : null,
      versions: versions.map(versionDto),
      createdAt: d.createdAt.toISOString(),
    };
  }

  async list(viewerId: string | null, tournamentId: string): Promise<DocumentDto[]> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    const docs = await this.prisma.ruleDocument.findMany({
      where: { tournamentId: t.id },
      include: { versions: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return docs.map((d) => this.toDto(d));
  }

  async create(
    actorId: string,
    tournamentId: string,
    dto: CreateDocumentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<DocumentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.doc.create:${tournamentId}`, key, payload: dto },
      async (tx) => {
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertOrganiser(actorId, t);
        this.access.assertNotTerminal(t);
        await assertReadyMedia(tx, dto.fileMediaId, actorId, ['DOCUMENT', 'PHOTO'], 'fileMediaId');
        const doc = await tx.ruleDocument.create({
          data: {
            tournamentId,
            title: dto.title,
            audience: dto.audience,
            mandatory: dto.mandatory ?? true,
            language: dto.language ?? null,
            createdById: actorId,
          },
        });
        const v = await tx.documentVersion.create({
          data: {
            documentId: doc.id,
            version: 1,
            fileMediaId: dto.fileMediaId,
            checksum: dto.checksum ?? null,
            createdById: actorId,
          },
        });
        const updated = await tx.ruleDocument.update({
          where: { id: doc.id },
          data: { currentVersionId: v.id },
          include: { versions: true },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.document.create',
          targetType: 'RuleDocument',
          targetId: doc.id,
          requestId,
          metadata: { tournamentId, audience: dto.audience, mandatory: updated.mandatory },
        });
        await this.notifyAssigned(tx, t, updated, 'A tournament document was added');
        return this.toDto(updated);
      },
    );
  }

  async update(
    actorId: string,
    tournamentId: string,
    documentId: string,
    dto: UpdateDocumentDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<DocumentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.doc.update:${documentId}`, key, payload: dto },
      async (tx) => {
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertOrganiser(actorId, t);
        this.access.assertNotTerminal(t);
        const doc = await this.mustDoc(tx, tournamentId, documentId);
        const updated = await tx.ruleDocument.update({
          where: { id: doc.id },
          data: {
            title: dto.title ?? undefined,
            audience: dto.audience ?? undefined,
            mandatory: dto.mandatory ?? undefined,
            language: dto.language === undefined ? undefined : dto.language,
          },
          include: { versions: true },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.document.update',
          targetType: 'RuleDocument',
          targetId: doc.id,
          requestId,
          metadata: { tournamentId, changed: Object.keys(dto) },
        });
        return this.toDto(updated);
      },
    );
  }

  /** New file content = new version. Readiness is invalidated until the audience accepts it. */
  async addVersion(
    actorId: string,
    tournamentId: string,
    documentId: string,
    dto: NewDocumentVersionDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<DocumentDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.doc.version:${documentId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertOrganiser(actorId, t);
        this.access.assertNotTerminal(t);
        const doc = await this.mustDoc(tx, tournamentId, documentId);
        await assertReadyMedia(tx, dto.fileMediaId, actorId, ['DOCUMENT', 'PHOTO'], 'fileMediaId');
        const last = await tx.documentVersion.aggregate({
          where: { documentId },
          _max: { version: true },
        });
        const v = await tx.documentVersion.create({
          data: {
            documentId,
            version: (last._max.version ?? 0) + 1,
            fileMediaId: dto.fileMediaId,
            checksum: dto.checksum ?? null,
            createdById: actorId,
          },
        });
        const updated = await tx.ruleDocument.update({
          where: { id: doc.id },
          data: { currentVersionId: v.id },
          include: { versions: true },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.document.version',
          targetType: 'RuleDocument',
          targetId: doc.id,
          requestId,
          metadata: { tournamentId, version: v.version },
        });
        // A notice is NOT a consent - it only tells people that a new acceptance is needed.
        await this.notifyAssigned(
          tx,
          t,
          updated,
          'A tournament document has a new version that needs your acceptance',
          v.id,
        );
        return this.toDto(updated);
      },
    );
  }

  // ───────────── roles & required documents ─────────────

  /** The representative / player roles the person holds in this tournament. */
  async rolesOf(db: Db, userId: string, t: Pick<Tournament, 'id'>): Promise<Set<ConsentRole>> {
    const roles = new Set<ConsentRole>();
    const enterClubs = await this.access.clubsFor(db, userId, ['club.tournaments.enter']);
    if (enterClubs.length > 0) roles.add('CLUB_REP');
    else if (
      await db.clubEntry.findFirst({
        where: { tournamentId: t.id, submittedById: userId, status: { in: [...ACTIVE_ENTRY] } },
        select: { id: true },
      })
    ) {
      roles.add('CLUB_REP');
    }
    const player = await db.clubEntryPlayer.findFirst({
      where: { tournamentId: t.id, userId, status: { in: ['INVITED', 'CONFIRMED'] } },
      select: { id: true },
    });
    if (player) roles.add('PLAYER');
    return roles;
  }

  private applicableRoles(
    audience: RuleDocument['audience'],
    mine: Set<ConsentRole>,
  ): ConsentRole[] {
    const out: ConsentRole[] = [];
    if (audience !== 'PLAYERS' && mine.has('CLUB_REP')) out.push('CLUB_REP');
    if (audience !== 'CLUB_REPS' && mine.has('PLAYER')) out.push('PLAYER');
    return out;
  }

  /** Only the documents assigned to MY role(s) in this tournament, with my acceptance state. */
  async requiredFor(
    db: Db,
    userId: string,
    t: Pick<Tournament, 'id'>,
  ): Promise<RequiredDocumentDto[]> {
    const mine = await this.rolesOf(db, userId, t);
    if (mine.size === 0) return [];
    const docs = await db.ruleDocument.findMany({
      where: { tournamentId: t.id, currentVersionId: { not: null } },
      include: { versions: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const consents = await db.consent.findMany({
      where: { userId, versionId: { in: docs.flatMap((d) => d.versions.map((v) => v.id)) } },
    });
    const out: RequiredDocumentDto[] = [];
    for (const d of docs) {
      const roles = this.applicableRoles(d.audience, mine);
      if (roles.length === 0) continue;
      const current = d.versions.find((v) => v.id === d.currentVersionId);
      if (!current) continue;
      const mineOnCurrent = consents.find((c) => c.versionId === current.id);
      const older = consents.some(
        (c) => c.versionId !== current.id && d.versions.some((v) => v.id === c.versionId),
      );
      out.push({
        documentId: d.id,
        title: d.title,
        audience: d.audience,
        mandatory: d.mandatory,
        language: d.language,
        currentVersion: versionDto(current),
        roles,
        accepted: !!mineOnCurrent,
        acceptedAt: mineOnCurrent?.acceptedAt.toISOString() ?? null,
        acceptedOlderVersion: !mineOnCurrent && older,
      });
    }
    return out;
  }

  async required(userId: string, tournamentId: string): Promise<RequiredDocumentDto[]> {
    const t = await this.access.loadVisible(this.prisma, userId, tournamentId);
    return this.requiredFor(this.prisma, userId, t);
  }

  // ───────────── consent ─────────────

  async consent(
    userId: string,
    tournamentId: string,
    documentId: string,
    dto: ConsentRequestDto,
    key: string | undefined,
  ): Promise<ConsentDto> {
    return this.idempotency.execute(
      { userId, scope: `tournaments.consent:${documentId}`, key, payload: dto },
      async (tx) => {
        const t = await this.access.loadVisible(tx, userId, tournamentId);
        this.access.assertNotTerminal(t);
        const doc = await this.mustDoc(tx, tournamentId, documentId);
        const mine = await this.rolesOf(tx, userId, t);
        const roles = this.applicableRoles(doc.audience, mine);
        if (roles.length === 0) {
          // A representative asking to accept a PLAYERS document (or anyone outside the audience)
          throw new ApiError(
            ErrorCode.ACCESS_DENIED,
            'This document is not assigned to you; everybody accepts their own documents personally',
            { reason: 'NOT_IN_AUDIENCE' },
          );
        }
        const current = doc.versions.find((v) => v.id === doc.currentVersionId);
        if (!current) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (dto.versionId !== current.id) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'The document has a newer version', {
            currentVersionId: current.id,
            currentVersion: current.version,
          });
        }
        const role: ConsentRole = roles.includes('CLUB_REP') ? 'CLUB_REP' : 'PLAYER';
        await tx.consent.createMany({
          data: [{ versionId: current.id, userId, role }],
          skipDuplicates: true,
        });
        const row = await tx.consent.findUniqueOrThrow({
          where: { versionId_userId: { versionId: current.id, userId } },
        });
        return {
          id: row.id,
          documentId: doc.id,
          versionId: current.id,
          version: current.version,
          role: row.role,
          acceptedAt: row.acceptedAt.toISOString(),
        };
      },
    );
  }

  // ───────────── organiser: who is missing what ─────────────

  private async missingList(db: Db, t: Tournament) {
    const docs = await db.ruleDocument.findMany({
      where: { tournamentId: t.id, mandatory: true, currentVersionId: { not: null } },
      include: { versions: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const current = docs.flatMap((d) => {
      const v = d.versions.find((x) => x.id === d.currentVersionId);
      return v ? [{ doc: d, version: v }] : [];
    });
    const entries = await db.clubEntry.findMany({
      where: { tournamentId: t.id, status: { in: ['APPLIED', 'ACCEPTED', 'WAITLISTED'] } },
      include: { club: { select: { name: true } }, players: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const userIds = entries.flatMap((e) => [
      e.submittedById,
      ...e.players.filter((p) => ['INVITED', 'CONFIRMED'].includes(p.status)).map((p) => p.userId),
    ]);
    const consents = await db.consent.findMany({
      where: { versionId: { in: current.map((c) => c.version.id) }, userId: { in: userIds } },
      select: { versionId: true, userId: true },
    });
    const has = new Set(consents.map((c) => `${c.versionId}:${c.userId}`));
    const missingFor = (userId: string, role: ConsentRole): string[] =>
      current
        .filter(({ doc }) => this.applicableRoles(doc.audience, new Set([role])).length > 0)
        .filter(({ version }) => !has.has(`${version.id}:${userId}`))
        .map(({ doc }) => doc.id);
    return { current, entries, missingFor };
  }

  async matrix(actorId: string, tournamentId: string): Promise<ConsentMatrixDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    await this.access.assertCan(this.prisma, actorId, 'tournament.applications', t);
    const { current, entries, missingFor } = await this.missingList(this.prisma, t);
    const people = await loadPersonSummaries(
      this.prisma,
      entries.flatMap((e) => [e.submittedById, ...e.players.map((p) => p.userId)]),
    );
    let missingPeople = 0;
    const rows = entries.map((e) => {
      const list = [
        {
          person: personOrUnknown(people, e.submittedById),
          role: 'CLUB_REP',
          missingDocumentIds: missingFor(e.submittedById, 'CLUB_REP'),
        },
        ...e.players
          .filter((p) => ['INVITED', 'CONFIRMED'].includes(p.status))
          .map((p) => ({
            person: personOrUnknown(people, p.userId),
            role: 'PLAYER',
            missingDocumentIds: missingFor(p.userId, 'PLAYER'),
          })),
      ];
      missingPeople += list.filter((x) => x.missingDocumentIds.length > 0).length;
      return {
        entryId: e.id,
        clubId: e.clubId,
        clubName: e.club.name,
        status: e.status,
        people: list,
      };
    });
    return {
      documents: current.map(({ doc, version }) => ({
        id: doc.id,
        title: doc.title,
        audience: doc.audience,
        mandatory: doc.mandatory,
        version: version.version,
      })),
      entries: rows,
      missingPeople,
    };
  }

  async remind(
    actorId: string,
    tournamentId: string,
    dto: RemindDto,
    key: string | undefined,
  ): Promise<RemindResultDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.consent.remind:${tournamentId}`, key, payload: dto },
      async (tx) => {
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.access.assertCan(tx, actorId, 'tournament.applications', t);
        this.access.assertNotTerminal(t);
        const { entries, missingFor } = await this.missingList(tx, t);
        const targets = new Map<string, Set<string>>();
        const add = (userId: string, missing: string[]) => {
          if (dto.userIds && !dto.userIds.includes(userId)) return;
          const wanted = dto.documentId ? missing.filter((m) => m === dto.documentId) : missing;
          if (wanted.length === 0) return;
          const set = targets.get(userId) ?? new Set<string>();
          wanted.forEach((w) => set.add(w));
          targets.set(userId, set);
        };
        for (const e of entries) {
          add(e.submittedById, missingFor(e.submittedById, 'CLUB_REP'));
          for (const p of e.players.filter((x) => ['INVITED', 'CONFIRMED'].includes(x.status))) {
            add(p.userId, missingFor(p.userId, 'PLAYER'));
          }
        }
        for (const [userId, docs] of targets) {
          await this.notifier.notify(tx, {
            recipientIds: [userId],
            category: 'tournament',
            activityKind: 'tournament.consent_reminder',
            title: 'Please read and accept the tournament documents',
            objectType: 'Tournament',
            objectId: t.id,
            actorId,
            essential: true,
            payload: { tournamentId: t.id, missingCount: docs.size },
          });
        }
        return { reminded: targets.size };
      },
    );
  }

  // ───────────── internals ─────────────

  private async mustDoc(
    db: Db,
    tournamentId: string,
    documentId: string,
  ): Promise<DocWithVersions> {
    const doc = await db.ruleDocument.findUnique({
      where: { id: documentId },
      include: { versions: true },
    });
    if (!doc || doc.tournamentId !== tournamentId) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return doc;
  }

  /** Tells the assigned audience (active reps and squad members) that a document needs attention. */
  private async notifyAssigned(
    tx: Db,
    t: Tournament,
    doc: RuleDocument,
    title: string,
    versionId?: string,
  ): Promise<void> {
    const entries = await tx.clubEntry.findMany({
      where: { tournamentId: t.id, status: { in: [...ACTIVE_ENTRY] } },
      include: { players: { where: { status: { in: ['INVITED', 'CONFIRMED'] } } } },
    });
    const recipients = new Set<string>();
    if (doc.audience !== 'PLAYERS') {
      for (const e of entries) {
        if (e.status !== 'INVITED') recipients.add(e.submittedById);
      }
    }
    if (doc.audience !== 'CLUB_REPS') {
      for (const e of entries) e.players.forEach((p) => recipients.add(p.userId));
    }
    await this.notifier.notify(tx, {
      recipientIds: [...recipients],
      category: 'tournament',
      activityKind: 'tournament.document_changed',
      title,
      objectType: 'Tournament',
      objectId: t.id,
      actorId: t.organiserId,
      essential: true,
      payload: { tournamentId: t.id, documentId: doc.id },
      dedupeKey: versionId ? `tournament-doc:${versionId}` : `tournament-doc:${doc.id}:new`,
    });
  }
}

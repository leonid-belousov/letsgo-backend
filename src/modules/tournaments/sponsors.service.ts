import { Injectable } from '@nestjs/common';
import type { Sponsor, SponsorAsset, Tournament } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type {
  AddSponsorAssetDto,
  CreateSponsorDto,
  ReorderDto,
  SetMainSponsorDto,
  SponsorDto,
  SponsorListDto,
  UpdateSponsorAssetDto,
  UpdateSponsorDto,
} from './dto/sponsors.dto';
import { NOT_AVAILABLE, TournamentAccess, lockTournament } from './tournament-access.service';
import { assertReadyMedia } from './tournament-support';

type SponsorRow = Sponsor & { assets: SponsorAsset[] };

/**
 * Sponsors (Decisions §35): editable in EVERY tournament stage (draft ... finished), by the
 * chief organiser or a `tournament.sponsors` assistant. Sponsors have no accounts and editing
 * them never touches documents or consents. Only the designated Main sponsor shows on the card.
 */
@Injectable()
export class SponsorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  private async canEdit(db: Db, userId: string | null, t: Tournament): Promise<boolean> {
    if (!userId) return false;
    return this.access.canAny(db, userId, ['tournament.sponsors'], t);
  }

  private async assertEdit(db: Db, userId: string, t: Tournament): Promise<void> {
    if (!(await this.canEdit(db, userId, t))) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  private toDto(t: Tournament, s: SponsorRow, manager: boolean): SponsorDto {
    return {
      id: s.id,
      tournamentId: s.tournamentId,
      name: s.name,
      logoMediaId: s.logoMediaId,
      externalUrl: s.externalUrl,
      sortOrder: s.sortOrder,
      hidden: s.hiddenAt !== null,
      isMain: t.mainSponsorId === s.id,
      assets: s.assets
        .filter((a) => manager || a.hiddenAt === null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          mediaId: a.mediaId,
          sortOrder: a.sortOrder,
          hidden: a.hiddenAt !== null,
        })),
    };
  }

  private async load(db: Db, t: Tournament, manager: boolean): Promise<SponsorListDto> {
    const rows = await db.sponsor.findMany({
      where: { tournamentId: t.id, ...(manager ? {} : { hiddenAt: null }) },
      include: { assets: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((s) => this.toDto(t, s, manager)),
      mainSponsorId: rows.some((r) => r.id === t.mainSponsorId) ? t.mainSponsorId : null,
    };
  }

  async list(viewerId: string | null, tournamentId: string): Promise<SponsorListDto> {
    const t = await this.access.loadVisible(this.prisma, viewerId, tournamentId);
    return this.load(this.prisma, t, await this.canEdit(this.prisma, viewerId, t));
  }

  private async within<T>(
    actorId: string,
    tournamentId: string,
    scope: string,
    key: string | undefined,
    payload: unknown,
    work: (tx: Db, t: Tournament) => Promise<T>,
  ): Promise<T> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.sponsor.${scope}:${tournamentId}`, key, payload },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.assertEdit(tx, actorId, t);
        return work(tx, t);
      },
    );
  }

  private async mustSponsor(db: Db, t: Tournament, sponsorId: string): Promise<SponsorRow> {
    const s = await db.sponsor.findUnique({ where: { id: sponsorId }, include: { assets: true } });
    if (!s || s.tournamentId !== t.id) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return s;
  }

  private async record(
    actorId: string,
    tx: Db,
    action: string,
    id: string,
    requestId?: string,
    metadata?: object,
  ) {
    // `tx` is always a transaction client here
    await this.audit.record(tx as Parameters<AuditService['record']>[0], {
      actorId,
      action: `tournament.sponsor.${action}`,
      targetType: 'Sponsor',
      targetId: id,
      requestId,
      metadata,
    });
  }

  async create(
    actorId: string,
    tournamentId: string,
    dto: CreateSponsorDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<SponsorDto> {
    return this.within(actorId, tournamentId, 'create', key, dto, async (tx, t) => {
      if (dto.logoMediaId)
        await assertReadyMedia(tx, dto.logoMediaId, actorId, ['PHOTO'], 'logoMediaId');
      const last = await tx.sponsor.aggregate({
        where: { tournamentId },
        _max: { sortOrder: true },
      });
      const s = await tx.sponsor.create({
        data: {
          tournamentId,
          name: dto.name.trim(),
          logoMediaId: dto.logoMediaId ?? null,
          externalUrl: dto.externalUrl ?? null,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
        include: { assets: true },
      });
      await this.record(actorId, tx, 'create', s.id, requestId, { tournamentId });
      return this.toDto(t, s, true);
    });
  }

  async update(
    actorId: string,
    tournamentId: string,
    sponsorId: string,
    dto: UpdateSponsorDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<SponsorDto> {
    return this.within(actorId, tournamentId, `update:${sponsorId}`, key, dto, async (tx, t) => {
      const s = await this.mustSponsor(tx, t, sponsorId);
      if (dto.logoMediaId)
        await assertReadyMedia(tx, dto.logoMediaId, actorId, ['PHOTO'], 'logoMediaId');
      const updated = await tx.sponsor.update({
        where: { id: s.id },
        data: {
          name: dto.name?.trim(),
          logoMediaId: dto.logoMediaId,
          externalUrl: dto.externalUrl,
          hiddenAt:
            dto.hidden === undefined ? undefined : dto.hidden ? (s.hiddenAt ?? new Date()) : null,
        },
        include: { assets: true },
      });
      let tour = t;
      if (dto.hidden && t.mainSponsorId === s.id) {
        // a hidden sponsor can never be the card's Main sponsor
        tour = await tx.tournament.update({ where: { id: t.id }, data: { mainSponsorId: null } });
      }
      await this.record(actorId, tx, 'update', s.id, requestId, { changed: Object.keys(dto) });
      return this.toDto(tour, updated, true);
    });
  }

  async reorder(
    actorId: string,
    tournamentId: string,
    dto: ReorderDto,
    key: string | undefined,
  ): Promise<SponsorListDto> {
    return this.within(actorId, tournamentId, 'reorder', key, dto, async (tx, t) => {
      const all = await tx.sponsor.findMany({ where: { tournamentId }, select: { id: true } });
      if (all.length !== dto.ids.length || !all.every((s) => dto.ids.includes(s.id))) {
        throw new ApiError(
          ErrorCode.VALIDATION,
          'Give every sponsor of this tournament exactly once',
          { field: 'ids' },
        );
      }
      for (const [i, id] of dto.ids.entries())
        await tx.sponsor.update({ where: { id }, data: { sortOrder: i + 1 } });
      return this.load(tx, t, true);
    });
  }

  async setMain(
    actorId: string,
    tournamentId: string,
    dto: SetMainSponsorDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<SponsorListDto> {
    return this.within(actorId, tournamentId, 'main', key, dto, async (tx, t) => {
      const id = dto.sponsorId ?? null;
      if (id) {
        const s = await this.mustSponsor(tx, t, id);
        if (s.hiddenAt)
          throw new ApiError(ErrorCode.CONFLICT, 'A hidden sponsor cannot be the Main sponsor');
      }
      const updated = await tx.tournament.update({
        where: { id: t.id },
        data: { mainSponsorId: id },
      });
      await this.record(actorId, tx, 'set_main', id ?? t.id, requestId, {
        tournamentId,
        sponsorId: id,
      });
      return this.load(tx, updated, true);
    });
  }

  async addAsset(
    actorId: string,
    tournamentId: string,
    sponsorId: string,
    dto: AddSponsorAssetDto,
    key: string | undefined,
  ): Promise<SponsorDto> {
    return this.within(actorId, tournamentId, `asset:${sponsorId}`, key, dto, async (tx, t) => {
      const s = await this.mustSponsor(tx, t, sponsorId);
      await assertReadyMedia(tx, dto.mediaId, actorId, ['PHOTO', 'VIDEO'], 'mediaId');
      const last = await tx.sponsorAsset.aggregate({
        where: { sponsorId },
        _max: { sortOrder: true },
      });
      await tx.sponsorAsset.create({
        data: { sponsorId, mediaId: dto.mediaId, sortOrder: (last._max.sortOrder ?? 0) + 1 },
      });
      return this.toDto(t, await this.mustSponsor(tx, t, s.id), true);
    });
  }

  async updateAsset(
    actorId: string,
    tournamentId: string,
    sponsorId: string,
    assetId: string,
    dto: UpdateSponsorAssetDto,
    key: string | undefined,
  ): Promise<SponsorDto> {
    return this.within(
      actorId,
      tournamentId,
      `asset-update:${assetId}`,
      key,
      dto,
      async (tx, t) => {
        const s = await this.mustSponsor(tx, t, sponsorId);
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        await tx.sponsorAsset.update({
          where: { id: a.id },
          data: { hiddenAt: dto.hidden ? (a.hiddenAt ?? new Date()) : null },
        });
        return this.toDto(t, await this.mustSponsor(tx, t, s.id), true);
      },
    );
  }

  async deleteAsset(
    actorId: string,
    tournamentId: string,
    sponsorId: string,
    assetId: string,
    key: string | undefined,
  ): Promise<SponsorDto> {
    return this.within(actorId, tournamentId, `asset-delete:${assetId}`, key, {}, async (tx, t) => {
      const s = await this.mustSponsor(tx, t, sponsorId);
      await tx.sponsorAsset.deleteMany({ where: { id: assetId, sponsorId } });
      return this.toDto(t, await this.mustSponsor(tx, t, s.id), true);
    });
  }

  async reorderAssets(
    actorId: string,
    tournamentId: string,
    sponsorId: string,
    dto: ReorderDto,
    key: string | undefined,
  ): Promise<SponsorDto> {
    return this.within(
      actorId,
      tournamentId,
      `asset-order:${sponsorId}`,
      key,
      dto,
      async (tx, t) => {
        const s = await this.mustSponsor(tx, t, sponsorId);
        if (s.assets.length !== dto.ids.length || !s.assets.every((a) => dto.ids.includes(a.id))) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'Give every material of this sponsor exactly once',
            { field: 'ids' },
          );
        }
        for (const [i, id] of dto.ids.entries())
          await tx.sponsorAsset.update({ where: { id }, data: { sortOrder: i + 1 } });
        return this.toDto(t, await this.mustSponsor(tx, t, s.id), true);
      },
    );
  }
}

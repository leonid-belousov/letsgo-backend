import { Injectable } from '@nestjs/common';
import type { Fixture, TournamentStage } from '@prisma/client';
import type { Db } from '../../common/transactions/tx';
import type { ClubRefDto } from './dto/entries.dto';
import type { FixtureDto, FixtureSideDto, ShootoutDto } from './dto/structure.dto';
import { roundLabel } from './logic/bracket';
import { readConfig } from './logic/stage-config';

export const RANK_RE = /^RANK:(\d+):(.*):(\d+)$/;
export const REF_RE = /^([WL]):([0-9a-f-]{36})$/;

export interface FixtureContext {
  stages: Map<string, TournamentStage>;
  fixtures: Fixture[];
  clubs: Map<string, ClubRefDto>;
  shootouts: Map<string, ShootoutDto>;
}

export function winnerOf(
  f: Pick<Fixture, 'homeEntryId' | 'awayEntryId' | 'homeScore' | 'awayScore' | 'status'>,
  s: ShootoutDto | undefined,
) {
  if (f.status !== 'FINISHED' || f.homeScore === null || f.awayScore === null) return null;
  if (!f.homeEntryId || !f.awayEntryId) return null;
  if (f.homeScore !== f.awayScore) {
    return f.homeScore > f.awayScore
      ? { winner: f.homeEntryId, loser: f.awayEntryId }
      : { winner: f.awayEntryId, loser: f.homeEntryId };
  }
  if (s && s.home !== s.away) {
    return s.home > s.away
      ? { winner: f.homeEntryId, loser: f.awayEntryId }
      : { winner: f.awayEntryId, loser: f.homeEntryId };
  }
  return null;
}

/** Position of a fixture inside its round, encoded in groupLabel for knockouts (P<n> / THIRD). */
export function knockoutPos(f: Pick<Fixture, 'groupLabel'>): { pos: number; third: boolean } {
  if (f.groupLabel === 'THIRD') return { pos: 99, third: true };
  const m = /^P(\d+)$/.exec(f.groupLabel ?? '');
  return { pos: m ? Number(m[1]) : 1, third: false };
}

@Injectable()
export class FixtureViewService {
  /** Loads everything needed to render fixtures of a tournament. */
  async context(db: Db, tournamentId: string): Promise<FixtureContext> {
    const [stages, fixtures] = await Promise.all([
      db.tournamentStage.findMany({ where: { tournamentId } }),
      db.fixture.findMany({ where: { tournamentId } }),
    ]);
    const entryIds = [
      ...new Set(
        fixtures.flatMap((f) => [f.homeEntryId, f.awayEntryId]).filter((x): x is string => !!x),
      ),
    ];
    const entries = await db.clubEntry.findMany({
      where: { id: { in: entryIds } },
      include: { club: { select: { id: true, name: true, username: true } } },
    });
    const shootouts = new Map<string, ShootoutDto>();
    for (const s of stages) {
      for (const [fid, v] of Object.entries(readConfig(s.config).shootouts ?? {}))
        shootouts.set(fid, v);
    }
    return {
      stages: new Map(stages.map((s) => [s.id, s])),
      fixtures,
      clubs: new Map(entries.map((e) => [e.id, e.club])),
      shootouts,
    };
  }

  label(ctx: FixtureContext, f: Fixture): string {
    const stage = ctx.stages.get(f.stageId);
    if (!stage) return `Round ${f.round}`;
    switch (stage.kind) {
      case 'GROUP':
        return `${stage.name} - Group ${f.groupLabel ?? ''} - round ${f.round}`;
      case 'KNOCKOUT': {
        const same = ctx.fixtures.filter((x) => x.stageId === f.stageId);
        const total = Math.max(...same.map((x) => x.round));
        const { pos, third } = knockoutPos(f);
        const inRound = same.filter((x) => x.round === f.round && !knockoutPos(x).third).length;
        const base = roundLabel(total, f.round, third);
        return `${stage.name} - ${inRound > 1 && !third ? `${base} ${pos}` : base}`;
      }
      default:
        return `${stage.name} - round ${f.round}`;
    }
  }

  private placeholderLabel(ctx: FixtureContext, p: string | null): string | null {
    if (!p) return null;
    const r = RANK_RE.exec(p);
    if (r) return r[2] ? `${r[2]}${r[3]}` : `#${r[3]}`;
    const w = REF_RE.exec(p);
    if (w) {
      const src = ctx.fixtures.find((x) => x.id === w[2]);
      const name = src ? this.label(ctx, src) : 'a match';
      return `${w[1] === 'W' ? 'Winner' : 'Loser'} of ${name}`;
    }
    return p;
  }

  private side(
    ctx: FixtureContext,
    entryId: string | null,
    placeholder: string | null,
  ): FixtureSideDto {
    return {
      entryId,
      club: entryId ? (ctx.clubs.get(entryId) ?? null) : null,
      placeholder,
      placeholderLabel: entryId ? null : this.placeholderLabel(ctx, placeholder),
    };
  }

  toDto(ctx: FixtureContext, f: Fixture, revealSlots: boolean): FixtureDto {
    const stage = ctx.stages.get(f.stageId) as TournamentStage;
    const shootout = ctx.shootouts.get(f.id) ?? null;
    const show = revealSlots || f.scheduleVersion >= 1;
    const w = winnerOf(f, shootout ?? undefined);
    return {
      id: f.id,
      stageId: f.stageId,
      stageName: stage.name,
      stageKind: stage.kind,
      round: f.round,
      groupLabel: stage.kind === 'GROUP' ? f.groupLabel : null,
      label: this.label(ctx, f),
      home: this.side(ctx, f.homeEntryId, f.homePlaceholder),
      away: this.side(ctx, f.awayEntryId, f.awayPlaceholder),
      pitchId: show ? f.pitchId : null,
      startsAt: show ? (f.startsAt?.toISOString() ?? null) : null,
      endsAt: show ? (f.endsAt?.toISOString() ?? null) : null,
      scheduleVersion: f.scheduleVersion,
      status: f.status,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
      shootout,
      winnerEntryId: w?.winner ?? null,
    };
  }

  sort(list: Fixture[], ctx: FixtureContext): Fixture[] {
    return [...list].sort((a, b) => {
      const sa = ctx.stages.get(a.stageId)?.index ?? 0;
      const sb = ctx.stages.get(b.stageId)?.index ?? 0;
      return (
        sa - sb ||
        a.round - b.round ||
        knockoutPos(a).pos - knockoutPos(b).pos ||
        (a.groupLabel ?? '').localeCompare(b.groupLabel ?? '') ||
        a.id.localeCompare(b.id)
      );
    });
  }
}

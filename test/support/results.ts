import type { TestApp } from './app';
import { createUser, type TestUser } from './factories';
import { createGame } from './games';

export interface PlayedGame {
  gameId: string;
  org: TestUser;
  home: TestUser[];
  away: TestUser[];
  homeTeamId: string;
  awayTeamId: string;
}

/** A finished game with 2 confirmed players per team (teams assigned), ready for results. */
export async function finishedGame(
  t: TestApp,
  opts: { finish?: boolean; perTeam?: number } = {},
): Promise<PlayedGame> {
  const perTeam = opts.perTeam ?? 2;
  const org = await createUser(t);
  const g = await createGame(t, org);
  const players = await Promise.all(Array.from({ length: perTeam * 2 }, () => createUser(t)));
  for (const p of players) {
    await t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({}).expect(200);
  }
  const teams = await t.prisma.eventTeam.findMany({
    where: { eventId: g.id },
    orderBy: { index: 'asc' },
  });
  const [home, away] = [players.slice(0, perTeam), players.slice(perTeam)];
  await t.prisma.participation.updateMany({
    where: { eventId: g.id, userId: { in: home.map((p) => p.userId) } },
    data: { teamId: teams[0]?.id },
  });
  await t.prisma.participation.updateMany({
    where: { eventId: g.id, userId: { in: away.map((p) => p.userId) } },
    data: { teamId: teams[1]?.id },
  });
  await t.http().post(`/v1/games/${g.id}/start`).set(org.auth).expect(200);
  if (opts.finish !== false)
    await t.http().post(`/v1/games/${g.id}/finish`).set(org.auth).expect(200);
  return {
    gameId: g.id,
    org,
    home,
    away,
    homeTeamId: teams[0]?.id as string,
    awayTeamId: teams[1]?.id as string,
  };
}

/** Staff have no flag: platform RoleGrant rows only. */
export async function makeStaff(t: TestApp, permissions: string[]): Promise<TestUser> {
  const u = await createUser(t);
  await t.prisma.roleGrant.createMany({
    data: permissions.map((permission) => ({
      granteeId: u.userId,
      resourceType: 'PLATFORM' as const,
      resourceId: null,
      permission,
      grantedById: u.userId,
    })),
  });
  return u;
}

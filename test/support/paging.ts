import type { TestApp } from './app';

/**
 * The shared test database accumulates rows from earlier runs and other suites, so "my row is on page 1"
 * is not guaranteed. Follow keyset cursors until the predicate matches (or the list ends).
 */
export async function findInPages<T extends { id: string }>(
  t: TestApp,
  path: string,
  auth: Record<string, string>,
  predicate: (item: T) => boolean,
  maxPages = 200,
): Promise<T | undefined> {
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url: string = `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await t.http().get(url).set(auth).expect(200);
    const hit = (res.body.items as T[]).find(predicate);
    if (hit) return hit;
    cursor = res.body.nextCursor ?? null;
    if (!cursor) return undefined;
  }
  return undefined;
}

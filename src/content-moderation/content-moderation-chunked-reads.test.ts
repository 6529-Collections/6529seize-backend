import * as mysql from 'mysql';
import { DbQueryOptions } from '@/db-query.options';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { SqlExecutor } from '@/sql-executor';
import { ContentModerationDb } from './content-moderation.db';

type Params = Record<string, unknown>;

/** The API driver's named-parameter formatting (my-sql.helpers). */
function format(sql: string, params: Params): string {
  return sql.replace(/:(\w+)/g, (text, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return text;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((item) => mysql.escape(item)).join(', ')
      : mysql.escape(value);
  });
}

const uuid = (prefix: string, i: number) =>
  `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;

// A large batch, as for a full competition: 900 drops by 900 authors.
const drops = Array.from({ length: 900 }, (_, i) => ({
  id: uuid('dddddddd', i),
  author_id: uuid('aaaaaaaa', i)
}));
const viewer = 'viewer-profile';

interface Recorded {
  readonly sql: string;
  readonly params: Params;
  readonly options?: DbQueryOptions;
}

/** Answers each read from a small fixture, filtered by the chunk it gets. */
function repoRecording() {
  const statements: Recorded[] = [];
  let active = 0;
  let maxActive = 0;
  const has = (list: unknown, value: string) =>
    Array.isArray(list) && list.includes(value);
  const execute = jest.fn(
    async (sql: string, params: Params, options?: DbQueryOptions) => {
      statements.push({ sql: format(sql, params), params, options });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const ids = params.dropIds;
      if (/drop_states/.test(sql) && /left join/i.test(sql)) {
        return drops
          .filter((drop, i) => i % 50 === 1 && has(ids, drop.id))
          .map((drop) => ({ drop_id: drop.id, author_id: drop.author_id }));
      }
      if (/drop_states/.test(sql)) {
        return drops
          .filter((drop, i) => i % 50 === 0 && has(ids, drop.id))
          .map((drop) => ({ drop_id: drop.id, status: 'HIDDEN' }));
      }
      if (/profile_blocks/.test(sql) && 'authorIds' in params) {
        return drops
          .filter(
            (drop, i) => i % 70 === 0 && has(params.authorIds, drop.author_id)
          )
          .map((drop) => ({ blocked_profile_id: drop.author_id }));
      }
      if (/profile_blocks/.test(sql) && 'blockerIds' in params) {
        return drops
          .filter(
            (drop, i) =>
              i % 40 === 0 &&
              has(params.blockerIds, uuid('bbbbbbbb', i)) &&
              has(params.actorIds, drop.author_id)
          )
          .map((drop, i) => ({
            blocker_profile_id: uuid('bbbbbbbb', drops.indexOf(drop)),
            blocked_profile_id: drop.author_id,
            index: i
          }));
      }
      if (/hidden_drops/.test(sql)) {
        return drops
          .filter((drop, i) => i % 30 === 0 && has(ids, drop.id))
          .map((drop) => ({ drop_id: drop.id }));
      }
      if (/content_moderation_reports/.test(sql)) {
        // Two reports per reported drop, newest first.
        return drops
          .filter((drop, i) => i % 25 === 0 && has(ids, drop.id))
          .flatMap((drop) => [
            { drop_id: drop.id, status: 'OPEN', created_at: 2, id: 'r2' },
            { drop_id: drop.id, status: 'WITHDRAWN', created_at: 1, id: 'r1' }
          ]);
      }
      if (/competition_entries/.test(sql)) {
        return drops
          .filter((drop, i) => i % 140 === 0 && has(ids, drop.id))
          .map((drop) => ({ drop_id: drop.id }));
      }
      return [];
    }
  );
  const repo = new ContentModerationDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  return { repo, statements, maxActive: () => maxActive };
}

function expectAllUnderPinLimit(statements: Recorded[]) {
  for (const { sql } of statements) {
    expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(
      PROXY_PIN_STATEMENT_BYTES
    );
  }
}

describe('ContentModerationDb chunked IN-list reads', () => {
  it('builds presentations for a large drop batch from bounded statements', async () => {
    const { repo, statements } = repoRecording();
    const presentations = await repo.getPresentations(drops, viewer);

    expectAllUnderPinLimit(statements);
    expect(statements.length).toBeGreaterThan(4);
    expect(Object.keys(presentations)).toHaveLength(drops.length);
    drops.forEach((drop, i) => {
      const presentation = presentations[drop.id];
      expect(presentation.moderation.status).toBe(
        i % 50 === 0 ? 'HIDDEN' : 'VISIBLE'
      );
      expect(presentation.viewer.drop_hidden).toBe(i % 30 === 0);
      // The newest report wins even though reports were read in chunks.
      expect(presentation.viewer.report_status).toBe(
        i % 25 === 0 ? 'OPEN' : undefined
      );
      expect(presentation.viewer.author_blocked).toBe(
        i % 70 === 0 && i % 140 !== 0
      );
    });
  });

  it('reads chunks one at a time on a caller-owned connection', async () => {
    const { repo, statements, maxActive } = repoRecording();
    const connection = { connection: {} };
    await repo.getPresentations(drops.slice(0, 600), viewer, connection);
    expectAllUnderPinLimit(statements);
    for (const { options } of statements) {
      expect(options?.wrappedConnection).toBe(connection);
    }
    // getPresentations' four reads still overlap as before; each read's own
    // chunks never do.
    expect(maxActive()).toBeLessThanOrEqual(4);
  });

  it('filters unavailable notification drops across chunks', async () => {
    const { repo, statements } = repoRecording();
    const notifications = drops.map((drop) => ({
      identity_id: viewer,
      related_drop_id: drop.id,
      related_drop_2_id: null
    }));
    const visible =
      await repo.filterUnavailableDropNotificationRows(notifications);
    expectAllUnderPinLimit(statements);
    expect(statements.length).toBeGreaterThan(1);
    expect(visible).toHaveLength(drops.filter((_, i) => i % 50 !== 1).length);
  });

  it('finds blocked notification actors across chunks of both lists', async () => {
    const { repo, statements } = repoRecording();
    const notifications = drops.map((drop, i) => ({
      identity_id: uuid('bbbbbbbb', i),
      additional_identity_id: drop.author_id
    }));
    const visible = await repo.filterBlockedNotificationRows(notifications);
    expectAllUnderPinLimit(statements);
    expect(statements.length).toBeGreaterThan(1);
    expect(visible).toHaveLength(drops.filter((_, i) => i % 40 !== 0).length);
  });

  it('keeps a short side of the blocked-pair filter whole', async () => {
    const { repo, statements } = repoRecording();
    // One recipient's page: a single blocker and 900 actors.
    const notifications = drops.map((drop) => ({
      identity_id: uuid('bbbbbbbb', 0),
      additional_identity_id: drop.author_id
    }));
    const visible = await repo.filterBlockedNotificationRows(notifications);
    expectAllUnderPinLimit(statements);
    const pairReads = statements.filter(({ params }) => 'blockerIds' in params);
    // 900 actor ids (~36 KB) need 4 reads at the full budget; splitting the
    // budget in half for both lists would take 6.
    expect(pairReads).toHaveLength(4);
    for (const { params } of pairReads) {
      expect(params.blockerIds).toEqual([uuid('bbbbbbbb', 0)]);
    }
    expect(visible).toHaveLength(drops.length - 1);
  });

  it('reads viewer contexts for a large audience from bounded statements', async () => {
    const { repo, statements } = repoRecording();
    const viewerProfileIds = drops.map((_, i) => uuid('cccccccc', i));
    const contexts = await repo.getViewerContextsForDrop({
      dropId: drops[0].id,
      authorProfileId: drops[0].author_id,
      viewerProfileIds
    });
    expectAllUnderPinLimit(statements);
    expect(statements.length).toBeGreaterThan(2);
    expect(Object.keys(contexts)).toHaveLength(viewerProfileIds.length);
  });
});

import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  IdentityRatingsFeed,
  RATING_EVENTS_MAX_PENDING,
  RATING_EVENTS_UNSETTLED_WAIT_MS,
  ratingEventOf,
  RatingEventRow,
  RatingEventSource,
  SettledRatingEventRow
} from './identity-ratings-feed';

const BLOCK_TIME = 1_795_000_000_000;
const NOW = BLOCK_TIME + 60_000;

const row = (
  over: Partial<SettledRatingEventRow> = {}
): SettledRatingEventRow => ({
  id: 1,
  height: 120,
  block_time_ms: BLOCK_TIME,
  rater_principal: '0xrater',
  target_principal: '0xtarget',
  rater_profile_id: 'rater',
  target_profile_id: 'target',
  matter: 'REP',
  matter_category: 'Art',
  old_rating: 5,
  new_rating: 12,
  total_after: 40,
  origin: 'OPERATION',
  by_import: false,
  created_at: BLOCK_TIME + 1_000,
  ...over
});

/** The table as a list, in id order; the settle window is not modelled. */
class ListSource implements RatingEventSource {
  readonly calls: string[] = [];
  constructor(public rows: RatingEventRow[]) {}
  private sorted() {
    return [...this.rows].sort((a, b) => a.id - b.id);
  }
  async scanEnd(afterId: number, span: number) {
    this.calls.push(`scan ${afterId}`);
    const last = this.sorted()
      .filter((it) => it.id > afterId)
      .slice(0, span)
      .at(-1);
    return last ? { id: last.id, height: last.height } : null;
  }
  async readNotifying(afterId: number, upToId: number, limit: number) {
    return this.sorted()
      .filter(
        (it) =>
          it.id > afterId &&
          it.id <= upToId &&
          it.origin === 'OPERATION' &&
          !it.by_import
      )
      .slice(0, limit);
  }
  async readByIds(ids: readonly number[]) {
    return this.sorted().filter((it) => ids.includes(it.id));
  }
  async heightOf(id: number) {
    return this.rows.find((it) => it.id === id)?.height ?? null;
  }
}

describe('identity:ratings', () => {
  it('maps a REP row and a CIC row to rating events', () => {
    expect(ratingEventOf(row())).toEqual({
      height: 120,
      txIndex: 0,
      blockTimeMs: BLOCK_TIME,
      ref: '120:0xrater:0xtarget:REP:Art',
      origin: 'OPERATION',
      matter: 'REP',
      raterId: 'rater',
      targetId: 'target',
      category: 'Art',
      oldValue: 5,
      newValue: 12,
      totalAfter: 40
    });
    expect(ratingEventOf(row({ matter: 'CIC', matter_category: '' }))).toEqual(
      expect.objectContaining({
        ref: '120:0xrater:0xtarget:NIC:',
        matter: 'NIC',
        category: ''
      })
    );
  });

  it('names two categories changed at one height apart', () => {
    expect(ratingEventOf(row()).ref).not.toBe(
      ratingEventOf(row({ id: 2, matter_category: 'Music' })).ref
    );
  });

  it('reads in id order, skips rows that notify nobody, and resumes after the last row looked at', async () => {
    const source = new ListSource([
      row({ id: 1 }),
      // Written later at a lower height: still read.
      row({ id: 2, height: 119 }),
      row({ id: 3, origin: 'IMPORT' }),
      row({ id: 4, by_import: true }),
      row({ id: 5, origin: 'CAP_CUT' }),
      row({ id: 6, height: 121 })
    ]);
    const feed = new IdentityRatingsFeed(source);
    const first = await feed.read(null, 2);
    expect(first.events.map((event) => event.height)).toEqual([120, 119]);
    expect(first.next).toBe('119:2');
    const second = await feed.read(first.next, 2);
    expect(second.events.map((event) => event.height)).toEqual([121]);
    expect(second.next).toBe('121:6');
    expect(await feed.read(second.next, 2)).toEqual({
      events: [],
      next: null
    });
    expect(source.calls).toEqual(['scan 0', 'scan 2', 'scan 6']);
  });

  it("moves past an import's rows with no events", async () => {
    const source = new ListSource(
      [1, 2, 3, 4, 5].map((id) =>
        row({ id, origin: 'IMPORT', by_import: true })
      )
    );
    const feed = new IdentityRatingsFeed(source);
    expect(await feed.read(null, 2)).toEqual({ events: [], next: '120:5' });
  });

  it('keeps a change the mirror has not mapped to profiles waiting, and goes on past it', async () => {
    const unsettled: RatingEventRow = {
      ...row({ id: 2, height: 121, created_at: NOW - 1_000 }),
      target_profile_id: null
    };
    const source = new ListSource([row(), unsettled, row({ id: 3 })]);
    let now = NOW;
    const feed = new IdentityRatingsFeed(source, () => now);
    const first = await feed.read(null, 10);
    expect(first.events.map((event) => event.height)).toEqual([120, 120]);
    expect(first.next).toBe('120:3|2');
    // Still unmapped, nothing new: nothing to do.
    expect(await feed.read(first.next, 10)).toEqual({ events: [], next: null });
    // Mapped: it notifies now, and leaves the list.
    source.rows[1] = { ...unsettled, target_profile_id: 'target' };
    const mapped = await feed.read(first.next, 10);
    expect(mapped.events.map((event) => event.height)).toEqual([121]);
    expect(mapped.next).toBe('120:3');
  });

  it('drops a waiting change once its wait is up, notifying nobody', async () => {
    const unsettled: RatingEventRow = {
      ...row({ id: 2, created_at: NOW - 1_000 }),
      rater_profile_id: null
    };
    const source = new ListSource([row(), unsettled]);
    let now = NOW;
    const feed = new IdentityRatingsFeed(source, () => now);
    const first = await feed.read(null, 10);
    expect(first.next).toBe('120:2|2');
    now = unsettled.created_at + RATING_EVENTS_UNSETTLED_WAIT_MS + 1;
    expect(await feed.read(first.next, 10)).toEqual({
      events: [],
      next: '120:2'
    });
  });

  it(`keeps at most ${RATING_EVENTS_MAX_PENDING} changes waiting, the newest`, async () => {
    const rows = Array.from(
      { length: RATING_EVENTS_MAX_PENDING + 2 },
      (_, i) => ({
        ...row({ id: i + 1, created_at: NOW - 1_000 }),
        target_profile_id: null
      })
    );
    const feed = new IdentityRatingsFeed(new ListSource(rows), () => NOW);
    const { next } = await feed.read(null, 100);
    const waiting = next!.split('|')[1].split(',').map(Number);
    expect(waiting).toHaveLength(RATING_EVENTS_MAX_PENDING);
    expect(waiting[0]).toBe(3);
    expect(next!.length).toBeLessThanOrEqual(512);
  });

  it("reads again from the start when the mirror's ids were renumbered", async () => {
    const source = new ListSource([
      row({ id: 1 }),
      row({ id: 2, height: 121 })
    ]);
    const feed = new IdentityRatingsFeed(source);
    const first = await feed.read(null, 1);
    expect(first.next).toBe('120:1');
    // The mirror's table is rebuilt: the same changes, new ids.
    source.rows = [
      row({ id: 50 }),
      row({ id: 51, height: 121 }),
      row({ id: 52, height: 122 })
    ];
    const again = await feed.read(first.next, 10);
    expect(again.events.map((event) => event.height)).toEqual([120, 121, 122]);
    expect(source.calls.at(-1)).toBe('scan 0');
    // The row read twice is the same change, by its name.
    expect(again.events[0].ref).toBe(first.events[0].ref);
  });

  it("notifies the target of a rater's change only", async () => {
    const feed = new IdentityRatingsFeed(new ListSource([]));
    const group = await feed.derive(ratingEventOf(row()));
    expect(group.rows).toEqual([
      expect.objectContaining({
        identity_id: 'target',
        cause: IdentityNotificationCause.IDENTITY_REP,
        additional_identity_id: 'rater',
        created_at: BLOCK_TIME,
        additional_data: {
          amount: 7,
          rater_rating: 12,
          total: 40,
          category: 'Art'
        }
      })
    ]);
    for (const over of [
      { origin: 'CAP_CUT' as const },
      { origin: 'IMPORT' as const },
      { by_import: true },
      { origin: 'UNKNOWN' as const },
      { origin: 'SOMETHING_NEW' as RatingEventRow['origin'] }
    ]) {
      expect((await feed.derive(ratingEventOf(row(over)))).rows).toEqual([]);
    }
  });
});

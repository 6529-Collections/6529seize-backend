import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  IdentityRatingsFeed,
  RatingCursor,
  ratingEventOf,
  RatingEventRow,
  RatingEventSource
} from './identity-ratings-feed';

const BLOCK_TIME = 1_795_000_000_000;

const row = (over: Partial<RatingEventRow> = {}): RatingEventRow => ({
  id: 1,
  height: 120,
  block_time_ms: BLOCK_TIME,
  rater_profile_id: 'rater',
  target_profile_id: 'target',
  matter: 'REP',
  matter_category: 'Art',
  old_rating: 5,
  new_rating: 12,
  total_after: 40,
  origin: 'OPERATION',
  by_import: false,
  ...over
});

/** The table as a list, in (height, id) order. */
class ListSource implements RatingEventSource {
  readonly calls: string[] = [];
  constructor(public rows: RatingEventRow[]) {}
  private sorted() {
    return [...this.rows].sort((a, b) => a.height - b.height || a.id - b.id);
  }
  async readAfter(after: RatingCursor, limit: number) {
    this.calls.push(`after ${after.height}:${after.id}`);
    return this.sorted()
      .filter(
        (it) =>
          it.height > after.height ||
          (it.height === after.height && it.id > after.id)
      )
      .slice(0, limit);
  }
  async readFromHeight(height: number, limit: number) {
    this.calls.push(`from ${height}`);
    return this.sorted()
      .filter((it) => it.height >= height)
      .slice(0, limit);
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
      ref: '120:rater:target:REP:Art',
      origin: 'OPERATION',
      matter: 'REP',
      raterId: 'rater',
      targetId: 'target',
      category: 'Art',
      oldValue: 5,
      newValue: 12,
      totalAfter: 40
    });
    expect(
      ratingEventOf(row({ matter: 'CIC', matter_category: 'CIC' }))
    ).toEqual(
      expect.objectContaining({
        ref: '120:rater:target:NIC:',
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

  it('reads in (height, id) order and resumes after the last row', async () => {
    const source = new ListSource([
      row(),
      row({ id: 2 }),
      row({ id: 7, height: 121 })
    ]);
    const feed = new IdentityRatingsFeed(source);
    const first = await feed.read(null, 2);
    expect(first.events).toHaveLength(2);
    expect(first.next).toBe('120:2');
    const second = await feed.read(first.next, 2);
    expect(second.events.map((event) => event.height)).toEqual([121]);
    expect(second.next).toBe('121:7');
    expect(await feed.read(second.next, 2)).toEqual({
      events: [],
      next: null
    });
    expect(source.calls).toEqual(['from 0', 'after 120:2', 'after 121:7']);
  });

  it("reads again from the cursor's height when the mirror's ids were renumbered", async () => {
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
    expect(source.calls.at(-1)).toBe('from 120');
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
      { origin: 'UNKNOWN' as const },
      { by_import: true },
      { origin: 'SOMETHING_NEW' as RatingEventRow['origin'] }
    ]) {
      expect((await feed.derive(ratingEventOf(row(over)))).rows).toEqual([]);
    }
  });
});

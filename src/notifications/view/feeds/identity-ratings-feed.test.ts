import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  IdentityRatingsFeed,
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
  ...over
});

/** The table as a list: rows after an id, in id order. */
class ListSource implements RatingEventSource {
  readonly calls: number[] = [];
  constructor(private readonly rows: RatingEventRow[]) {}
  async readAfter(afterId: number, limit: number) {
    this.calls.push(afterId);
    return this.rows.filter((it) => it.id > afterId).slice(0, limit);
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

  it('reads after its cursor and resumes from the last id', async () => {
    const source = new ListSource([row(), row({ id: 2 }), row({ id: 7 })]);
    const feed = new IdentityRatingsFeed(source);
    const first = await feed.read(null, 2);
    expect(first.events).toHaveLength(2);
    expect(first.next).toBe('2');
    const second = await feed.read(first.next, 2);
    expect(second.events).toHaveLength(1);
    expect(second.next).toBe('7');
    expect(await feed.read(second.next, 2)).toEqual({ events: [], next: null });
    expect(source.calls).toEqual([0, 2, 7]);
  });

  it("notifies the target of a rater's change, and nobody of a cap cut or the import", async () => {
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
    for (const origin of ['CAP_CUT', 'IMPORT', 'SOMETHING_NEW']) {
      expect(
        (
          await feed.derive(
            ratingEventOf(row({ origin: origin as RatingEventRow['origin'] }))
          )
        ).rows
      ).toEqual([]);
    }
  });
});

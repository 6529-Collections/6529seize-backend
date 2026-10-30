import { ArtistArtworkAlertsDb } from './artist-artwork-alerts.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

describeWithSeed('Independent artist artwork preferences', [], () => {
  const db = new ArtistArtworkAlertsDb(() => sqlExecutor);
  const pair = { subscriberId: 'viewer', artistId: 'artist' };
  afterEach(() => jest.restoreAllMocks());

  it('defaults off and persists an explicit opt-in without following', async () => {
    expect(await db.isEnabled(pair)).toBe(false);
    jest.spyOn(Date, 'now').mockReturnValue(100);
    await db.setEnabled(pair, true);
    expect(await db.isEnabled(pair)).toBe(true);
    expect(await db.listRecipients('artist', 101, '', {})).toEqual(['viewer']);
    expect(await db.isEnabled({ ...pair, subscriberId: 'other' })).toBe(false);
    await db.setEnabled(pair, false);
    await db.setEnabled(pair, false);
    expect(await db.isEnabled(pair)).toBe(false);
  });

  it('never backfills old work and preserves the cutoff when enable is retried', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100);
    await db.setEnabled(pair, true);
    now.mockReturnValue(200);
    await db.setEnabled(pair, true);
    expect(await db.isEnabled(pair, {}, 100)).toBe(false);
    expect(await db.listRecipients('artist', 100, '', {})).toEqual([]);
    expect(await db.isEnabled(pair, {}, 150)).toBe(true);
    await db.setEnabled(pair, false);
    await db.setEnabled(pair, true);
    expect(await db.isEnabled(pair, {}, 150)).toBe(false);
    expect(await db.listRecipients('artist', 201, '', {})).toEqual(['viewer']);
  });

  it('paginates all recipients exactly once and excludes self notifications', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1);
    for (let index = 0; index < 253; index++) {
      await db.setEnabled(
        {
          artistId: 'artist',
          subscriberId: `viewer-${String(index).padStart(3, '0')}`
        },
        true
      );
    }
    await db.setEnabled({ subscriberId: 'artist', artistId: 'artist' }, true);
    const first = await db.listRecipients('artist', 2, '', {});
    const second = await db.listRecipients(
      'artist',
      2,
      first[first.length - 1],
      {}
    );
    expect(first).toHaveLength(250);
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second]).size).toBe(253);
    expect(
      await db.listRecipients('artist', 2, second[second.length - 1], {})
    ).toEqual([]);
  });
});

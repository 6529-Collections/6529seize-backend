import 'reflect-metadata';
import { saveDistributionPhotos } from '@/api/distribution-photos/api.distribution_photos.db';
import {
  DISTRIBUTION_PHOTO_TABLE,
  MEMES_CONTRACT,
  MINT_LOG_HEAD_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { mintCard } from './mint-log-parts';
import type { MintRecordLogEntry, MintRecordLogPort } from './mint-log-ports';
import { entrySha256, MintLogRecorder } from './mint-log-recorder';
import type { MintLogEntryBody } from './mint-log.types';

const CONTRACT = MEMES_CONTRACT.toLowerCase();

describeWithSeed('mint log under concurrent writes on MySQL', [], () => {
  const entries: MintLogEntryBody[] = [];
  const log: MintRecordLogPort = {
    append: async (queued: readonly MintRecordLogEntry[]) => {
      for (const entry of queued) {
        if (entry.t === 'entry') {
          entries.push(entry.body as unknown as MintLogEntryBody);
        }
      }
    }
  };
  const recorder = new MintLogRecorder(
    {
      isMintLogShadowEnabled: () => true,
      isMintLogPrimaryEnabled: () => false,
      isMintLogReplayCheckEnabled: () => true
    },
    () => ({ records: null, log })
  );
  const photo = (cardId: number) =>
    recorder.write(
      {
        kind: 'dist.photos',
        card: mintCard(CONTRACT, cardId),
        actor: { type: 'service', wallet: null, authority: null },
        intent: { route: 'test', params: {}, body: null }
      },
      () =>
        saveDistributionPhotos(CONTRACT, cardId, [
          `https://example.com/${cardId}.jpg`
        ])
    );

  beforeEach(() => {
    entries.length = 0;
  });

  it('runs every write and logs them in one gap-free order when they race for the head', async () => {
    // Four at a time, as the test pool has five connections and each logged
    // write holds one while its writer uses another.
    const cards = Array.from({ length: 20 }, (_, index) => 100 + index);
    for (let start = 0; start < cards.length; start += 4) {
      const results = await Promise.allSettled(
        cards.slice(start, start + 4).map(photo)
      );
      expect(results.filter((it) => it.status === 'rejected')).toEqual([]);
    }
    const [{ n }] = await sqlExecutor.execute<{ n: number }>(
      `select count(*) as n from ${DISTRIBUTION_PHOTO_TABLE}`
    );
    expect(Number(n)).toBe(20);
    expect(entries.map((entry) => entry.seq)).toEqual(
      cards.map((_, index) => index)
    );
    entries.slice(1).forEach((entry, index) => {
      expect(entry.prev).toBe(entrySha256(entries[index]));
    });
    expect(
      entries.map((entry) => entry.card?.card_id).sort((a, b) => a! - b!)
    ).toEqual(cards);
    expect(entries.every((entry) => entry.checks.replay === 'match')).toBe(
      true
    );
  });

  it('runs a shadow write unlogged when the log table is not there yet', async () => {
    await sqlExecutor.execute(
      `rename table ${MINT_LOG_HEAD_TABLE} to ${MINT_LOG_HEAD_TABLE}_away`
    );
    try {
      await photo(7);
    } finally {
      await sqlExecutor.execute(
        `rename table ${MINT_LOG_HEAD_TABLE}_away to ${MINT_LOG_HEAD_TABLE}`
      );
    }
    expect(entries).toEqual([]);
    const [{ n }] = await sqlExecutor.execute<{ n: number }>(
      `select count(*) as n from ${DISTRIBUTION_PHOTO_TABLE} where card_id = 7`
    );
    expect(Number(n)).toBe(1);
  });
});

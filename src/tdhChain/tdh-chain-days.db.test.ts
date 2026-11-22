import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { TdhChainDaysDb } from './tdh-chain-days.db';

describeWithSeed('TdhChainDaysDb', [], () => {
  const db = new TdhChainDaysDb(() => sqlExecutor);
  const day = chainDayFixture();

  it('has no day before the first ingest', async () => {
    expect(await db.latest()).toBeNull();
  });

  it('saves a day, overwrites it, and returns the newest', async () => {
    await db.save({
      day,
      mode: 'SHADOW',
      status: 'INGESTED',
      verdict: 'MATCH',
      summary: { cache: { verdict: 'MATCH' } },
      deferredKeys: [],
      now: 1
    });
    await db.save({
      day,
      mode: 'CHAIN',
      status: 'KEYS_DEFERRED',
      verdict: 'MATCH',
      summary: {},
      deferredKeys: ['k1'],
      now: 2
    });
    const next = {
      ...day,
      header: { ...day.header, cycleDay: day.header.cycleDay - 1 }
    };
    await db.save({
      day: next,
      mode: 'SHADOW',
      status: 'FAILED',
      verdict: null,
      summary: {},
      deferredKeys: [],
      now: 3
    });
    expect(await db.latest()).toEqual({
      cycleDay: day.header.cycleDay,
      mode: 'CHAIN',
      status: 'KEYS_DEFERRED',
      deferredKeys: ['k1']
    });
  });

  it('reads the narrowest consolidation key column the TDH writes use', async () => {
    expect(await db.consolidationKeyWidth()).toBe(200);
  });
});

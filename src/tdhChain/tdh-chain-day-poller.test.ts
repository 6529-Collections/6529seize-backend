import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { ChainTdhIngestResult } from './chain-tdh-ingest';
import { splitByKeyWidth, TdhChainDayRow } from './tdh-chain-days.db';
import {
  MAX_DAYS_PER_RUN,
  planDays,
  pollChainDays,
  PollerDeps
} from './tdh-chain-day-poller';
import { TdhChainSource } from './tdh-chain-source';
import { TdhChainDay } from './tdh-chain.types';

const row = (
  cycleDay: number,
  extra: Partial<TdhChainDayRow> = {}
): TdhChainDayRow => ({
  cycleDay,
  mode: 'SHADOW',
  status: 'INGESTED',
  deferredKeys: [],
  ...extra
});

describe('planDays', () => {
  it('starts at the newest day without backfilling', () => {
    expect(planDays(null, 20781, 'SHADOW', 0)).toEqual([20781]);
  });

  it('takes the days after the last one, oldest first, a few per run', () => {
    expect(planDays(row(20780), 20781, 'SHADOW', 0)).toEqual([20781]);
    expect(planDays(row(20781), 20781, 'SHADOW', 0)).toEqual([]);
    expect(planDays(row(20770), 20781, 'SHADOW', 0)).toHaveLength(
      MAX_DAYS_PER_RUN
    );
    expect(planDays(row(20770), 20781, 'SHADOW', 0)[0]).toBe(20771);
  });

  it('tries a failed day again', () => {
    expect(
      planDays(row(20781, { status: 'FAILED' }), 20781, 'SHADOW', 0)
    ).toEqual([20781]);
  });

  it('writes a shadowed day again once the site reads the chain', () => {
    expect(planDays(row(20781), 20781, 'CHAIN', 0)).toEqual([20781]);
    expect(planDays(row(20781, { mode: 'CHAIN' }), 20781, 'CHAIN', 0)).toEqual(
      []
    );
  });

  it('writes a day with deferred keys again once the columns are wide enough', () => {
    const deferred = row(20783, {
      mode: 'CHAIN',
      status: 'KEYS_DEFERRED',
      deferredKeys: ['k'.repeat(214)]
    });
    expect(planDays(deferred, 20783, 'CHAIN', 200)).toEqual([]);
    expect(planDays(deferred, 20783, 'CHAIN', 700)).toEqual([20783]);
    expect(planDays(deferred, 20784, 'CHAIN', 200)).toEqual([20784]);
  });
});

describe('splitByKeyWidth', () => {
  it('keeps the keys that fit and lists the others once', () => {
    const rows = [
      { consolidation_key: 'a' },
      { consolidation_key: 'b'.repeat(5) },
      { consolidation_key: 'b'.repeat(5) }
    ];
    expect(splitByKeyWidth(rows, 4)).toEqual({
      fit: [rows[0]],
      deferred: ['bbbbb']
    });
  });
});

function source(days: TdhChainDay[]): TdhChainSource {
  const byDay = new Map(days.map((d) => [d.header.cycleDay, d]));
  return {
    latestDay: async () => {
      const newest = days[days.length - 1];
      return newest ? { header: newest.header, apply: newest.apply } : null;
    },
    day: async (n) => {
      const d = byDay.get(n);
      return d ? { header: d.header, apply: d.apply } : null;
    },
    walletLeaves: async (n) => byDay.get(n)!.walletLeaves.slice(),
    tokenLeaves: async (n) => byDay.get(n)!.tokenLeaves?.slice() ?? null
  };
}

function result(
  status: ChainTdhIngestResult['status'],
  verdict: ChainTdhIngestResult['verdict']
): ChainTdhIngestResult {
  return {
    status,
    verdict,
    deferredKeys: [],
    summary: { mode: 'SHADOW', cycleDay: 0, failures: [] }
  };
}

describe('pollChainDays', () => {
  const day = chainDayFixture();

  function poller(
    over: Partial<PollerDeps>,
    alerts: string[],
    ingested: number[]
  ): PollerDeps {
    return {
      mode: 'SHADOW',
      source: source([day]),
      latestRow: async () => null,
      keyWidth: async () => 200,
      ingest: async (d) => {
        ingested.push(d.header.cycleDay);
        return result('INGESTED', 'MATCH');
      },
      alert: async (title) => {
        alerts.push(title);
      },
      ...over
    };
  }

  it('does nothing while both flags are off', async () => {
    const alerts: string[] = [];
    const ingested: number[] = [];
    const out = await pollChainDays(poller({ mode: null }, alerts, ingested));
    expect(out.ingested).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it('ingests the newest day and raises no alert on a match', async () => {
    const alerts: string[] = [];
    const ingested: number[] = [];
    await pollChainDays(poller({}, alerts, ingested));
    expect(ingested).toEqual([20737]);
    expect(alerts).toEqual([]);
  });

  it('alerts on a mismatch and on a newly failed day, but not again for the same failure', async () => {
    const alerts: string[] = [];
    const ingested: number[] = [];
    await pollChainDays(
      poller(
        { ingest: async () => result('INGESTED', 'MISMATCH') },
        alerts,
        ingested
      )
    );
    expect(alerts).toEqual([
      'TDH day 20737: the site and the 6529 chain differ (SHADOW)'
    ]);
    alerts.length = 0;
    await pollChainDays(
      poller({ ingest: async () => result('FAILED', null) }, alerts, ingested)
    );
    expect(alerts).toEqual([
      'TDH day 20737 from the 6529 chain failed its checks'
    ]);
    alerts.length = 0;
    await pollChainDays(
      poller(
        {
          latestRow: async () => row(20737, { status: 'FAILED' }),
          ingest: async () => result('FAILED', null)
        },
        alerts,
        ingested
      )
    );
    expect(alerts).toEqual([]);
  });

  it('waits quietly when the gateway is unreachable', async () => {
    const alerts: string[] = [];
    const ingested: number[] = [];
    const broken = {
      ...source([day]),
      latestDay: async () => {
        throw new Error('reset');
      }
    };
    const out = await pollChainDays(
      poller({ source: broken }, alerts, ingested)
    );
    expect(out.ingested).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('stops when the gateway serves no day', async () => {
    const alerts: string[] = [];
    const ingested: number[] = [];
    await pollChainDays(poller({ source: source([]) }, alerts, ingested));
    expect(ingested).toEqual([]);
  });
});

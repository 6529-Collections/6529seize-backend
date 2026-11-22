import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { ChainTdhIngestResult } from './chain-tdh-ingest';
import { splitByKeyWidth, TdhChainDayRow } from './tdh-chain-days.db';
import {
  isFinal,
  planDay,
  pollChainDays,
  PollerDeps,
  STALE_AFTER_MS
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
  verdict: 'MATCH',
  deferredKeys: [],
  stepsDone: [],
  boundary: cycleDay * 86400,
  block: 1,
  ...extra
});

describe('planDay', () => {
  it('starts at the newest day without backfilling', () => {
    expect(planDay(null, 20781, 'SHADOW', 0)).toBe(20781);
  });

  it('takes the next day, or jumps to the newest across a gap', () => {
    expect(planDay(row(20780), 20781, 'SHADOW', 0)).toBe(20781);
    expect(planDay(row(20781), 20781, 'SHADOW', 0)).toBeNull();
    expect(planDay(row(20770), 20781, 'CHAIN', 0)).toBe(20781);
    expect(planDay(row(20782), 20781, 'CHAIN', 0)).toBeNull();
  });

  it('tries a failed day again only while nothing newer exists', () => {
    expect(planDay(row(20781, { status: 'FAILED' }), 20781, 'SHADOW', 0)).toBe(
      20781
    );
    expect(planDay(row(20781, { status: 'FAILED' }), 20782, 'SHADOW', 0)).toBe(
      20782
    );
  });

  it('never writes a shadowed day again when chain mode starts', () => {
    expect(planDay(row(20781), 20781, 'CHAIN', 0)).toBeNull();
  });

  it('writes a day with deferred keys again once the columns are wide enough', () => {
    const deferred = row(20783, {
      mode: 'CHAIN',
      deferredKeys: ['k'.repeat(214)]
    });
    expect(planDay(deferred, 20783, 'CHAIN', 200)).toBeNull();
    expect(planDay(deferred, 20783, 'CHAIN', 700)).toBe(20783);
    expect(planDay(deferred, 20784, 'CHAIN', 200)).toBe(20784);
  });
});

describe('isFinal', () => {
  it('takes a day whose apply block is at or below the finalized height', () => {
    const d = chainDayFixture();
    expect(isFinal(d)).toBe(true);
    expect(
      isFinal({ ...d, apply: { ...d.apply, finalizedHeight: 1100 } })
    ).toBe(false);
    expect(isFinal({ ...d, apply: { ...d.apply, applyHeight: null } })).toBe(
      true
    );
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
  const noon = (cycleDay: number, minute = 30) =>
    cycleDay * 86_400_000 + 12 * 3_600_000 + minute * 60_000;

  function poller(
    over: Partial<PollerDeps>,
    log: { alerts: string[]; ingested: number[]; resumed: string[] }
  ): PollerDeps {
    return {
      mode: 'SHADOW',
      source: source([day]),
      latestRow: async () => null,
      latestWritten: async () => null,
      keyWidth: async () => 200,
      ingest: async (d) => {
        log.ingested.push(d.header.cycleDay);
        return result('INGESTED', 'MATCH');
      },
      steps: {
        run: async (step) => {
          log.resumed.push(step);
        },
        markDone: async () => []
      },
      alert: async (title) => {
        log.alerts.push(title);
      },
      now: () => noon(day.header.cycleDay),
      ...over
    };
  }
  const fresh = () => ({
    alerts: [] as string[],
    ingested: [] as number[],
    resumed: [] as string[]
  });

  it('does nothing while both flags are off', async () => {
    const log = fresh();
    expect(await pollChainDays(poller({ mode: null }, log))).toEqual({});
    expect(log.ingested).toEqual([]);
  });

  it('ingests the newest day and raises no alert on a match', async () => {
    const log = fresh();
    await pollChainDays(poller({}, log));
    expect(log.ingested).toEqual([20737]);
    expect(log.alerts).toEqual([]);
  });

  it('resumes the follow-up steps of a WRITTEN day before anything else', async () => {
    const log = fresh();
    const out = await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          latestRow: async () =>
            row(20737, {
              mode: 'CHAIN',
              status: 'WRITTEN',
              stepsDone: ['nfts', 'history']
            }),
          latestWritten: async () =>
            row(20737, { mode: 'CHAIN', status: 'WRITTEN' })
        },
        log
      )
    );
    expect(out).toEqual({ resumed: 20737 });
    expect(log.resumed).toEqual(['metrics', 'uploads', 'dayFiles']);
    expect(log.ingested).toEqual([]);
  });

  it('waits for a day that is not final yet', async () => {
    const log = fresh();
    const notFinal = { ...day, apply: { ...day.apply, finalizedHeight: 1 } };
    await pollChainDays(poller({ source: source([notFinal]) }, log));
    expect(log.ingested).toEqual([]);
  });

  it('alerts on a mismatch and on a newly failed day, but not again for the same failure', async () => {
    let log = fresh();
    await pollChainDays(
      poller({ ingest: async () => result('INGESTED', 'MISMATCH') }, log)
    );
    expect(log.alerts).toEqual([
      'TDH day 20737: the site and the 6529 chain differ (SHADOW)'
    ]);
    log = fresh();
    await pollChainDays(
      poller({ ingest: async () => result('FAILED', null) }, log)
    );
    expect(log.alerts).toEqual([
      'TDH day 20737 from the 6529 chain failed its checks'
    ]);
    log = fresh();
    await pollChainDays(
      poller(
        {
          latestRow: async () => row(20737, { status: 'FAILED' }),
          ingest: async () => result('FAILED', null)
        },
        log
      )
    );
    expect(log.alerts).toEqual([]);
  });

  it('in CHAIN alerts once an hour while the newest day written is late, the gateway down included', async () => {
    const broken = {
      ...source([day]),
      latestDay: async () => {
        throw new Error('reset');
      }
    };
    const lateNow = day.header.boundary * 1000 + STALE_AFTER_MS + 3_600_000;
    const at = (minute: number) => {
      const d = new Date(lateNow);
      d.setUTCMinutes(minute);
      return d.getTime();
    };
    const written = async () =>
      row(20737, { mode: 'CHAIN', boundary: day.header.boundary });
    let log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          source: broken,
          latestWritten: written,
          now: () => at(15)
        },
        log
      )
    );
    expect(log.alerts).toEqual(['TDH from the 6529 chain is late']);
    log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          source: broken,
          latestWritten: written,
          now: () => at(35)
        },
        log
      )
    );
    expect(log.alerts).toEqual([]);
    log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'SHADOW',
          source: broken,
          latestWritten: written,
          now: () => at(15)
        },
        log
      )
    );
    expect(log.alerts).toEqual([]);
  });

  it('stops when the gateway serves no day', async () => {
    const log = fresh();
    await pollChainDays(poller({ source: source([]) }, log));
    expect(log.ingested).toEqual([]);
  });
});

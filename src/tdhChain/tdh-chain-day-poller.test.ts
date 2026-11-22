import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { ChainDayStepRunner, ChainTdhIngestResult } from './chain-tdh-ingest';
import {
  CHAIN_DAY_STEPS,
  ChainDayStep,
  splitByKeyWidth,
  TdhChainDayRow
} from './tdh-chain-days.db';
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
  stepsGivenUp: [],
  boundary: cycleDay * 86400,
  block: 1,
  superseded: false,
  redoFailed: false,
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

  it('never writes a day the old path wrote over, even with deferred keys that now fit', () => {
    const superseded = row(20783, {
      mode: 'CHAIN',
      deferredKeys: ['k'.repeat(214)],
      superseded: true
    });
    expect(planDay(superseded, 20783, 'CHAIN', 700)).toBeNull();
    expect(planDay(superseded, 20784, 'CHAIN', 700)).toBe(20784);
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
  const next = {
    ...day,
    header: { ...day.header, cycleDay: day.header.cycleDay + 1 }
  };
  const noon = (cycleDay: number, minute = 30) =>
    cycleDay * 86_400_000 + 12 * 3_600_000 + minute * 60_000;

  type Log = {
    events: string[];
    alerts: string[];
  };

  function steps(log: Log, failing: ChainDayStep[] = []): ChainDayStepRunner {
    return {
      run: async (step, d) => {
        log.events.push(`step ${d.cycleDay} ${step}`);
        if (failing.includes(step)) throw new Error(`${step} failed`);
      },
      markDone: async () => ({ done: [], givenUp: [] }),
      recordFailure: async () => 1,
      giveUp: async (cycleDay, s) => {
        log.events.push(`give up ${cycleDay} ${s.join(',')}`);
        return { done: [], givenUp: [...s] };
      }
    };
  }

  function poller(over: Partial<PollerDeps>, log: Log): PollerDeps {
    return {
      mode: 'SHADOW',
      source: source([day]),
      latestRow: async () => null,
      pendingDays: async () => [],
      latestTdhBlockTime: async () => null,
      keyWidth: async () => 200,
      ingest: async (d) => {
        log.events.push(`ingest ${d.header.cycleDay}`);
        return result('INGESTED', 'MATCH');
      },
      steps: steps(log),
      alert: async (title) => {
        log.events.push(`alert ${title}`);
        log.alerts.push(title);
      },
      now: () => noon(day.header.cycleDay),
      ...over
    };
  }
  const fresh = (): Log => ({ events: [], alerts: [] });

  it('does nothing while both flags are off', async () => {
    const log = fresh();
    expect(await pollChainDays(poller({ mode: null }, log))).toEqual({});
    expect(log.events).toEqual([]);
  });

  it('ingests the newest day and raises no alert on a match', async () => {
    const log = fresh();
    await pollChainDays(poller({}, log));
    expect(log.events).toEqual(['ingest 20737']);
  });

  it("in CHAIN sends the day's alerts as soon as it is written, then runs its steps", async () => {
    const log = fresh();
    const out = await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          ingest: async (d) => {
            log.events.push(`ingest ${d.header.cycleDay}`);
            return {
              ...result('WRITTEN', 'MISMATCH'),
              deferredKeys: ['k'.repeat(300)]
            };
          },
          steps: steps(log, ['nfts'])
        },
        log
      )
    );
    expect(log.events).toEqual([
      'ingest 20737',
      'alert TDH day 20737: the site and the 6529 chain differ (CHAIN)',
      'alert TDH day 20737: 1 consolidations wait for wider key columns',
      ...CHAIN_DAY_STEPS.map((s) => `step 20737 ${s}`)
    ]);
    expect(out.stepsRun).toEqual([20737]);
  });

  it("ingests a newer day while an older day's steps are due, and gives up the older day's table steps", async () => {
    const log = fresh();
    const older = row(20737, {
      mode: 'CHAIN',
      status: 'WRITTEN',
      stepsDone: ['nfts']
    });
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          source: source([day, next]),
          latestRow: async () => older,
          pendingDays: async () => [older],
          ingest: async (d) => {
            log.events.push(`ingest ${d.header.cycleDay}`);
            return result('WRITTEN', 'MATCH');
          }
        },
        log
      )
    );
    expect(log.events).toEqual([
      'ingest 20738',
      'give up 20737 history,metrics,uploads',
      'alert TDH day 20737: history, metrics, uploads left undone',
      ...CHAIN_DAY_STEPS.map((s) => `step 20738 ${s}`)
    ]);
  });

  it('with nothing new, runs the steps still due, oldest day first, past a failing step', async () => {
    const log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          latestRow: async () =>
            row(20738, { mode: 'CHAIN', status: 'WRITTEN' }),
          source: source([day, next]),
          pendingDays: async () => [
            row(20737, {
              mode: 'CHAIN',
              status: 'WRITTEN',
              stepsDone: ['nfts', 'history', 'metrics', 'uploads']
            }),
            row(20738, {
              mode: 'CHAIN',
              status: 'WRITTEN',
              stepsDone: ['nfts', 'history', 'metrics']
            })
          ],
          steps: steps(log, ['uploads'])
        },
        log
      )
    );
    expect(log.events).toEqual([
      'step 20737 dayFiles',
      'step 20738 uploads',
      'step 20738 dayFiles'
    ]);
  });

  it('runs the steps still due when the newer day can not be taken in, then reports the error', async () => {
    const log = fresh();
    await expect(
      pollChainDays(
        poller(
          {
            mode: 'CHAIN',
            source: source([day, next]),
            latestRow: async () =>
              row(20737, { mode: 'CHAIN', status: 'WRITTEN' }),
            pendingDays: async () => [
              row(20737, {
                mode: 'CHAIN',
                status: 'WRITTEN',
                stepsDone: ['nfts', 'history', 'metrics', 'uploads']
              })
            ],
            ingest: async () => {
              throw new Error('database gone');
            }
          },
          log
        )
      )
    ).rejects.toThrow('database gone');
    expect(log.events).toEqual(['step 20737 dayFiles']);
  });

  it('runs the steps still due while the gateway is down', async () => {
    const log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          source: {
            ...source([day]),
            latestDay: async () => {
              throw new Error('reset');
            }
          },
          pendingDays: async () => [
            row(20737, {
              mode: 'CHAIN',
              status: 'WRITTEN',
              stepsDone: ['nfts', 'history', 'metrics', 'uploads']
            })
          ]
        },
        log
      )
    );
    expect(log.events).toEqual(['step 20737 dayFiles']);
  });

  it('waits for a day that is not final yet', async () => {
    const log = fresh();
    const notFinal = { ...day, apply: { ...day.apply, finalizedHeight: 1 } };
    await pollChainDays(poller({ source: source([notFinal]) }, log));
    expect(log.events).toEqual([]);
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
    // A written day tried again (its deferred keys now fit) that fails
    // keeps its record; the failure is not announced twice either.
    log = fresh();
    await pollChainDays(
      poller(
        {
          mode: 'CHAIN',
          latestRow: async () =>
            row(20737, {
              mode: 'CHAIN',
              deferredKeys: ['k'],
              redoFailed: true
            }),
          ingest: async () => result('FAILED', null)
        },
        log
      )
    );
    expect(log.alerts).toEqual([]);
  });

  it('in CHAIN alerts once an hour while the newest TDH day in the tables is late, and not before there is one', async () => {
    const broken = {
      ...source([day]),
      latestDay: async () => {
        throw new Error('reset');
      }
    };
    const taken = day.header.cutoffTimestamp * 1000;
    const lateNow = taken + STALE_AFTER_MS + 3_600_000;
    const at = (minute: number) => {
      const d = new Date(lateNow);
      d.setUTCMinutes(minute);
      return d.getTime();
    };
    const run = async (over: Partial<PollerDeps>) => {
      const log = fresh();
      await pollChainDays(
        poller(
          {
            mode: 'CHAIN',
            source: broken,
            latestTdhBlockTime: async () => taken,
            now: () => at(15),
            ...over
          },
          log
        )
      );
      return log.alerts;
    };
    expect(await run({})).toEqual(['TDH from the 6529 chain is late']);
    expect(await run({ now: () => at(35) })).toEqual([]);
    expect(await run({ mode: 'SHADOW' })).toEqual([]);
    expect(await run({ latestTdhBlockTime: async () => null })).toEqual([]);
    expect(
      await run({ latestTdhBlockTime: async () => at(15) - 3_600_000 })
    ).toEqual([]);
  });

  it('stops when the gateway serves no day', async () => {
    const log = fresh();
    await pollChainDays(poller({ source: source([]) }, log));
    expect(log.events).toEqual([]);
  });
});

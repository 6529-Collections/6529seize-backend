import { MEMES_CONTRACT, USE_CASE_AIRDROPS } from '@/constants';
import { ChainInputs } from './chain-inputs';
import { runParity } from './compare';
import { compareFinalList, rekeyedAfterBuild } from './compare-list';
import { LegacyCsvRow } from './legacy-outputs';
import { summaryLine } from './parity-report';
import {
  A1,
  A2,
  A4,
  BUILD_AT,
  K1,
  K2,
  K3,
  K4,
  legacyOutputs,
  paritySnapshot
} from './parity.fixture';

const D9 = '0x00000000000000000000000000000000000000d9';
const P2 = `0x${'2'.repeat(64)}`;
const P4 = `0x${'4'.repeat(64)}`;

function chain(overrides: Partial<ChainInputs> = {}): ChainInputs {
  const delegation = (
    fromAddress: string,
    toAddress: string,
    block: number
  ) => ({
    fromAddress,
    toAddress,
    collection: MEMES_CONTRACT,
    useCase: USE_CASE_AIRDROPS,
    block,
    expiry: BUILD_AT / 1000 + 1000,
    allTokens: true
  });
  return {
    version: 1,
    source: 'fixture',
    nowSeconds: BUILD_AT / 1000,
    delegations: [
      delegation(K1, A1, 10),
      delegation(K2.split('-')[1], A2, 11),
      delegation(K4, A4, 12)
    ],
    boostedTdhByWallet: {},
    ...overrides
  };
}

function withListRows(rows: LegacyCsvRow[]) {
  const legacy = legacyOutputs();
  return { ...legacy, csv: { ...legacy.csv!, rows } };
}

describe('runParity in gate mode', () => {
  it('matches on data where inputs read before the build give the list', () => {
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy: legacyOutputs(),
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(reports.map((r) => [r.gate, r.phase, r.verdict])).toEqual([
      ['LIST', null, 'MATCH'],
      ['PHASE', 'Phase 0', 'MATCH'],
      ['PHASE', 'Phase 1', 'MATCH'],
      ['PHASE', 'Public', 'MATCH'],
      ['REDEMPTIONS', null, 'MATCH']
    ]);
    const g1 = reports[0];
    expect(g1.mode).toBe('gate');
    expect(g1.checked).toEqual(['rows', 'count', 'cards', 'balance']);
    expect(g1.notChecked).toEqual([
      'airdropAddress (copied from legacy route, read before the build)',
      'order (subscribed_at; positions reported)'
    ]);
    expect(reports[1].notChecked[0]).toContain('membership (copied');
    expect(reports[4].checked).toEqual(['redemption', 'count', 'balanceAfter']);
    expect(reports[4].notes[0]).toBe('transfers: 4, skipped: 1');
    expect(summaryLine(g1)).toBe(
      'LIST card 500 run1 [gate]: MATCH on rows, count, cards, balance ' +
        '(old 3 rows/5 cards, new 3 rows/5 cards, 0 diffs); not checked: ' +
        'airdropAddress (copied from legacy route, read before the build), ' +
        'order (subscribed_at; positions reported)'
    );
  });

  it('checks airdrop addresses in run 2, where the ported rule runs', () => {
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy: legacyOutputs(),
      run: 'run2',
      buildAtMs: BUILD_AT,
      chain: chain()
    });
    expect(reports.every((r) => r.verdict === 'MATCH')).toBe(true);
    expect(reports[0].checked).toContain('airdropAddress');
  });

  it('names a chain-sourced airdrop address that differs', () => {
    const c = chain();
    const { report } = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: legacyOutputs(),
      run: 'run2',
      buildAtMs: BUILD_AT,
      chain: {
        ...c,
        delegations: [
          { ...c.delegations[0], toAddress: D9 },
          ...c.delegations.slice(1)
        ]
      }
    });
    expect(report.diffs).toEqual([
      {
        key: K1,
        field: 'airdropAddress',
        old: A1,
        new: D9,
        cause: 'chain-source'
      }
    ]);
  });

  it('resolves principal ids on their wallet lists in run 2', () => {
    const c = chain({
      keyMap: { [K2]: P2, [K4]: P4 },
      identities: { [P2]: K2.split('-'), [P4]: [K4] }
    });
    const legacy = legacyOutputs();
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy,
      run: 'run2',
      buildAtMs: BUILD_AT,
      chain: c
    });
    expect(reports.map((r) => r.verdict)).toEqual([
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH'
    ]);
    const missing = compareFinalList({
      snapshot: paritySnapshot(),
      legacy,
      run: 'run2',
      buildAtMs: BUILD_AT,
      chain: { ...c, identities: { [P2]: K2.split('-') } }
    });
    expect(missing.report.diffs).toEqual([
      {
        key: P4,
        field: 'airdropAddress',
        old: A4,
        new: null,
        cause: 'no-wallets'
      },
      {
        key: P4,
        field: 'identityWallets',
        old: null,
        new: null,
        cause: 'no-wallets'
      }
    ]);
  });

  it('reports a duplicated identity and the card total, never MATCH', () => {
    const rows = legacyOutputs().csv!.rows;
    const { report } = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: withListRows([...rows, { ...rows[0], count: 9 }]),
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.verdict).toBe('DIFF');
    expect(report.old.rows).toBe(4);
    expect(report.diffs).toEqual([
      { key: K2, field: 'rows', old: 2, new: 1, cause: 'duplicate-identity' },
      { key: null, field: 'cards', old: 14, new: 5, cause: 'unknown' }
    ]);
  });

  it('reports a count difference and a key it never read', () => {
    const snapshot = paritySnapshot();
    const rows = legacyOutputs().csv!.rows;
    const { report } = compareFinalList({
      snapshot: {
        ...snapshot,
        subscribers: snapshot.subscribers.filter((s) => s.key !== K4)
      },
      legacy: withListRows(
        rows.map((r) => (r.key === K1 ? { ...r, count: 1 } : r))
      ),
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.diffs).toEqual([
      { key: K1, field: 'count', old: 1, new: 2, cause: 'unknown' },
      { key: K4, field: 'row', old: 1, new: null, cause: 'key-not-collected' }
    ]);
  });

  it('computes balances from the read and earlier top-ups, and checks them', () => {
    const legacy = legacyOutputs();
    const topUp = (date: string, amount: number) => ({
      hash: '0x' + 'f'.repeat(64),
      block: 1,
      transaction_date: date,
      from_wallet: K3,
      amount
    });
    const withTopUp = (date: string) =>
      compareFinalList({
        snapshot: paritySnapshot(),
        legacy: {
          ...legacy,
          topUps: { ...legacy.topUps, [K3]: [topUp(date, 0.1)] }
        },
        run: 'run1',
        buildAtMs: BUILD_AT
      }).report;
    const before = withTopUp('2026-11-24T23:00:00.000Z');
    expect(before.diffs).toEqual([
      {
        key: K3,
        field: 'row',
        old: 'INSUFFICIENT_BALANCE',
        new: 1,
        cause: 'balance-input'
      },
      { key: null, field: 'cards', old: 5, new: 6, cause: 'unknown' }
    ]);
    const atBuild = withTopUp('2026-11-25T00:00:30.000Z');
    expect(atBuild.diffs[0].cause).toBe('topup-timing');
    const after = withTopUp('2026-11-25T01:00:00.000Z');
    expect(after.verdict).toBe('MATCH');
    const rows = legacy.csv!.rows;
    const changed = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: withListRows(
        rows.map((r) => (r.key === K1 ? { ...r, balance: 0.6 } : r))
      ),
      run: 'run1',
      buildAtMs: BUILD_AT
    }).report;
    expect(changed.diffs).toEqual([
      { key: K1, field: 'balance', old: 0.6, new: 0.5, cause: 'balance-input' }
    ]);
  });

  it('reports a redemption whose balance differs after a top-up', () => {
    const legacy = legacyOutputs();
    const topUps = (block: number, date: string) => ({
      ...legacy.topUps,
      [K1]: [
        {
          hash: '0x' + 'f'.repeat(64),
          block,
          transaction_date: date,
          from_wallet: K1,
          amount: 0.1
        }
      ]
    });
    const late = runParity({
      snapshot: paritySnapshot(),
      legacy: { ...legacy, topUps: topUps(2000, '2026-11-25T16:00:00.000Z') },
      run: 'run1',
      buildAtMs: BUILD_AT
    }).find((r) => r.gate === 'REDEMPTIONS')!;
    expect(late.verdict).toBe('MATCH');
    const early = runParity({
      snapshot: paritySnapshot(),
      legacy: { ...legacy, topUps: topUps(900, '2026-11-25T10:00:00.000Z') },
      run: 'run1',
      buildAtMs: BUILD_AT
    }).find((r) => r.gate === 'REDEMPTIONS')!;
    expect(early.diffs).toEqual([
      {
        key: K1,
        transaction: legacy.redeemed[0].transaction,
        field: 'balanceAfter',
        old: 0.36942,
        new: 0.46942,
        cause: 'topup-timing'
      }
    ]);
  });

  it('reports a phase list that differs from the phase route', () => {
    const legacy = legacyOutputs();
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        phaseLists: {
          ...legacy.phaseLists,
          'Phase 1': [{ wallet: A2, amount: 1 }]
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(reports.find((r) => r.phase === 'Phase 1')!.diffs).toEqual([
      {
        key: null,
        wallet: A2,
        field: 'phaseRow',
        old: [1],
        new: [2],
        cause: 'unknown'
      }
    ]);
  });
});

describe('a snapshot read after the build', () => {
  it('is never a gate MATCH, and is fine for a pinned diagnostic', () => {
    const snapshot = paritySnapshot();
    const late = {
      ...snapshot,
      subscribers: snapshot.subscribers.map((s) => ({
        ...s,
        collectedAtMs: BUILD_AT + 60_000
      }))
    };
    const gate = compareFinalList({
      snapshot: late,
      legacy: legacyOutputs(),
      run: 'run1',
      buildAtMs: BUILD_AT
    }).report;
    expect(gate.verdict).toBe('DIFF');
    expect(gate.diffs).toContainEqual({
      key: null,
      field: 'keysReadAfterBuild',
      old: 0,
      new: 4,
      cause: 'read-after-build'
    });
    const pinned = compareFinalList({
      snapshot: late,
      legacy: legacyOutputs(),
      run: 'run1',
      mode: 'pinned',
      buildAtMs: BUILD_AT
    }).report;
    expect(pinned.diffs.map((d) => d.field)).not.toContain(
      'keysReadAfterBuild'
    );
  });
});

describe('notes and timing', () => {
  it('counts per-key notes and names keys whose count came from a build line', () => {
    const snapshot = paritySnapshot();
    const { report } = compareFinalList({
      snapshot: {
        ...snapshot,
        subscribers: snapshot.subscribers.map((s) =>
          s.key === K1
            ? {
                ...s,
                upcoming: null,
                logs: [
                  {
                    id: 1,
                    createdAtMs: BUILD_AT - 86_400_000,
                    log: 'Added to Final Subscription for Meme #500 on 2026-11-24',
                    additionalInfo: `Airdrop Address: ${A1} - Subscription Count: x2 - Balance: 0.5 ETH`
                  }
                ]
              }
            : s
        )
      },
      legacy: legacyOutputs(),
      run: 'run1',
      mode: 'pinned',
      buildAtMs: BUILD_AT
    });
    expect(report.notes).toContain(
      'input notes (keys): CARD_FROM_LOGS 1, COUNT_FROM_BUILD_LINE 1, LATER_LOGS_APPLIED 3, ROW_FLAG_UNKNOWN 1, ROW_TIME_UNKNOWN 1'
    );
    expect(report.notChecked).toContain(
      `count for 1 keys taken from an earlier build line: ${K1}`
    );
  });

  it('names a top-up within three minutes of the read as timing', () => {
    const legacy = legacyOutputs();
    const readAt = paritySnapshot().subscribers[0].collectedAtMs;
    const { report } = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        topUps: {
          ...legacy.topUps,
          [K1]: [
            {
              hash: '0x' + 'e'.repeat(64),
              block: 1,
              transaction_date: new Date(readAt + 60_000).toISOString(),
              from_wallet: K1,
              amount: 0.1
            }
          ]
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.diffs).toEqual([
      { key: K1, field: 'balance', old: 0.5, new: 0.6, cause: 'topup-timing' }
    ]);
  });

  it('applies a mode line from the cached minute before the read', () => {
    const snapshot = paritySnapshot();
    const k4 = snapshot.subscribers.find((s) => s.key === K4)!;
    const { report } = compareFinalList({
      snapshot: {
        ...snapshot,
        subscribers: snapshot.subscribers.map((s) =>
          s.key === K4 && s.details
            ? {
                ...s,
                details: { ...s.details, automatic: false, last_update: 0 },
                logs: [
                  {
                    id: 7000,
                    createdAtMs: k4.collectedAtMs - 30_000,
                    log: 'Subscription Mode set to Automatic',
                    additionalInfo: null
                  }
                ]
              }
            : s
        )
      },
      legacy: legacyOutputs(),
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.diffs.map((d) => d.key)).not.toContain(K4);
  });
});

describe('pinned mode', () => {
  it('copies balances and run 1 airdrop addresses and checks neither', () => {
    const snapshot = paritySnapshot();
    const { report } = compareFinalList({
      snapshot: {
        ...snapshot,
        subscribers: snapshot.subscribers.map((s) =>
          s.key === K1 && s.airdrop && s.details
            ? {
                ...s,
                airdrop: { ...s.airdrop, airdropAddress: D9 },
                details: { ...s.details, balance: 0.01 }
              }
            : s
        )
      },
      legacy: legacyOutputs(),
      run: 'run1',
      mode: 'pinned',
      buildAtMs: BUILD_AT
    });
    expect(report.verdict).toBe('MATCH');
    expect(report.checked).toEqual(['rows', 'count', 'cards']);
    expect(report.notChecked).toEqual([
      'balance (copied from build lines)',
      'airdropAddress (copied from legacy build lines)',
      'order (subscribed_at; positions reported)'
    ]);
    expect(report.notes).toContain(
      'airdrop route moved after the build: 1 keys'
    );
  });
});

describe('rekeyedAfterBuild', () => {
  const single = K2.split('-')[0];

  it('maps a list key that a consolidation moved after the build', () => {
    expect(
      rekeyedAfterBuild([single, K1], [single, K1, K2], new Set([K1, K2]))
    ).toEqual(new Map([[single, K2]]));
    const rows = legacyOutputs().csv!.rows;
    const legacy = withListRows(
      rows.map((r) => (r.key === K2 ? { ...r, key: single } : r))
    );
    const pinned = compareFinalList({
      snapshot: paritySnapshot(),
      legacy,
      run: 'run1',
      mode: 'pinned',
      buildAtMs: BUILD_AT
    }).report;
    expect(pinned.verdict).toBe('MATCH');
    expect(pinned.notes).toContain('list keys re-keyed after the build: 1');
  });

  it('in gate mode, needs a key map to explain a re-keyed list row', () => {
    const rows = legacyOutputs().csv!.rows;
    const legacy = withListRows(
      rows.map((r) => (r.key === K2 ? { ...r, key: single } : r))
    );
    const unexplained = compareFinalList({
      snapshot: paritySnapshot(),
      legacy,
      run: 'run1',
      buildAtMs: BUILD_AT
    }).report;
    expect(unexplained.diffs).toEqual([
      { key: K2, field: 'listKey', old: single, new: K2, cause: 'key-map' }
    ]);
    const explained = compareFinalList({
      snapshot: paritySnapshot(),
      legacy,
      run: 'run1',
      buildAtMs: BUILD_AT,
      chain: {
        version: 1,
        source: 'key map',
        nowSeconds: BUILD_AT / 1000,
        delegations: [],
        boostedTdhByWallet: {},
        keyMap: { [single]: K2 }
      }
    }).report;
    expect(explained.verdict).toBe('MATCH');
  });

  it('refuses a holder that has its own list row or that two keys claim', () => {
    const other = K2.split('-')[1];
    expect(
      rekeyedAfterBuild([single], [single, K2], new Set([single, K2]))
    ).toEqual(new Map());
    expect(
      rekeyedAfterBuild([single, K2], [single, K2], new Set([K2]))
    ).toEqual(new Map());
    expect(
      rekeyedAfterBuild([single, other], [single, other, K2], new Set([K2]))
    ).toEqual(new Map());
  });
});

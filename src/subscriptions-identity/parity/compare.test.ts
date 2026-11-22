import { MEMES_CONTRACT, USE_CASE_AIRDROPS } from '@/constants';
import {
  ChainInputs,
  compareFinalList,
  rekeyedAfterBuild,
  runParity,
  summaryLine
} from './compare';
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

function chain(overrides: Partial<ChainInputs> = {}): ChainInputs {
  return {
    version: 1,
    source: 'fixture',
    nowSeconds: BUILD_AT / 1000,
    delegations: [
      {
        fromAddress: K1,
        toAddress: A1,
        collection: MEMES_CONTRACT,
        useCase: USE_CASE_AIRDROPS,
        block: 10,
        expiry: BUILD_AT / 1000 + 1000,
        allTokens: true
      },
      {
        fromAddress: K2.split('-')[1],
        toAddress: A2,
        collection: MEMES_CONTRACT,
        useCase: USE_CASE_AIRDROPS,
        block: 11,
        expiry: BUILD_AT / 1000 + 1000,
        allTokens: true
      },
      {
        fromAddress: K4,
        toAddress: A4,
        collection: MEMES_CONTRACT,
        useCase: USE_CASE_AIRDROPS,
        block: 12,
        expiry: BUILD_AT / 1000 + 1000,
        allTokens: true
      }
    ],
    boostedTdhByWallet: {},
    ...overrides
  };
}

describe('runParity', () => {
  it('matches the legacy list, phases and redemptions on consistent data', () => {
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
    expect(reports[0].positionsDiffer).toBe(0);
    expect(reports[4].notes[0]).toBe('transfers: 4, skipped: 1');
    expect(summaryLine(reports[0])).toBe(
      'LIST card 500 run1: MATCH (old 3 rows, new 3 rows, 0 diffs)'
    );
  });

  it('matches in run 2 with airdrop addresses from chain records', () => {
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy: legacyOutputs(),
      run: 'run2',
      buildAtMs: BUILD_AT,
      chain: chain()
    });
    expect(reports.every((r) => r.verdict === 'MATCH')).toBe(true);
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
    expect(report.verdict).toBe('DIFF');
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

  it('reports a count difference and a key it never read', () => {
    const legacy = legacyOutputs();
    const snapshot = paritySnapshot();
    const csv = legacy.csv!;
    const { report } = compareFinalList({
      snapshot: {
        ...snapshot,
        subscribers: snapshot.subscribers.filter((s) => s.key !== K4)
      },
      legacy: {
        ...legacy,
        csv: {
          ...csv,
          rows: csv.rows.map((r) => (r.key === K1 ? { ...r, count: 1 } : r))
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.diffs).toEqual([
      { key: K1, field: 'count', old: 1, new: 2, cause: 'unknown' },
      { key: K4, field: 'row', old: 1, new: null, cause: 'key-not-collected' }
    ]);
  });

  it('flags an extra new row the legacy build left out for balance', () => {
    const legacy = legacyOutputs();
    const { report } = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        buildDecisions: {
          ...legacy.buildDecisions,
          [K3]: {
            kind: 'INSUFFICIENT_BALANCE',
            date: legacy.buildDate,
            balance: 0.03
          }
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT,
      pinBalances: false
    });
    expect(report.verdict).toBe('MATCH');
    const snapshot = paritySnapshot();
    const richer = {
      ...snapshot,
      subscribers: snapshot.subscribers.map((s) =>
        s.key === K3 && s.details
          ? { ...s, details: { ...s.details, balance: 1 } }
          : s
      )
    };
    const second = compareFinalList({
      snapshot: richer,
      legacy,
      run: 'run1',
      buildAtMs: BUILD_AT,
      pinBalances: false
    });
    expect(second.report.diffs).toEqual([
      {
        key: K3,
        field: 'row',
        old: 'INSUFFICIENT_BALANCE',
        new: 1,
        cause: 'balance-input'
      }
    ]);
  });

  it('reports a redemption whose balance differs after a top-up', () => {
    const legacy = legacyOutputs();
    const reports = runParity({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        topUps: {
          ...legacy.topUps,
          [K1]: [
            {
              hash: '0x' + 'f'.repeat(64),
              block: 2000,
              transaction_date: '2026-11-25T16:00:00.000Z',
              from_wallet: K1,
              amount: 0.1
            }
          ]
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    const g3 = reports.find((r) => r.gate === 'REDEMPTIONS')!;
    expect(g3.verdict).toBe('MATCH');
    const early = runParity({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        topUps: {
          ...legacy.topUps,
          [K1]: [
            {
              hash: '0x' + 'f'.repeat(64),
              block: 900,
              transaction_date: '2026-11-25T10:00:00.000Z',
              from_wallet: K1,
              amount: 0.1
            }
          ]
        }
      },
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

  it('maps a list key that a consolidation moved after the build', () => {
    const single = K2.split('-')[0];
    expect(
      rekeyedAfterBuild([single, K1], [single, K1, K2], new Set([K1, K2]))
    ).toEqual(new Map([[single, K2]]));
    expect(
      rekeyedAfterBuild([single], [single, K2], new Set([single, K2]))
    ).toEqual(new Map());
    const legacy = legacyOutputs();
    const csv = legacy.csv!;
    const { report } = compareFinalList({
      snapshot: paritySnapshot(),
      legacy: {
        ...legacy,
        csv: {
          ...csv,
          rows: csv.rows.map((r) => (r.key === K2 ? { ...r, key: single } : r))
        }
      },
      run: 'run1',
      buildAtMs: BUILD_AT
    });
    expect(report.verdict).toBe('MATCH');
    expect(report.notes).toContain('list keys re-keyed after the build: 1');
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
    const phase1 = reports.find((r) => r.phase === 'Phase 1')!;
    expect(phase1.diffs).toEqual([
      {
        key: null,
        wallet: A2,
        field: 'phaseRow',
        old: 1,
        new: 2,
        cause: 'unknown'
      }
    ]);
  });
});

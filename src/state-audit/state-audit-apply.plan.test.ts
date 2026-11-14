import fc from 'fast-check';
import { NULL_ADDRESS } from '@/constants';
import { canonicalJson } from '@/nft-history/canonical-json';
import {
  ApplyRejection,
  buildRepairUnits,
  expectedLedgerImage,
  validateApplyManifest
} from './state-audit-apply.plan';
import { compareLedgerRows } from './state-audit.db';
import {
  computePlanDigest,
  Discrepancy,
  emptySummary,
  ExpectedLedgerRow,
  LedgerRow,
  StateAuditManifest
} from './state-audit.manifest';
import { RECONCILIATION_CONSUMERS } from './state-audit.service';

const MEMES = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const ZERO = NULL_ADDRESS.toLowerCase();
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const C = '0x4444444444444444444444444444444444444444';
const TX1 = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;
const TX3 = `0x${'3'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const NOW = new Date('2026-11-09T12:00:00.000Z');

function row(
  transaction: string,
  from: string,
  to: string,
  token_id: string,
  token_count: number,
  block = 100
): LedgerRow {
  return {
    transaction,
    block,
    from_address: from,
    to_address: to,
    contract: MEMES,
    token_id,
    token_count
  };
}

function expected(
  transaction: string,
  from: string,
  to: string,
  token_id: string,
  token_count: number,
  block = 100
): ExpectedLedgerRow {
  return {
    ...row(transaction, from, to, token_id, token_count, block),
    block_hash: HASH,
    log_indexes: [0]
  };
}

function manifestWith(
  discrepancies: Discrepancy[],
  overrides: Partial<StateAuditManifest> = {}
): StateAuditManifest {
  const manifest: StateAuditManifest = {
    manifest_version: 1,
    generated_at: '2026-11-09T00:00:00.000Z',
    tool: { name: 'state-audit', mode: 'read-only' },
    status: discrepancies.length ? 'differences_found' : 'clean',
    inconclusive_reasons: [],
    chain_id: 1,
    contract: {
      requested: 'memes',
      address: MEMES,
      name: 'memes',
      supported: true
    },
    requested_scope: { from_block: 100, to_block: 110, wallets_filter: [] },
    inspected_scope: {
      from_block: 100,
      to_block: 110,
      blocks_inspected: 11,
      complete: true,
      chunks: [{ from_block: 100, to_block: 110, log_count: 1 }]
    },
    anchors: {
      from_block: { number: 100, hash: HASH },
      to_block: { number: 110, hash: HASH },
      finalized: { number: 500, hash: HASH }
    },
    data_sources: [],
    verification_assumptions: [],
    inspected: { transactions: [], log_count: 0, edge_count: 0 },
    digests: {
      chain_edges: 'c'.repeat(64),
      ledger_before_image: 'd'.repeat(64)
    },
    ledger_before_image: { row_count: 1 },
    summary: emptySummary(),
    discrepancies,
    affected_wallets: [],
    derived_checks: {
      owner_balance: {
        status: 'not_applicable',
        reason: null,
        owners_block_reference: null,
        wallets_checked: [],
        assumptions: []
      }
    },
    reconciliation_plan: {
      consumers: RECONCILIATION_CONSUMERS,
      wallets: [],
      enqueue_pattern: '',
      notes: []
    },
    plan_digest: '',
    ...overrides
  };
  manifest.plan_digest = computePlanDigest(manifest);
  return manifest;
}

const countMismatch: Discrepancy = {
  type: 'token_count_mismatch',
  transaction: TX1,
  stored_row: row(TX1, A, B, '1', 1),
  expected_row: expected(TX1, A, B, '1', 2)
};

function options(
  overrides: Partial<Parameters<typeof validateApplyManifest>[1]> = {}
) {
  return {
    planDigest: '',
    chainId: 1,
    now: NOW,
    maxManifestAgeHours: 168,
    ...overrides
  };
}

function rejectionOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof ApplyRejection) return error.code;
    throw error;
  }
  throw new Error('expected an ApplyRejection');
}

describe('validateApplyManifest', () => {
  it('accepts a conclusive differences_found manifest with the reviewed digest', () => {
    const manifest = manifestWith([countMismatch]);
    const parsed = validateApplyManifest(
      JSON.parse(JSON.stringify(manifest)),
      options({ planDigest: manifest.plan_digest })
    );
    expect(parsed.plan_digest).toBe(manifest.plan_digest);
  });

  it.each<[string, () => unknown, Partial<ReturnType<typeof options>>, string]>(
    [
      ['a non-object', () => 'nope', {}, 'manifest_invalid'],
      [
        'a future manifest version',
        () => ({ ...manifestWith([countMismatch]), manifest_version: 2 }),
        {},
        'manifest_unsupported'
      ],
      [
        'an edited discrepancy',
        () => {
          const manifest = manifestWith([countMismatch]);
          return {
            ...manifest,
            discrepancies: [
              { ...countMismatch, expected_row: expected(TX1, A, B, '1', 3) }
            ]
          };
        },
        {},
        'plan_digest_mismatch'
      ],
      [
        'a different reviewed digest',
        () => manifestWith([countMismatch]),
        { planDigest: 'e'.repeat(64) },
        'plan_digest_mismatch'
      ],
      [
        'a clean manifest',
        () => manifestWith([]),
        {},
        'manifest_not_applicable'
      ],
      [
        'an inconclusive manifest',
        () =>
          manifestWith([countMismatch], {
            status: 'inconclusive',
            inconclusive_reasons: [{ code: 'rpc_error', detail: 'x' }]
          }),
        {},
        'manifest_not_applicable'
      ],
      [
        'an unsupported contract',
        () =>
          manifestWith([countMismatch], {
            contract: {
              requested: 'x',
              address: `0x${'f'.repeat(40)}`,
              name: null,
              supported: false
            }
          }),
        {},
        'unsupported_contract'
      ],
      [
        'another chain',
        () => manifestWith([countMismatch]),
        { chainId: 11155111 },
        'chain_id_mismatch'
      ],
      [
        'a manifest older than the limit',
        () => manifestWith([countMismatch]),
        { now: new Date('2026-11-17T00:00:00.001Z') },
        'manifest_stale'
      ],
      [
        'an unknown discrepancy type',
        () => {
          const manifest = manifestWith([countMismatch]);
          return {
            ...manifest,
            discrepancies: [{ ...countMismatch, type: 'something_else' }]
          };
        },
        {},
        'manifest_invalid'
      ]
    ]
  )('rejects %s', (_name, build, overrides, code) => {
    const raw = build();
    const planDigest =
      typeof raw === 'object' && raw !== null && 'plan_digest' in raw
        ? String((raw as { plan_digest: unknown }).plan_digest)
        : '';
    expect(
      rejectionOf(() =>
        validateApplyManifest(raw, options({ planDigest, ...overrides }))
      )
    ).toBe(code);
  });
});

describe('buildRepairUnits', () => {
  const beforeImage = [
    row(TX1, A, B, '1', 1),
    row(TX1, A, C, '2', 1),
    row(TX3, B, ZERO, '1', 1, 105)
  ];

  it('derives one unit per transaction with before and after rows', () => {
    const units = buildRepairUnits(
      [
        {
          type: 'missing_transaction',
          transaction: TX2,
          block: 103,
          stored_rows: [],
          expected_rows: [expected(TX2, ZERO, C, '3', 1, 103)]
        },
        countMismatch,
        {
          type: 'unexpected_row',
          transaction: TX3,
          detail: 'no_chain_transaction',
          stored_row: beforeImage[2],
          expected_row: null
        },
        {
          type: 'missing_edge',
          transaction: TX1,
          stored_row: null,
          expected_row: expected(TX1, A, B, '4', 1)
        }
      ],
      beforeImage
    );
    expect(units.map((unit) => [unit.index, unit.transaction])).toEqual([
      [0, TX1],
      [1, TX2],
      [2, TX3]
    ]);
    expect(units[0].actions.map((action) => action.action)).toEqual([
      'update_token_count',
      'insert'
    ]);
    expect(units[0].after_rows).toEqual([
      row(TX1, A, B, '1', 2),
      row(TX1, A, B, '4', 1),
      row(TX1, A, C, '2', 1)
    ]);
    expect(units[0].wallets).toEqual([A, B, C]);
    expect(units[1]).toMatchObject({
      block: 103,
      before_rows: [],
      after_rows: [row(TX2, ZERO, C, '3', 1, 103)],
      wallets: [C],
      excluded_wallets: [ZERO]
    });
    expect(units[2]).toMatchObject({
      before_rows: [beforeImage[2]],
      after_rows: [],
      wallets: [B],
      excluded_wallets: [ZERO]
    });
  });

  it('replaces the token id as a copy plus delete in the after image', () => {
    const units = buildRepairUnits(
      [
        {
          type: 'token_id_mismatch',
          transaction: TX1,
          stored_row: row(TX1, A, C, '2', 1),
          expected_row: expected(TX1, A, C, '9', 1)
        }
      ],
      beforeImage
    );
    expect(units[0].after_rows).toEqual([
      row(TX1, A, B, '1', 1),
      row(TX1, A, C, '9', 1)
    ]);
  });

  it('ignores owner balance discrepancies', () => {
    expect(
      buildRepairUnits(
        [
          {
            type: 'owner_balance_mismatch',
            wallet: A,
            token_id: '1',
            stored_row: null,
            expected_row: {
              wallet: A,
              contract: MEMES,
              token_id: '1',
              balance: 1
            }
          }
        ],
        beforeImage
      )
    ).toEqual([]);
  });

  it.each<[string, Discrepancy]>([
    [
      'a case-variant duplicate row',
      {
        type: 'unexpected_row',
        transaction: TX1,
        detail: 'duplicate_normalized_key',
        stored_row: row(TX1, A, B, '1', 1),
        expected_row: null
      }
    ]
  ])('rejects %s as unsupported', (_name, discrepancy) => {
    expect(
      rejectionOf(() => buildRepairUnits([discrepancy], beforeImage))
    ).toBe('unsupported_discrepancy');
  });

  it.each<[string, Discrepancy]>([
    [
      'a stored row that is not in the before-image',
      {
        type: 'token_count_mismatch',
        transaction: TX1,
        stored_row: row(TX1, A, B, '1', 7),
        expected_row: expected(TX1, A, B, '1', 2)
      }
    ],
    [
      'an insert of a row the before-image already holds',
      {
        type: 'missing_edge',
        transaction: TX1,
        stored_row: null,
        expected_row: expected(TX1, A, B, '1', 2)
      }
    ]
  ])('rejects %s as inconsistent', (_name, discrepancy) => {
    expect(
      rejectionOf(() => buildRepairUnits([discrepancy], beforeImage))
    ).toBe('plan_inconsistent');
  });
});

describe('expectedLedgerImage', () => {
  const address = fc.constantFrom(A, B, C, ZERO);
  const tx = fc
    .integer({ min: 1, max: 6 })
    .map((n) => `0x${String(n).repeat(64)}`);
  const ledgerRow = fc
    .record({
      transaction: tx,
      from: address,
      to: address,
      token_id: fc.integer({ min: 1, max: 3 }).map(String),
      token_count: fc.integer({ min: 1, max: 5 })
    })
    .map((r) => row(r.transaction, r.from, r.to, r.token_id, r.token_count));
  const distinctRows = fc.array(ledgerRow, { maxLength: 12 }).map((rows) => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = `${r.transaction}|${r.from_address}|${r.to_address}|${r.token_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  it('with no applied units is the sorted before-image, and applying every unit yields the after-rows', () => {
    fc.assert(
      fc.property(distinctRows, (image) => {
        // Every stored row is one count off: one update per row, grouped by transaction.
        const discrepancies: Discrepancy[] = image.map((stored) => ({
          type: 'token_count_mismatch',
          transaction: stored.transaction,
          stored_row: stored,
          expected_row: {
            ...expected(
              stored.transaction,
              stored.from_address,
              stored.to_address,
              stored.token_id,
              stored.token_count + 1,
              stored.block
            )
          }
        }));
        const units = buildRepairUnits(discrepancies, image);
        const untouched = expectedLedgerImage(image, units, 0);
        expect(canonicalJson(untouched)).toBe(
          canonicalJson(image.slice().sort(compareLedgerRows))
        );
        const all = expectedLedgerImage(image, units, units.length);
        expect(canonicalJson(all)).toBe(
          canonicalJson(
            image
              .map((r) => ({ ...r, token_count: r.token_count + 1 }))
              .sort(compareLedgerRows)
          )
        );
        for (let next = 0; next <= units.length; next++) {
          expect(expectedLedgerImage(image, units, next)).toHaveLength(
            image.length
          );
        }
      })
    );
  });
});

import * as fc from 'fast-check';
import {
  applyEffectsToState,
  changedParts,
  diffCardState,
  differingParts,
  emptyCardState
} from './mint-log-diff';
import { MintCardState, MintMerkleRoot, MintRow } from './mint-log.types';

const wallet = fc
  .integer({ min: 1, max: 40 })
  .map((n) => `0x${n.toString(16).padStart(40, '0')}`);

const distributionRow = fc.record({
  id: fc.integer({ min: 1, max: 30 }),
  card_id: fc.constant(100),
  contract: fc.constant('0xabc'),
  phase: fc.constantFrom('Phase 0', 'Phase 1', 'Airdrop - Team'),
  wallet,
  count: fc.integer({ min: 0, max: 5 }),
  created_at: fc.constant('2026-11-20 10:00:00.000000')
});

const actionRow = fc.record({
  id: fc.constantFrom('a1', 'a2', 'a3'),
  contract: fc.constant('0xabc'),
  claim_id: fc.constant(100),
  action: fc.constantFrom('ARTIST_AIRDROP', 'PAY_ARTIST'),
  completed: fc.constantFrom(0, 1)
});

const merkleRoot = fc
  .record({
    phase: fc.constantFrom('Phase 0', 'Phase 1', 'Phase 2'),
    merkle_root: fc.hexaString({ minLength: 4, maxLength: 4 }),
    allowlist: fc.array(fc.tuple(wallet, fc.integer({ min: 1, max: 3 })), {
      maxLength: 3
    })
  })
  .map(
    (root): MintMerkleRoot => ({
      row: { phase: root.phase, merkle_root: root.merkle_root },
      allowlist: root.allowlist,
      raw_proofs: null
    })
  );

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) seen.set(key(row), row);
  return Array.from(seen.values());
}

const cardState: fc.Arbitrary<MintCardState> = fc
  .record({
    distribution: fc.array(distributionRow, { maxLength: 12 }),
    claim_actions: fc.array(actionRow, { maxLength: 3 }),
    merkle: fc.array(merkleRoot, { maxLength: 3 })
  })
  .map((parts) => {
    const state = emptyCardState();
    const merkle = uniqueBy(parts.merkle, (root) => String(root.row.phase));
    return {
      ...state,
      distribution: applyEffectsToState(state, {
        distribution: {
          upsert: uniqueBy(parts.distribution, (row) => String(row.id)),
          delete: []
        }
      }).distribution,
      claim_actions: applyEffectsToState(state, {
        claim_actions: {
          upsert: uniqueBy(parts.claim_actions, (row) => row.id),
          delete: []
        }
      }).claim_actions,
      merkle: applyEffectsToState(state, {
        merkle: { upsert: merkle, delete: [] }
      }).merkle
    };
  });

describe('mint log diff', () => {
  it('reads a part missing from an older state (a genesis file written before the part) as empty', () => {
    const current: MintCardState = {
      ...emptyCardState(),
      subscription_phases_identity: [
        { id: 7, phase: 'Public', phase_subscriptions: 1, phase_position: 1 }
      ]
    };
    const { subscription_phases_identity: _missing, ...older } =
      emptyCardState();
    const file = older as MintCardState;

    expect(changedParts(diffCardState(current, file))).toEqual([]);
    expect(changedParts(diffCardState(file, current))).toEqual([
      'subscription_phases_identity'
    ]);
    expect(applyEffectsToState(file, {}).subscription_phases_identity).toEqual(
      []
    );
    expect(differingParts(file, emptyCardState())).toEqual([]);
  });

  it('turns any captured state into any other by its diff', () => {
    fc.assert(
      fc.property(cardState, cardState, (before, after) => {
        const effects = diffCardState(before, after);
        expect(
          differingParts(applyEffectsToState(before, effects), after)
        ).toEqual([]);
      })
    );
  });

  it('is empty between equal states', () => {
    fc.assert(
      fc.property(cardState, (state) => {
        expect(changedParts(diffCardState(state, state))).toEqual([]);
      })
    );
  });

  it('logs only changed rows, and deletes by key', () => {
    const before = applyEffectsToState(emptyCardState(), {
      distribution: {
        upsert: [
          { id: 1, wallet: '0x1', count: 1 },
          { id: 2, wallet: '0x2', count: 1 },
          { id: 3, wallet: '0x3', count: 1 }
        ],
        delete: []
      }
    });
    const after = applyEffectsToState(before, {
      distribution: {
        upsert: [{ id: 2, wallet: '0x2', count: 4 }],
        delete: [{ id: 3 }]
      }
    });
    expect(diffCardState(before, after)).toEqual({
      distribution: {
        upsert: [{ id: 2, wallet: '0x2', count: 4 }],
        delete: [{ id: 3 }]
      }
    });
  });

  it('follows only phase changes on subscription rows another module owns', () => {
    const row = (id: number, phase: string | null): MintRow => ({
      id,
      phase,
      phase_subscriptions: phase ? 2 : -1,
      phase_position: phase ? 1 : -1
    });
    const before: MintCardState = {
      ...emptyCardState(),
      subscription_phases: [row(1, null), row(2, null)]
    };
    const after: MintCardState = {
      ...emptyCardState(),
      // Row 1 gets a phase, row 2 is gone, row 3 is new without a phase.
      subscription_phases: [row(1, 'Phase 1'), row(3, null)]
    };
    expect(diffCardState(before, after)).toEqual({
      subscription_phases: { upsert: [row(1, 'Phase 1')], delete: [] }
    });
  });

  it('replaces and removes merkle roots by phase', () => {
    const root = (phase: string, merkle: string): MintMerkleRoot => ({
      row: { phase, merkle_root: merkle },
      allowlist: [['0x1', 1]],
      raw_proofs: null
    });
    const before: MintCardState = {
      ...emptyCardState(),
      merkle: [root('Phase 0', '0xaa'), root('Phase 1', '0xbb')]
    };
    const after: MintCardState = {
      ...emptyCardState(),
      merkle: [root('Phase 1', '0xcc')]
    };
    expect(diffCardState(before, after)).toEqual({
      merkle: { upsert: [root('Phase 1', '0xcc')], delete: ['Phase 0'] }
    });
  });
});

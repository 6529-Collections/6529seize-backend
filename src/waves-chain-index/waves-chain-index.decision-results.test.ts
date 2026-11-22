import {
  FakeChain,
  FakeClock,
  FakeIndexDb,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import { ClaimBuildMessage, ClaimBuildPort } from './waves-chain-index.claims';
import {
  ChainDecisionResult,
  ChainDecisionResults
} from './waves-chain-index.decision-results';
import { WavesChainIndex } from './waves-chain-index.service';

const W1 = id('a1');
const D1 = id('d1');
const D2 = id('d2');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);
const manifest = (entryId: string) => id(`fe${entryId.slice(-8)}`);

/**
 * The mint lane's check (verifyChainClaim): a FINAL result whose rank-1
 * winner is the claim's entry with the claim's manifest.
 */
function claimChecks(
  result: ChainDecisionResult | null,
  chain: ClaimBuildMessage['chain']
): boolean {
  const first = result?.winners.find((winner) => winner.rank === 1);
  return (
    result?.state === 'FINAL' &&
    !!first &&
    first.entry_id === chain.entry_id &&
    first.manifest_hash === chain.manifest_hash
  );
}

describe('ChainDecisionResults (the claim builder decisionResult port)', () => {
  let clock: FakeClock;
  let chain: FakeChain;
  let results: ChainDecisionResults;

  beforeEach(() => {
    clock = new FakeClock();
    chain = new FakeChain(clock);
    chain.putWave(W1);
    chain.putDecision(D1, W1, { counted: true });
    chain.putDecision(D2, W1, { status: 'ended', origin: 'legacy' });
    for (const n of [1, 2, 3]) chain.putEntry(E(n), D1);
    chain.putEntry(E(4), D2, { origin: 'legacy', status: 'winner' });
    chain.vote(E(1), V(1), 5);
    chain.vote(E(2), V(2), 9);
    results = new ChainDecisionResults(chain);
  });

  it('reads an occurrence pinned to the finalized height, winners by rank with their manifests', async () => {
    chain.settle(D1, 7, [E(2), E(1)], 3);
    chain.lag = 0;
    expect(await results.decisionResult(D1, 3)).toEqual({
      decision_id: D1,
      occurrence: 3,
      state: 'FINAL',
      height: chain.height,
      winners: [
        { rank: 1, entry_id: E(2), manifest_hash: manifest(E(2)) },
        { rank: 2, entry_id: E(1), manifest_hash: manifest(E(1)) }
      ]
    });
  });

  it('reads at the finalized height, not the head', async () => {
    chain.settle(D1, 7, [E(1)], 3);
    chain.lag = 1; // the result's block is not final yet
    expect(await results.decisionResult(D1, 3)).toBeNull();
    chain.lag = 0;
    expect((await results.decisionResult(D1, 3))?.state).toBe('FINAL');
  });

  it('reads an imported result, a result still counting, and none', async () => {
    chain.putResult(D2, 1_700_000_000_000, {
      occurrence: 1,
      origin: 'legacy',
      winners: [{ entryId: E(4), rank: 1, score: '9' }]
    });
    chain.putResult(D1, 9, { occurrence: 4, stage: 'scoring' });
    expect(await results.decisionResult(D2, 1)).toMatchObject({
      state: 'FINAL',
      winners: [{ rank: 1, entry_id: E(4), manifest_hash: manifest(E(4)) }]
    });
    expect(await results.decisionResult(D1, 4)).toMatchObject({
      state: 'PENDING',
      winners: []
    });
    expect(await results.decisionResult(D1, 5)).toBeNull();
    expect(await results.decisionResult(id('d9'), 1)).toBeNull();
  });

  it('refuses ids and occurrences of another form', async () => {
    await expect(results.decisionResult('0xD1', 1)).rejects.toThrow(
      'a decision id'
    );
    await expect(results.decisionResult(D1, -1)).rejects.toThrow(
      'an occurrence'
    );
  });

  it("passes the claim builder's check for the claim build the index sends", async () => {
    const sent: ClaimBuildMessage[] = [];
    const queue: ClaimBuildPort = {
      enabled: () => true,
      mainStage: () => new Set([D1]),
      send: async (message) => {
        sent.push(message);
        return 'm-1';
      }
    };
    chain.putEntry(E(1), D1, {
      legacyId: '00000001-0000-4000-8000-000000000001'
    });
    const index = new WavesChainIndex(
      chain,
      new FakeIndexDb().asDb(),
      clock.now,
      undefined,
      queue
    );
    await index.run({ budgetMs: 1_000_000 });
    chain.settle(D1, 7, [E(1), E(2)], 3);
    await index.run({ budgetMs: 1_000_000 });
    expect(sent).toHaveLength(1);
    const result = await results.decisionResult(
      sent[0].chain.decision_id,
      sent[0].chain.occurrence
    );
    expect(claimChecks(result, sent[0].chain)).toBe(true);
    // Another entry, or another manifest, fails it.
    expect(claimChecks(result, { ...sent[0].chain, entry_id: E(2) })).toBe(
      false
    );
    expect(
      claimChecks(result, { ...sent[0].chain, manifest_hash: id('ff') })
    ).toBe(false);
  });
});

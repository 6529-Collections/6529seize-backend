import {
  ChainObject,
  GatewayWavesChainApi,
  WavesChainApi
} from './waves-chain-index.api';

/**
 * A decision's result for one occurrence, read from the chain: the claim
 * builder's port (the mint lane's MintGatewayPort, src/mint-log/
 * mint-gateway.ts on its branch), which checks that a Main Stage claim's
 * entry is the rank-1 winner of a final result before it builds anything.
 * The shapes below are that port's; bind it in the claims builder with
 * `setMintGateway(chainDecisionResults)`.
 *
 * Every read is pinned to one finalized height: the decision's results
 * (imported ones included: their origin is legacy, their stage final),
 * the occurrence's, then each winner's entry for its manifest hash.
 */

export interface ChainResultWinner {
  readonly rank: number;
  readonly entry_id: string;
  readonly manifest_hash: string;
}

export interface ChainDecisionResult {
  readonly decision_id: string;
  readonly occurrence: number;
  /** Only a FINAL result picks a card. */
  readonly state: 'FINAL' | 'PENDING';
  /** The finalized height the result was read at. */
  readonly height: number;
  readonly winners: readonly ChainResultWinner[];
}

const HEX_ID = /^0x[0-9a-f]{64}$/;

function hexId(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

export class ChainDecisionResults {
  constructor(
    private readonly api: Pick<
      WavesChainApi,
      'head' | 'decisionResults' | 'entry'
    > = new GatewayWavesChainApi()
  ) {}

  /**
   * The result of `decisionId`'s occurrence `occurrence` at the finalized
   * height, or null when the chain has no such decision or occurrence.
   */
  async decisionResult(
    decisionId: string,
    occurrence: number
  ): Promise<ChainDecisionResult | null> {
    if (!HEX_ID.test(decisionId)) {
      throw new Error(`${decisionId}: a decision id is 0x and 64 hex digits`);
    }
    if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
      throw new Error(`${occurrence}: an occurrence is 0 or more`);
    }
    const { finalizedHeight: height } = await this.api.head();
    const results = await this.api.decisionResults(decisionId, height);
    if (!results) return null;
    // One result an occurrence; a final one wins over any other.
    const mine = results.filter((r) => Number(r.occurrence) === occurrence);
    const result =
      mine.find((r) => r.stage === 'final') ?? mine[mine.length - 1] ?? null;
    if (!result) return null;
    const winners = await Promise.all(
      (Array.isArray(result.winners)
        ? (result.winners as ChainObject[])
        : []
      ).map(async (winner) => {
        const entryId = hexId(winner.entryId);
        const entry = entryId ? await this.api.entry(entryId, height) : null;
        const manifestHash = hexId(entry?.manifestHash);
        if (!entryId || !manifestHash) {
          throw new Error(
            `Decision ${decisionId} occurrence ${occurrence}: winner ${String(winner.entryId)} has no entry at ${height}`
          );
        }
        return {
          rank: Number(winner.rank),
          entry_id: entryId,
          manifest_hash: manifestHash
        };
      })
    );
    return {
      decision_id: decisionId,
      occurrence,
      state: result.stage === 'final' ? 'FINAL' : 'PENDING',
      height,
      winners: winners.sort((a, b) => a.rank - b.rank)
    };
  }
}

/** The port, read through the chain gateway (CHAIN_GATEWAY_* settings). */
export const chainDecisionResults = new ChainDecisionResults();

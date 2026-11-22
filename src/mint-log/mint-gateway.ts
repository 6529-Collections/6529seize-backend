/**
 * The chain gateway read the claim builder needs, as a small typed port until
 * the shared gateway client lands. The name follows that client's call, so
 * binding it is a one-line change.
 */

export interface MintChainResultWinner {
  readonly rank: number;
  readonly entry_id: string;
  readonly manifest_hash: string;
}

export interface MintChainDecisionResult {
  readonly decision_id: string;
  readonly occurrence: number;
  /** Only a FINAL result picks a card. */
  readonly state: 'FINAL' | 'PENDING';
  /** The finalized height the result was read at. */
  readonly height: number;
  readonly winners: readonly MintChainResultWinner[];
}

export interface MintGatewayPort {
  /** A decision's result for one occurrence, or null when there is none. */
  decisionResult(
    decisionId: string,
    occurrence: number
  ): Promise<MintChainDecisionResult | null>;
}

let gateway: MintGatewayPort | null = null;

export function getMintGateway(): MintGatewayPort | null {
  return gateway;
}

export function setMintGateway(next: MintGatewayPort | null): void {
  gateway = next;
}

/**
 * The principal a wallet was bound to at a finalized height (the shared
 * gateway client's call). The signed-record verifier needs it.
 */
export interface MintPrincipalBindings {
  principalAt(wallet: string, height: number): Promise<string | null>;
}

let principalBindings: MintPrincipalBindings | null = null;

export function getMintPrincipalBindings(): MintPrincipalBindings | null {
  return principalBindings;
}

export function setMintPrincipalBindings(
  next: MintPrincipalBindings | null
): void {
  principalBindings = next;
}

import {
  DelegationRow,
  ResolvedAirdropTarget,
  resolveAirdropTarget
} from '../engine/airdrop-address';
import { AirdropTarget } from '../engine/final-list';

/**
 * Run 2's inputs from the chain side: the Delegation records, each wallet's
 * boosted TDH for the day, and each identity's wallets. Until the gateway
 * serves the delegation query, this comes from a file.
 */
export interface ChainInputs {
  readonly version: 1;
  /** Where the records came from, for example a gateway height. */
  readonly source: string;
  /** The build time in Unix seconds, for delegation expiry. */
  readonly nowSeconds: number;
  readonly delegations: DelegationRow[];
  readonly boostedTdhByWallet: Record<string, number>;
  /** Legacy consolidation key to identity key, where they differ. */
  readonly keyMap?: Record<string, string>;
  /**
   * Each identity's wallets, by identity key. Required for an identity key
   * that is not a hyphen-joined wallet list (a principal id).
   */
  readonly identities?: Record<string, string[]>;
}

const PRINCIPAL_ID = /^0x[0-9a-f]{64}$/;

export class KeyMapper {
  private readonly map: Map<string, string>;

  constructor(map: Record<string, string> = {}) {
    this.map = new Map(
      Object.entries(map).map(([from, to]) => [
        from.toLowerCase(),
        to.toLowerCase()
      ])
    );
  }

  toIdentity(key: string): string {
    const k = key.toLowerCase();
    return this.map.get(k) ?? k;
  }
}

/**
 * The wallets of an identity key: the given list, else the hyphen-joined
 * wallets of a legacy key. A principal id with no list has none.
 */
export function identityWallets(
  identity: string,
  identities: Record<string, string[]> | undefined
): string[] | null {
  const given = identities?.[identity];
  if (given) {
    return given.map((w) => w.toLowerCase());
  }
  if (PRINCIPAL_ID.test(identity)) {
    return null;
  }
  return identity.split('-');
}

export interface Run2Resolver {
  readonly resolve: (legacyKey: string) => AirdropTarget;
  readonly ties: Map<string, ResolvedAirdropTarget['ties']>;
  /** Identities with no wallet list (their airdrop address is null). */
  readonly missingWallets: Set<string>;
}

/** Runs the ported airdrop rule on the chain inputs, per identity. */
export function run2Resolver(
  chain: ChainInputs,
  mapper: KeyMapper
): Run2Resolver {
  const tdh = new Map(
    Object.entries(chain.boostedTdhByWallet).map(([w, v]) => [
      w.toLowerCase(),
      v
    ])
  );
  const ties = new Map<string, ResolvedAirdropTarget['ties']>();
  const missingWallets = new Set<string>();
  const resolve = (legacyKey: string): AirdropTarget => {
    const identity = mapper.toIdentity(legacyKey);
    const wallets = identityWallets(identity, chain.identities);
    if (!wallets) {
      missingWallets.add(identity);
      return { airdropAddress: null, tdhWallet: null };
    }
    const resolved = resolveAirdropTarget({
      key: identity,
      wallets,
      delegations: chain.delegations,
      boostedTdhByWallet: tdh,
      nowSeconds: chain.nowSeconds
    });
    if (resolved.ties.length) {
      ties.set(identity, resolved.ties);
    }
    return resolved;
  };
  return { resolve, ties, missingWallets };
}

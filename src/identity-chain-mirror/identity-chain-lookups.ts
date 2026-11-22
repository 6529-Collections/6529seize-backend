import {
  ChainGatewayClient,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb
} from './identity-chain-mirror.db';

type Gateway = Pick<
  ChainGatewayClient,
  'getIdentityByLegacyProfileId' | 'getMembershipWalletHistory'
>;

/**
 * Lookups other 6529.io code makes against the identity mirror's tables,
 * with the chain gateway as the fallback where the mirror can't answer.
 */
export class IdentityChainLookups {
  constructor(
    private readonly db: IdentityChainMirrorDb = identityChainMirrorDb,
    private readonly gateway: Gateway = chainGatewayClient
  ) {}

  /**
   * The chain principal of a 6529.io profile: the mirror's mapping, else
   * the identity the import created from that profile id; null when the
   * chain has none.
   */
  async principalIdOfProfile(profileId: string): Promise<string | null> {
    const id = profileId.toLowerCase();
    const mapped = await this.db.principalOfProfile(id);
    if (mapped) return mapped.toLowerCase();
    const imported = await this.gateway.getIdentityByLegacyProfileId(id);
    return imported?.principalId.toLowerCase() ?? null;
  }

  /**
   * The principal wallet `wallet` was bound to at chain height `height`,
   * or null when it was bound to none. From the mirror's bindings when the
   * mirror has followed the chain past `height` and the wallet has been
   * bound to the same principal since at or before it; else from the
   * wallet's binding history on the chain.
   */
  async walletPrincipalAt(
    wallet: string,
    height: number
  ): Promise<string | null> {
    const address = wallet.toLowerCase();
    const [state, bindings] = await Promise.all([
      this.db.getState(),
      this.db.walletBindings([address])
    ]);
    const mirrored =
      state?.next_height === null || state?.next_height === undefined
        ? null
        : Number(state.next_height) - 1;
    const row = bindings.get(address);
    if (
      row &&
      mirrored !== null &&
      height <= mirrored &&
      height >= Number(row.bound_from_height)
    ) {
      return row.principal_id.toLowerCase();
    }
    const history = await this.gateway.getMembershipWalletHistory(address);
    let principal: string | null = null;
    for (const change of history?.changes ?? []) {
      if (Number(change.height) > height) break;
      principal = change.principalId?.toLowerCase() ?? null;
    }
    return principal;
  }
}

export const identityChainLookups = new IdentityChainLookups();

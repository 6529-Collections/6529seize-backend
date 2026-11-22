import {
  ChainGatewayClient,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import { ChainWalletHistory } from '@/chain-gateway/chain-gateway.types';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb
} from './identity-chain-mirror.db';

type Gateway = Pick<
  ChainGatewayClient,
  | 'getIdentityByLegacyProfileId'
  | 'getMembershipWalletHistory'
  | 'getHead'
  | 'getMembership'
>;

/**
 * Neither the mirror nor the chain's history can say which principal a
 * wallet was bound to at that height (not finalized yet, or in a gap of the
 * gateway's feed). A caller must treat it as unknown: not as "bound to none".
 */
export class WalletPrincipalUnknownError extends Error {
  constructor(
    readonly wallet: string,
    readonly height: number
  ) {
    super(`The principal of ${wallet} at height ${height} is not known`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WalletPrincipalUnknownError';
  }
}

/**
 * From a wallet's history: its principal at `height` (null: bound to none),
 * or undefined when the history can't say. It can say when the height is
 * within a range the feed holds and the wallet's last change at or below it
 * is in that range too, or when that range starts at or before the
 * import's start (`importStart`), or at the chain's first block: no wallet
 * is bound before the import starts (the chain's genesis binds none;
 * identities come from the import and from operations), so no earlier
 * change is missed.
 */
export function principalInHistory(
  history: ChainWalletHistory,
  height: number,
  importStart: number | null = null
): string | null | undefined {
  if (height > history.readHeight) return undefined;
  const range = history.ranges.find(
    ([from, to]) => from <= height && height <= to
  );
  if (!range) return undefined;
  let last: ChainWalletHistory['changes'][number] | null = null;
  for (const change of history.changes) {
    if (change.height > height) break;
    last = change;
  }
  if (last && last.height >= range[0]) return last.principalId;
  const nothingBefore = Math.max(1, importStart ?? 1);
  return range[0] <= nothingBefore ? (last?.principalId ?? null) : undefined;
}

/**
 * Lookups other 6529.io code makes against the identity mirror's tables,
 * with the chain gateway as the fallback where the mirror can't answer.
 */
export class IdentityChainLookups {
  /** The import's first height, once the gateway has given it. */
  private importStart: number | null = null;

  constructor(
    private readonly db: IdentityChainMirrorDb = identityChainMirrorDb,
    private readonly gateway: Gateway = chainGatewayClient
  ) {}

  private async importStartHeight(): Promise<number | null> {
    if (this.importStart === null) {
      const membership = await this.gateway.getMembership();
      const start = (membership?.import as { startHeight?: unknown })
        ?.startHeight;
      const height = Number(start);
      this.importStart =
        start !== null && start !== undefined && Number.isSafeInteger(height)
          ? height
          : null;
    }
    return this.importStart;
  }

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
   * The principal `wallet` was bound to at chain height `height`, or null
   * when it was bound to none. From the mirror's bindings when they were
   * read from the chain the gateway serves now, have followed it to
   * `height`, and the wallet has been bound to the same principal since at
   * or before it; else from the wallet's history on the chain. Throws
   * WalletPrincipalUnknownError when neither can say.
   */
  async walletPrincipalAt(
    wallet: string,
    height: number
  ): Promise<string | null> {
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error(`Not a chain height: ${height}`);
    }
    const address = wallet.toLowerCase();
    const { binding, nextHeight, chainId } =
      await this.db.walletBindingAt(address);
    const network = (await this.gateway.getHead()).network?.toLowerCase();
    if (
      binding &&
      nextHeight !== null &&
      (!network || chainId === network) &&
      height < nextHeight &&
      height >= binding.bound_from_height
    ) {
      return binding.principal_id.toLowerCase();
    }
    const history = await this.gateway.getMembershipWalletHistory(address);
    const principal = history
      ? principalInHistory(history, height, await this.importStartHeight())
      : undefined;
    if (principal === undefined) {
      throw new WalletPrincipalUnknownError(address, height);
    }
    return principal;
  }
}

export const identityChainLookups = new IdentityChainLookups();

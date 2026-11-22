import {
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import {
  messageOf,
  readWholeBlocks,
  realSleep,
  Sleep
} from './chain-feed-pages';
import { IdentityChainMirrorDb, MirrorState } from './identity-chain-mirror.db';
import {
  ADDRESS_BINDING_FAMILY,
  BindingPage,
  bindingChangesOf,
  foldBindings,
  WalletBindingRow
} from './wallet-bindings';

const logger = Logger.get('IDENTITY_CHAIN_BINDINGS');

const PAGE_BLOCKS = 200;

type Gateway = Pick<
  ChainGatewayClient,
  'getChanges' | 'getHead' | 'listMembershipWallets'
>;

type Db = Pick<
  IdentityChainMirrorDb,
  | 'executeNativeQueriesInTransaction'
  | 'walletBindings'
  | 'writeWalletBindings'
  | 'clearWalletBindings'
  | 'boundWallets'
  | 'saveState'
  | 'getState'
>;

export interface BindingsReport {
  walletBindings: number;
  bindingProblems: string[];
}

/**
 * Keeps identity_chain_wallets: each bound wallet's principal and the
 * height it has been bound to it since without a break, from the feed's
 * AddressBinding records, with its own cursor (bindings_next_height) from
 * the import's first block. Rows and cursor are written in one transaction,
 * so the table is never behind the height it claims; rows ahead of it only
 * send a lookup to the chain. When the gateway no longer holds the cursor's
 * height, the import's start is unknown, or a record's wallet can't be
 * read, the bindings are rebuilt from one membership list. A failure is
 * reported and the caller goes on.
 */
export class WalletBindingsFollower {
  constructor(
    private readonly gateway: Gateway,
    private readonly db: Db,
    private readonly now: () => number,
    private readonly sleep: Sleep = realSleep
  ) {}

  async follow(
    initial: MirrorState,
    importStart: number | null,
    deadline: number,
    report: BindingsReport
  ): Promise<MirrorState> {
    try {
      if (initial.bindings_next_height !== null) {
        return await this.read(initial, deadline, report);
      }
      if (importStart === null) {
        return await this.rebuild(initial, report);
      }
      // Lookups trust no row without a cursor: start from an empty table.
      const start = { ...initial, bindings_next_height: importStart };
      await this.db.executeNativeQueriesInTransaction(async (conn) => {
        await this.db.clearWalletBindings(conn);
        await this.db.saveState(start, this.now(), conn);
      });
      return await this.read(start, deadline, report);
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[WALLET BINDINGS FAILED] ${message}`);
      report.bindingProblems.push(message);
      return (await this.db.getState()) ?? initial;
    }
  }

  /** Pages of the feed's binding records from the cursor, to the deadline. */
  private async read(
    initial: MirrorState,
    deadline: number,
    report: BindingsReport
  ): Promise<MirrorState> {
    let state = initial;
    while (this.now() < deadline) {
      const from = Number(state.bindings_next_height);
      const page = await readWholeBlocks(this.gateway, from, {
        limit: PAGE_BLOCKS,
        families: [ADDRESS_BINDING_FAMILY],
        sleep: this.sleep
      });
      if (!page) {
        logger.warn(`[FEED GONE AT ${from}] [LISTING THE MEMBERSHIP]`);
        return await this.rebuild(state, report);
      }
      if (page.atHead || page.nextHeight <= from) break;
      if (state.chain_id && page.network && page.network !== state.chain_id) {
        logger.warn(
          `[FEED PAGE OF ANOTHER CHAIN] [${page.network}] [NEXT RUN]`
        );
        break;
      }
      const read = bindingChangesOf(page.blocks);
      if (read.stoppedAt !== null) {
        this.reportMalformed(read, report);
        logger.warn(
          `[UNREADABLE WALLET AT ${read.stoppedAt}] [LISTING THE MEMBERSHIP]`
        );
        return await this.rebuild(state, report);
      }
      state = await this.apply(
        read,
        { ...state, bindings_next_height: page.nextHeight },
        report
      );
    }
    return state;
  }

  private reportMalformed(page: BindingPage, report: BindingsReport) {
    if (!page.malformed.length) return;
    logger.error(`[UNREADABLE ADDRESS BINDINGS] ${page.malformed.join(', ')}`);
    report.bindingProblems.push(...page.malformed);
  }

  /** A page's changes and the cursor past it, in one transaction. */
  private async apply(
    page: BindingPage,
    next: MirrorState,
    report: BindingsReport
  ): Promise<MirrorState> {
    this.reportMalformed(page, report);
    const wallets = Array.from(new Set(page.changes.map((it) => it.wallet)));
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      if (wallets.length) {
        const stored = await this.db.walletBindings(wallets, conn);
        const { upserts, deletes } = foldBindings(stored, page.changes);
        await this.db.writeWalletBindings(upserts, deletes, this.now(), conn);
      }
      await this.db.saveState(next, this.now(), conn);
    });
    report.walletBindings += page.changes.length;
    return next;
  }

  /**
   * Without the feed for some heights, nothing says when a wallet was bound
   * (it may have left and come back in the gap), so every bound wallet, as
   * one membership list pinned at the finalized height shows it, is stored
   * as bound since that height: later than the truth, never earlier. For an
   * earlier height a lookup asks the chain's history. Unlisted rows go, and
   * the bindings follow the feed from the next height. A list the gateway
   * can't give at one height is tried again next run.
   */
  private async rebuild(
    state: MirrorState,
    report: BindingsReport
  ): Promise<MirrorState> {
    const height = (await this.gateway.getHead(true)).finalizedHeight;
    const bound = await this.membershipAt(height);
    if (!bound) {
      logger.warn(`[NO MEMBERSHIP LIST AT ${height}] [NEXT RUN]`);
      return state;
    }
    const upserts: WalletBindingRow[] = Array.from(bound.entries()).map(
      ([wallet, principal]) => ({
        wallet,
        principal_id: principal,
        bound_from_height: height
      })
    );
    const next = { ...state, bindings_next_height: height + 1 };
    const removed = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        const deletes = (await this.db.boundWallets(conn)).filter(
          (it) => !bound.has(it)
        );
        await this.db.writeWalletBindings(upserts, deletes, this.now(), conn);
        await this.db.saveState(next, this.now(), conn);
        return deletes.length;
      }
    );
    logger.info(
      `[REBUILT AT ${height}] [${upserts.length} BOUND] [${removed} REMOVED]`
    );
    report.walletBindings += upserts.length + removed;
    return next;
  }

  /** Every bound wallet at `height`, or null when not all of it reads there. */
  private async membershipAt(
    height: number
  ): Promise<Map<string, string> | null> {
    const bound = new Map<string, string>();
    let after: string | null = null;
    try {
      for (;;) {
        const page = await this.gateway.listMembershipWallets({
          after,
          limit: 5000,
          height
        });
        if (!page || Number(page.read?.height) !== height) return null;
        for (const item of page.items) {
          if (item.principalId) {
            bound.set(
              item.wallet.toLowerCase(),
              item.principalId.toLowerCase()
            );
          }
        }
        if (!page.next) return bound;
        after = page.next;
      }
    } catch (error) {
      if (error instanceof ChainGatewayError && error.code === 'height_gone') {
        return null;
      }
      throw error;
    }
  }
}

import {
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainRatingTotal
} from '@/chain-gateway/chain-gateway.types';
import { isHelpBotCreditCategory } from '@/help-bot/help-bot.config';
import { Logger } from '@/logging';
import {
  isOtherChain,
  readWholeBlocks,
  realSleep,
  Sleep
} from './chain-feed-pages';
import {
  IdentityChainMirrorDb,
  MirrorState,
  RatingEventRow,
  RatingLedgerKey
} from './identity-chain-mirror.db';
import { messageOf } from './mirror-errors';
import {
  categoryKey,
  ChainRatingChange,
  ledgerKeyOf,
  RATING_EVENT_FAMILIES,
  ratingChangesOf,
  ratingEventOrigin,
  totalIn,
  totalKeyOf,
  writerText
} from './rating-events';

const logger = Logger.get('IDENTITY_CHAIN_RATING_EVENTS');

const PAGE_BLOCKS = 200;

type Gateway = Pick<
  ChainGatewayClient,
  'getChanges' | 'getState' | 'getStatus' | 'getRatingTotals'
>;

type Db = Pick<
  IdentityChainMirrorDb,
  | 'executeNativeQueriesInTransaction'
  | 'saveState'
  | 'profileIdsOfPrincipals'
  | 'ratingLedgerOf'
  | 'ratingLedgerTotalsOf'
  | 'writeRatingLedger'
  | 'insertRatingEvents'
>;

export interface RatingEventsReport {
  /** Rating event rows written (a page read again may count again). */
  ratingEvents: number;
  /** Rating records that couldn't be read (`height:key`), left out. */
  ratingEventProblems: string[];
  /** Rating records after the import that carry no writer (an old gateway). */
  ratingRecordsWithoutWriter: number;
  /** Where the follower stopped: the next feed height it reads. */
  eventsNextHeight: number | null;
}

/**
 * The rating events (identity_chain_rating_events) and their ledger
 * (identity_chain_rating_ledger), from the feed's rating families, with
 * their own cursor (events_next_height) from the import's start: whole
 * blocks, of the mirror's chain, each page's rows, ledger and cursor in one
 * transaction. Each Rating record of an identity gives a row: its old value
 * from the ledger (0 when absent), the new one, the total after from the
 * block's RatingTotal record (else the ledger's while it is exact, else the
 * chain's totals read at the block's height), the origin from its writer. Nothing comes from 6529.io's ratings, so the identity sync, which
 * writes those at newer heights, can't change an event.
 */
export class RatingEventsFollower {
  /** REP category names by id (a category's name never changes). */
  private readonly categoryNames = new Map<string, string>();

  constructor(
    private readonly gateway: Gateway,
    private readonly db: Db,
    private readonly now: () => number,
    private readonly sleep: Sleep = realSleep
  ) {}

  async follow(
    initial: MirrorState,
    importStart: number | null,
    importDone: number | null,
    deadline: number,
    report: RatingEventsReport
  ): Promise<MirrorState> {
    let state = initial;
    if (state.events_next_height === null) {
      if (importStart === null) {
        logger.warn('[NO IMPORT START] [RATING EVENTS WAIT]');
        return state;
      }
      // From the import's start: the ledger sees every rating.
      state = { ...state, events_next_height: importStart, events_exact: true };
    }
    let unwrittenLogged = false;
    while (this.now() < deadline) {
      const from = Number(state.events_next_height);
      const page = await readWholeBlocks(this.gateway, from, {
        limit: PAGE_BLOCKS,
        families: RATING_EVENT_FAMILIES,
        sleep: this.sleep
      });
      if (!page) {
        return await this.afterGone(state, from);
      }
      if (page.atHead || page.nextHeight <= from) break;
      if (isOtherChain(state.chain_id, page.network)) {
        logger.warn(
          `[FEED PAGE OF ANOTHER CHAIN] [${page.network}] [NEXT RUN]`
        );
        break;
      }
      const written = await this.writePage(
        page.blocks,
        { ...state, events_next_height: page.nextHeight },
        importDone,
        report
      );
      state = written.state;
      if (written.withoutWriter && !unwrittenLogged) {
        unwrittenLogged = true;
        logger.error(
          `[RATING RECORDS WITHOUT A WRITER AFTER THE IMPORT] [${written.withoutWriter}] [THEIR ORIGIN IS UNKNOWN: NO NOTIFICATION]`
        );
      }
    }
    report.eventsNextHeight = state.events_next_height;
    return state;
  }

  /**
   * The feed no longer holds `from`: the follower goes on from the next
   * height it holds, and the ledger (kept) is no longer exact.
   */
  private async afterGone(state: MirrorState, from: number) {
    const next = await this.nextHeld(from);
    if (next === null) {
      logger.error(
        `[RATING EVENTS: FEED GONE AT ${from}] [NO HEIGHT HELD AFTER IT]`
      );
      return state;
    }
    logger.error(
      `[RATING EVENTS: FEED GONE AT ${from}] [NO ROWS FOR HEIGHTS ${from} TO ${next - 1}] [GOING ON FROM ${next}]`
    );
    const after = { ...state, events_next_height: next, events_exact: false };
    await this.db.saveState(after, this.now());
    return after;
  }

  /** The first height at or after `from` the gateway's feed holds. */
  private async nextHeld(from: number): Promise<number | null> {
    const status = await this.gateway.getStatus();
    const ranges = Array.isArray(status?.feed) ? status.feed : [];
    const starts = ranges
      .map((it) => (Array.isArray(it) ? [Number(it[0]), Number(it[1])] : []))
      .filter(
        (it) =>
          it.length === 2 &&
          Number.isSafeInteger(it[0]) &&
          Number.isSafeInteger(it[1]) &&
          it[1] >= from
      )
      .map(([start]) => Math.max(start, from))
      .sort((a, b) => a - b);
    return starts.length ? starts[0] : null;
  }

  /** One page's rows, ledger and cursor, in one transaction. */
  private async writePage(
    blocks: readonly ChainFeedBlock[],
    after: MirrorState,
    importDone: number | null,
    report: RatingEventsReport
  ): Promise<{ state: MirrorState; withoutWriter: number }> {
    let next = after;
    const { changes, categoryNames, totals, unreadable } =
      ratingChangesOf(blocks);
    categoryNames.forEach((name, id) => this.categoryNames.set(id, name));
    if (unreadable.length) {
      logger.error(`[RATING RECORDS NOT READ] ${unreadable.join(', ')}`);
      report.ratingEventProblems.push(...unreadable);
      // The ledger missed them: its totals are no longer taken as exact.
      next = { ...next, events_exact: false };
    }
    await this.loadCategoryNames(changes);
    const keys: RatingLedgerKey[] = changes;
    const ledger = await this.db.ratingLedgerOf(keys);
    const totalsBefore = await this.db.ratingLedgerTotalsOf(changes);
    const mapped = await this.db.profileIdsOfPrincipals(
      changes.flatMap((it) => [it.rater, it.target])
    );
    const values = new Map<string, number>();
    const running = new Map<string, number>();
    const set = new Map<
      string,
      RatingLedgerKey & { value: number; height: number }
    >();
    const removed = new Map<string, RatingLedgerKey>();
    const totalsAt = new Map<string, readonly ChainRatingTotal[] | null>();
    const rows: RatingEventRow[] = [];
    let withoutWriter = 0;
    for (const change of changes) {
      const key = ledgerKeyOf(change);
      const totalKey = totalKeyOf(change);
      const old = values.get(key) ?? ledger.get(key)?.value ?? 0;
      values.set(key, change.value);
      if (change.value === 0) {
        set.delete(key);
        removed.set(key, change);
      } else {
        removed.delete(key);
        set.set(key, { ...change, value: change.value, height: change.height });
      }
      // The block's own total, else the ledger's: exact when it followed
      // the feed from the import's start, else the chain's at the height.
      const derived =
        (running.get(totalKey) ?? totalsBefore.get(totalKey) ?? 0) +
        change.value -
        old;
      let total = totals.get(change.height)?.get(totalKey) ?? derived;
      if (
        !totals.get(change.height)?.has(totalKey) &&
        !next.events_exact &&
        old !== change.value
      ) {
        const fromChain = await this.totalAt(change, totalsAt);
        if (fromChain === null) {
          report.ratingEventProblems.push(
            `${change.height}: a total from a ledger with a gap`
          );
        }
        total = fromChain ?? derived;
      }
      running.set(totalKey, total);
      const afterImport = importDone === null || change.height > importDone;
      if (afterImport && !change.writer && change.byImport !== true) {
        withoutWriter++;
      }
      // The import's own heights are the import's, whatever the writer.
      const origin = afterImport
        ? ratingEventOrigin(change.writer, change.byImport)
        : 'IMPORT';
      if (old === change.value) continue;
      const name = this.nameOf(change);
      if (name === null) {
        report.ratingEventProblems.push(
          `${change.height}: no name for the category ${change.categoryId}`
        );
        continue;
      }
      if (change.matter === 'REP' && isHelpBotCreditCategory(name)) continue;
      rows.push({
        height: change.height,
        block_time_ms: change.blockTimeMs,
        rater_principal: change.rater,
        rater_profile_id: mapped.get(change.rater) ?? null,
        target_principal: change.target,
        target_profile_id: mapped.get(change.target) ?? null,
        matter: change.matter,
        matter_category: name,
        old_rating: old,
        new_rating: change.value,
        total_after: total,
        origin,
        by_import: change.byImport === true,
        writer: writerText(change.writer)
      });
    }
    report.ratingRecordsWithoutWriter += withoutWriter;
    const written = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        await this.db.writeRatingLedger(
          Array.from(set.values()),
          Array.from(removed.values()),
          conn
        );
        const count = await this.db.insertRatingEvents(rows, this.now(), conn);
        await this.db.saveState(next, this.now(), conn);
        return count;
      }
    );
    report.ratingEvents += written;
    return { state: next, withoutWriter };
  }

  /**
   * The change's total from the chain's totals of its target read at the
   * block's height (one read a target and height a page); null when the
   * gateway no longer holds that height or the total can't be read. Any
   * other error ends the run before the page is written: the block waits.
   */
  private async totalAt(
    change: ChainRatingChange,
    read: Map<string, readonly ChainRatingTotal[] | null>
  ): Promise<number | null> {
    const key = `${change.height}:${change.target}`;
    if (!read.has(key)) {
      try {
        const answer = await this.gateway.getRatingTotals(change.target, {
          height: change.height
        });
        read.set(key, Array.isArray(answer) ? answer : null);
      } catch (error) {
        if (
          !(error instanceof ChainGatewayError) ||
          error.code !== 'height_gone'
        ) {
          throw error;
        }
        logger.warn(
          `[RATING TOTALS AT ${change.height} GONE] [A TOTAL FROM THE LEDGER]`
        );
        read.set(key, null);
      }
    }
    const totals = read.get(key);
    return totals ? totalIn(totals, change) : null;
  }

  /** The REP category's name ('' for NIC); null when it can't be had. */
  private nameOf(change: ChainRatingChange): string | null {
    if (change.categoryId === null) return '';
    return this.categoryNames.get(change.categoryId) ?? null;
  }

  /** Names of the page's categories not known yet, from the chain. */
  private async loadCategoryNames(changes: readonly ChainRatingChange[]) {
    const missing = new Set(
      changes
        .map((it) => it.categoryId)
        .filter((it): it is string => !!it && !this.categoryNames.has(it))
    );
    for (const id of Array.from(missing)) {
      try {
        const record = await this.gateway.getState<{
          valueFields?: { name?: unknown } | null;
        }>(categoryKey(id));
        const name = record?.valueFields?.name;
        if (typeof name === 'string') this.categoryNames.set(id, name);
      } catch (error) {
        logger.warn(`[CATEGORY ${id} NOT READ] ${messageOf(error)}`);
      }
    }
  }
}

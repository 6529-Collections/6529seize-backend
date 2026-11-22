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
  RatingEventRow,
  RatingEventsCursor,
  RatingLedgerKey,
  RatingLedgerRow
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
  | 'getState'
  | 'saveRatingEventsCursor'
  | 'clearRatingEvents'
  | 'profileIdsOfPrincipals'
  | 'ratingLedgerOf'
  | 'ratingLedgerTotalsOf'
  | 'writeRatingLedger'
  | 'insertRatingEvents'
  | 'ratingCategoryNamesOf'
  | 'writeRatingCategories'
>;

export interface RatingEventsReport {
  /** Rating event rows written (a page read again may count again). */
  ratingEvents: number;
  /**
   * Rating records that couldn't be read (`height:key`), rows written with
   * a value before or a total that may be off, and what stopped the
   * follower for the run.
   */
  ratingEventProblems: string[];
  /** Rating records after the import that carry no writer (an old gateway). */
  ratingRecordsWithoutWriter: number;
  /** Where the follower stopped: the next feed height it reads. */
  eventsNextHeight: number | null;
}

function isHeightGone(error: unknown): boolean {
  return error instanceof ChainGatewayError && error.code === 'height_gone';
}

/**
 * The rating events (identity_chain_rating_events) and their ledger
 * (identity_chain_rating_ledger), from the feed's rating families with
 * their own place in the state (events_next_height, events_resume_height),
 * from the import's start: whole blocks of the mirror's chain, up to the
 * identity sync's place (so raters and targets are mapped first), each
 * page's rows, ledger, category names and place in one transaction.
 *
 * Each Rating record of an identity gives a row: the value before, the new
 * one, the total after, the origin from its writer. The value before is
 * the ledger's while its row can be trusted, else (a key the follower
 * couldn't read, or one a gap in the feed may have changed) the chain's at
 * the height before; when the gateway no longer holds that height the row
 * is written with origin UNKNOWN. The total is the block's RatingTotal
 * record, else the ledger's while it is exact, else the chain's totals at
 * the height. Nothing comes from 6529.io's ratings, which the identity sync
 * writes at newer heights. A read that fails otherwise ends the follower's
 * run before the page is written (reported, not thrown): the page waits.
 */
export class RatingEventsFollower {
  /** REP category names by id (a category's name never changes). */
  private readonly categoryNames = new Map<string, string>();
  /** The ids whose names are in identity_chain_rating_categories. */
  private readonly storedCategories = new Set<string>();
  /** The chain the names above are of. */
  private namesChain: string | null = null;

  constructor(
    private readonly gateway: Gateway,
    private readonly db: Db,
    private readonly now: () => number,
    private readonly sleep: Sleep = realSleep
  ) {}

  /** One run of the follower, to the deadline; failures are reported. */
  async follow(
    importStart: number | null,
    importDone: number | null,
    deadline: number,
    report: RatingEventsReport
  ): Promise<void> {
    let withoutWriter = 0;
    try {
      await this.read(importStart, importDone, deadline, report, (count) => {
        withoutWriter += count;
      });
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[RATING EVENTS WAIT FOR THE NEXT RUN] ${message}`);
      report.ratingEventProblems.push(message);
    } finally {
      report.ratingRecordsWithoutWriter += withoutWriter;
      if (withoutWriter) {
        logger.error(
          `[RATING RECORDS WITHOUT A WRITER AFTER THE IMPORT] [${withoutWriter}] [THEIR ORIGIN IS UNKNOWN: NO NOTIFICATION]`
        );
      }
    }
  }

  private async read(
    importStart: number | null,
    importDone: number | null,
    deadline: number,
    report: RatingEventsReport,
    countWithoutWriter: (count: number) => void
  ) {
    // The state as stored: an identity step that threw leaves the run's
    // copy behind it.
    const state = await this.db.getState();
    if (!state) {
      logger.warn('[NO MIRROR STATE YET] [RATING EVENTS WAIT]');
      return;
    }
    if (this.namesChain !== state.chain_id) {
      this.forgetNames(state.chain_id);
    }
    report.eventsNextHeight = state.events_next_height;
    let cursor: RatingEventsCursor;
    if (state.events_next_height === null) {
      if (importStart === null) {
        logger.error('[NO IMPORT START] [RATING EVENTS WAIT]');
        return;
      }
      // From the import's start, with nothing left of an earlier start.
      cursor = { next: importStart, resume: null };
      const first = cursor;
      await this.db.executeNativeQueriesInTransaction(async (conn) => {
        await this.db.clearRatingEvents(conn);
        await this.db.saveRatingEventsCursor(first, this.now(), conn);
      });
      this.forgetNames(state.chain_id);
      report.eventsNextHeight = cursor.next;
    } else {
      cursor = {
        next: Number(state.events_next_height),
        resume:
          state.events_resume_height === null
            ? null
            : Number(state.events_resume_height)
      };
    }
    // The identity sync's place: rows wait for it, so their raters and
    // targets are mapped when they are written.
    const until = state.next_height === null ? null : Number(state.next_height);
    while (this.now() < deadline) {
      const from = cursor.next;
      if (until !== null && from >= until) break;
      const page = await readWholeBlocks(this.gateway, from, {
        limit: PAGE_BLOCKS,
        families: RATING_EVENT_FAMILIES,
        sleep: this.sleep
      });
      if (!page) {
        cursor = await this.afterGone(cursor, report);
        break;
      }
      if (page.atHead || page.nextHeight <= from) break;
      if (isOtherChain(state.chain_id, page.network)) {
        logger.warn(
          `[FEED PAGE OF ANOTHER CHAIN] [${page.network}] [NEXT RUN]`
        );
        break;
      }
      const next =
        until === null ? page.nextHeight : Math.min(page.nextHeight, until);
      const blocks = page.blocks.filter((it) => Number(it.height) < next);
      const written = await this.writePage(
        blocks,
        cursor,
        { ...cursor, next },
        importDone,
        report
      );
      cursor = written.cursor;
      countWithoutWriter(written.withoutWriter);
      report.eventsNextHeight = cursor.next;
    }
  }

  private forgetNames(chainId: string | null) {
    this.categoryNames.clear();
    this.storedCategories.clear();
    this.namesChain = chainId;
  }

  /**
   * The feed no longer holds the cursor's height: the follower goes on from
   * the next height it holds, and the ledger (kept) may be stale for any
   * key the gap changed.
   */
  private async afterGone(
    cursor: RatingEventsCursor,
    report: RatingEventsReport
  ): Promise<RatingEventsCursor> {
    const from = cursor.next;
    const next = await this.nextHeld(from);
    if (next === null || next <= from) {
      const held = next === null ? 'NO HEIGHT HELD AFTER IT' : 'STILL HELD';
      logger.error(
        `[RATING EVENTS: FEED GONE AT ${from}] [${held}] [NEXT RUN]`
      );
      return cursor;
    }
    logger.error(
      `[RATING EVENTS: FEED GONE AT ${from}] [NO ROWS FOR HEIGHTS ${from} TO ${next - 1}] [GOING ON FROM ${next}]`
    );
    const after = { next, resume: next };
    await this.db.saveRatingEventsCursor(after, this.now());
    report.eventsNextHeight = next;
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

  /** One page's rows, ledger, names and place, in one transaction. */
  private async writePage(
    blocks: readonly ChainFeedBlock[],
    cursor: RatingEventsCursor,
    after: RatingEventsCursor,
    importDone: number | null,
    report: RatingEventsReport
  ): Promise<{ cursor: RatingEventsCursor; withoutWriter: number }> {
    const { changes, categoryNames, totals, unreadable } =
      ratingChangesOf(blocks);
    categoryNames.forEach((name, id) => this.categoryNames.set(id, name));
    if (unreadable.length) {
      logger.error(`[RATING RECORDS NOT READ] ${unreadable.join(', ')}`);
      report.ratingEventProblems.push(...unreadable);
    }
    await this.loadCategoryNames(changes);
    const ledger = await this.db.ratingLedgerOf(changes);
    const totalsBefore = await this.db.ratingLedgerTotalsOf(changes);
    const mapped = await this.db.profileIdsOfPrincipals(
      changes.flatMap((it) => [it.rater, it.target])
    );
    // The page's own values and totals as it goes: exact (null when not)
    // and the best guess.
    const values = new Map<string, number>();
    const running = new Map<string, number | null>();
    const rough = new Map<string, number>();
    const set = new Map<string, RatingLedgerKey & RatingLedgerRow>();
    const removed = new Map<string, RatingLedgerKey>();
    const totalsAt = new Map<string, readonly ChainRatingTotal[] | null>();
    const rows: RatingEventRow[] = [];
    let withoutWriter = 0;
    for (const change of changes) {
      const key = ledgerKeyOf(change);
      const totalKey = totalKeyOf(change);
      const row = ledger.get(key);
      if (change.value === null) {
        // A value it can't read: the key's next change reads the value
        // before from the chain, and the target's total isn't exact.
        const prior = values.get(key) ?? row?.value ?? 0;
        values.delete(key);
        removed.delete(key);
        set.set(key, {
          ...change,
          value: prior,
          height: change.height,
          stale: true
        });
        running.set(totalKey, null);
        continue;
      }
      const ledgerOld = set.get(key)?.value ?? row?.value ?? 0;
      let old: number | null;
      if (values.has(key)) {
        old = values.get(key)!;
      } else if (set.get(key)?.stale || this.isStale(row, cursor.resume)) {
        old = await this.valueBefore(change);
      } else {
        old = row?.value ?? 0;
      }
      const known = old !== null;
      const before = old ?? ledgerOld;
      values.set(key, change.value);
      if (change.value === 0) {
        set.delete(key);
        removed.set(key, change);
      } else {
        removed.delete(key);
        set.set(key, {
          ...change,
          value: change.value,
          height: change.height,
          stale: false
        });
      }
      const changed = !known || before !== change.value;
      // The block's own total, else the ledger's while it is exact, else
      // the chain's at the height.
      const base = running.has(totalKey)
        ? (running.get(totalKey) ?? null)
        : this.ledgerTotal(totalsBefore.get(totalKey), cursor.resume);
      const roughBase =
        rough.get(totalKey) ?? totalsBefore.get(totalKey)?.total ?? 0;
      let total: number | null =
        totals.get(change.height)?.get(totalKey) ??
        (base !== null && known ? base + change.value - before : null);
      if (total === null && changed) {
        total = await this.totalAt(change, totalsAt);
        if (total === null) {
          report.ratingEventProblems.push(
            `${change.height}: a total that may be off`
          );
        }
      }
      const guess = total ?? roughBase + change.value - before;
      running.set(totalKey, total);
      rough.set(totalKey, guess);
      const importOnly = importDone !== null && change.height < importDone;
      if (!importOnly && !change.writer && change.byImport !== true) {
        withoutWriter++;
      }
      if (!changed) continue;
      const name = this.nameOf(change);
      if (name === null) {
        report.ratingEventProblems.push(
          `${change.height}: no name for the category ${change.categoryId}`
        );
        continue;
      }
      if (change.matter === 'REP' && isHelpBotCreditCategory(name)) continue;
      if (!known) {
        report.ratingEventProblems.push(
          `${change.height}: the value before is not known (origin UNKNOWN)`
        );
      }
      rows.push({
        height: change.height,
        block_time_ms: change.blockTimeMs,
        rater_principal: change.rater,
        rater_profile_id: mapped.get(change.rater) ?? null,
        target_principal: change.target,
        target_profile_id: mapped.get(change.target) ?? null,
        matter: change.matter,
        matter_category: name,
        old_rating: before,
        new_rating: change.value,
        total_after: guess,
        // The import's own heights are the import's; a value before that
        // can't be known notifies no one.
        origin: !known
          ? 'UNKNOWN'
          : importOnly
            ? 'IMPORT'
            : ratingEventOrigin(change.writer, change.byImport),
        by_import: change.byImport === true,
        writer: writerText(change.writer)
      });
    }
    const names = this.unstoredNames(changes, categoryNames);
    const written = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        await this.db.writeRatingLedger(
          Array.from(set.values()),
          Array.from(removed.values()),
          conn
        );
        await this.db.writeRatingCategories(names, conn);
        const count = await this.db.insertRatingEvents(rows, this.now(), conn);
        await this.db.saveRatingEventsCursor(after, this.now(), conn);
        return count;
      }
    );
    names.forEach((it) => this.storedCategories.add(it.id));
    report.ratingEvents += written;
    return { cursor: after, withoutWriter };
  }

  /**
   * A ledger row that can't be trusted: marked stale, or older than the
   * height the follower went on from after a gap; after a gap, no row too.
   */
  private isStale(
    row: RatingLedgerRow | undefined,
    resume: number | null
  ): boolean {
    if (!row) return resume !== null;
    return row.stale || (resume !== null && row.height < resume);
  }

  /** The ledger's total when exact (no gap, no stale row); else null. */
  private ledgerTotal(
    entry: { total: number; stale: number } | undefined,
    resume: number | null
  ): number | null {
    if (resume !== null || (entry?.stale ?? 0) > 0) return null;
    return entry?.total ?? 0;
  }

  /**
   * The rating's value at the height before the change, from the chain (0
   * when it had none); null when the gateway no longer holds that height or
   * the value can't be read. Any other error ends the run: the page waits.
   */
  private async valueBefore(change: ChainRatingChange): Promise<number | null> {
    const height = change.height - 1;
    try {
      const record = await this.gateway.getState<{
        value?: unknown;
        valueFields?: { value?: unknown } | null;
      }>(change.stateKey, { height });
      if (!record || record.value === null) return 0;
      const value = Number(record.valueFields?.value);
      return Number.isSafeInteger(value) ? value : null;
    } catch (error) {
      if (!isHeightGone(error)) throw error;
      logger.warn(
        `[RATING ${change.stateKey} AT ${height} GONE] [ORIGIN UNKNOWN]`
      );
      return null;
    }
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
        if (!isHeightGone(error)) throw error;
        logger.warn(
          `[RATING TOTALS AT ${change.height} GONE] [A TOTAL FROM THE LEDGER]`
        );
        read.set(key, null);
      }
    }
    const totals = read.get(key);
    return totals ? totalIn(totals, change) : null;
  }

  /** The REP category's name ('' for NIC); null when the chain has none. */
  private nameOf(change: ChainRatingChange): string | null {
    if (change.categoryId === null) return '';
    return this.categoryNames.get(change.categoryId) ?? null;
  }

  /**
   * Names of the page's categories not known yet: the stored ones, else the
   * chain's. A category the chain has no name for leaves its rows out; a
   * read that fails ends the run before the page is written.
   */
  private async loadCategoryNames(changes: readonly ChainRatingChange[]) {
    const missing = Array.from(
      new Set(
        changes
          .map((it) => it.categoryId)
          .filter((it): it is string => !!it && !this.categoryNames.has(it))
      )
    );
    if (!missing.length) return;
    const stored = await this.db.ratingCategoryNamesOf(missing);
    stored.forEach((name, id) => {
      this.categoryNames.set(id, name);
      this.storedCategories.add(id);
    });
    for (const id of missing) {
      if (this.categoryNames.has(id)) continue;
      const record = await this.gateway.getState<{
        valueFields?: { name?: unknown } | null;
      }>(categoryKey(id));
      const name = record?.valueFields?.name;
      if (typeof name === 'string') this.categoryNames.set(id, name);
      else logger.warn(`[CATEGORY ${id} HAS NO NAME ON THE CHAIN]`);
    }
  }

  /** The page's category names not stored yet. */
  private unstoredNames(
    changes: readonly ChainRatingChange[],
    fromBlocks: Map<string, string>
  ): { id: string; name: string }[] {
    const ids = new Set<string>(fromBlocks.keys());
    changes.forEach((it) => {
      if (it.categoryId) ids.add(it.categoryId);
    });
    return Array.from(ids).flatMap((id) => {
      const name = this.categoryNames.get(id);
      return name !== undefined && !this.storedCategories.has(id)
        ? [{ id, name }]
        : [];
    });
  }
}

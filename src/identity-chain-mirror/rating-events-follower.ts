import {
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainRating,
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
  RatingEventsCursor,
  RatingLedgerKey,
  RatingLedgerRow
} from './identity-chain-mirror.db';
import { messageOf } from './mirror-errors';
import {
  categoryKey,
  ChainRatingChange,
  ledgerKeyOf,
  ledgerRowOfRating,
  RATING_EVENT_FAMILIES,
  ratingChangesOf,
  ratingEventOrigin,
  totalIn,
  totalKeyOf,
  writerText
} from './rating-events';

const logger = Logger.get('IDENTITY_CHAIN_RATING_EVENTS');

const PAGE_BLOCKS = 200;
/** Identities a step of a ledger rebuild's walk (the most a page gives). */
const REBUILD_PAGE = 500;
/** Targets whose ratings a rebuild reads at once. */
const REBUILD_READS_AT_ONCE = 8;
/** Runs in a row without moving, behind the identities, before the alarm. */
export const RATING_EVENTS_STUCK_RUNS = 5;
/** Problems listed in a run's report; past these they are only counted. */
const PROBLEMS_LISTED = 50;
/** The longest category name the event log holds. */
const CATEGORY_NAME_MAX = 100;

type Gateway = Pick<
  ChainGatewayClient,
  | 'getChanges'
  | 'getState'
  | 'getStatus'
  | 'getRatingTotals'
  | 'getHead'
  | 'listIdentities'
  | 'getRatings'
>;

type Db = Pick<
  IdentityChainMirrorDb,
  | 'executeNativeQueriesInTransaction'
  | 'getState'
  | 'saveRatingEventsCursor'
  | 'clearRatingEvents'
  | 'clearRatingLedger'
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
   * The first problems of the run: rating records that couldn't be read
   * (`height:key`), rows written with a value before or a total that may be
   * off, and what stopped the follower for the run.
   */
  ratingEventProblems: string[];
  /** Problems past the listed ones, only counted. */
  ratingEventProblemsLeftOut: number;
  /** Rating records after the import that carry no writer (an old gateway). */
  ratingRecordsWithoutWriter: number;
  /** Where the follower stopped: the next feed height it reads. */
  eventsNextHeight: number | null;
  /**
   * Set when the follower is stuck behind the identities: the run fails
   * once the profile site followers have run.
   */
  ratingEventsStuck?: string;
}

/** A problem for the run's report: the first ones listed, the rest counted. */
export function noteRatingEventProblem(
  report: Pick<
    RatingEventsReport,
    'ratingEventProblems' | 'ratingEventProblemsLeftOut'
  >,
  problem: string
) {
  if (report.ratingEventProblems.length < PROBLEMS_LISTED) {
    report.ratingEventProblems.push(problem);
  } else {
    report.ratingEventProblemsLeftOut++;
  }
}

/** The run's time ran out inside a page: it is dropped, nothing written. */
class OutOfTime extends Error {
  constructor() {
    super('out of time');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A height the gateway no longer holds. The node serves pinned reads of its
 * last views only; a refusal stamped below the height asked is a node that
 * hasn't finalized it yet, not one that dropped it.
 */
function isGoneForGood(error: unknown, height: number): boolean {
  return (
    error instanceof ChainGatewayError &&
    error.code === 'height_gone' &&
    !(error.read !== undefined && error.read.finalizedHeight < height)
  );
}

function cursorOf(state: MirrorState): RatingEventsCursor {
  return {
    next: Number(state.events_next_height),
    rebuildHeight:
      state.events_rebuild_height === null
        ? null
        : Number(state.events_rebuild_height),
    rebuildAfter: state.events_rebuild_after,
    goneAt: state.events_gone_at === null ? null : Number(state.events_gone_at),
    stuckRuns: Number(state.events_stuck_runs ?? 0)
  };
}

/**
 * The rating events (identity_chain_rating_events) and their ledger
 * (identity_chain_rating_ledger), from the feed's rating families with
 * their own place in the state (the events_ columns), from the import's
 * start: whole blocks of the mirror's chain, never past the identity sync's
 * place (so raters and targets are mapped first), each page's rows,
 * ledger, category names and place in one transaction.
 *
 * Each Rating record of an identity gives a row: the value before, the new
 * one, the total after, the origin from its writer. The value before is
 * the ledger's; a key the follower couldn't read is marked stale, and its
 * next change reads the value from the chain at the height before (origin
 * UNKNOWN when the gateway no longer holds it). The total is the block's
 * RatingTotal record, else the ledger's when none of its rows is stale,
 * else the chain's totals at the height. Nothing comes from 6529.io's
 * ratings, which the identity sync writes at newer heights.
 *
 * A gap in the feed (seen gone on two runs) rebuilds the ledger from the
 * chain's ratings at one pinned height, and the follower goes on from the
 * next one. A read that fails otherwise, or a run's time running out, ends
 * the follower's run before the page is written (reported, not thrown):
 * the page waits. A follower that doesn't move behind the identities for
 * RATING_EVENTS_STUCK_RUNS runs fails the run.
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
    let state: MirrorState | null = null;
    try {
      // The state as stored: an identity step that threw leaves the run's
      // copy behind it.
      state = await this.db.getState();
      if (!state) {
        logger.warn('[NO MIRROR STATE YET] [RATING EVENTS WAIT]');
        return;
      }
      await this.read(state, importStart, importDone, deadline, report, (n) => {
        withoutWriter += n;
      });
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[RATING EVENTS WAIT FOR THE NEXT RUN] ${message}`);
      noteRatingEventProblem(report, message);
    } finally {
      report.ratingRecordsWithoutWriter += withoutWriter;
      if (withoutWriter) {
        logger.error(
          `[RATING RECORDS WITHOUT A WRITER AFTER THE IMPORT] [${withoutWriter}] [THEIR ORIGIN IS UNKNOWN: NO NOTIFICATION]`
        );
      }
    }
    if (state) await this.checkProgress(state, report);
  }

  /**
   * Counts the runs the follower didn't move while behind the identities
   * (or in a gap); at RATING_EVENTS_STUCK_RUNS the run fails, so it alarms.
   */
  private async checkProgress(before: MirrorState, report: RatingEventsReport) {
    try {
      const after = await this.db.getState();
      if (!after || after.events_next_height === null) return;
      const was = before.events_next_height === null ? null : cursorOf(before);
      const now = cursorOf(after);
      const moved =
        was === null ||
        now.next > was.next ||
        (now.rebuildHeight !== null &&
          now.rebuildHeight === was.rebuildHeight &&
          now.rebuildAfter !== was.rebuildAfter);
      const behind =
        now.rebuildHeight !== null ||
        now.goneAt !== null ||
        (after.next_height !== null && now.next < Number(after.next_height));
      const stuckRuns = moved || !behind ? 0 : now.stuckRuns + 1;
      if (stuckRuns !== now.stuckRuns) {
        await this.db.saveRatingEventsCursor({ ...now, stuckRuns }, this.now());
      }
      if (stuckRuns >= RATING_EVENTS_STUCK_RUNS) {
        const message = `Rating events stuck at ${now.next} for ${stuckRuns} runs: ${report.ratingEventProblems[0] ?? 'no page written'}`;
        logger.error(`[RATING EVENTS STUCK] ${message}`);
        report.ratingEventsStuck = message;
      }
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[RATING EVENTS PROGRESS NOT SAVED] ${message}`);
      noteRatingEventProblem(report, message);
    }
  }

  private async read(
    state: MirrorState,
    importStart: number | null,
    importDone: number | null,
    deadline: number,
    report: RatingEventsReport,
    countWithoutWriter: (count: number) => void
  ) {
    if (this.namesChain !== state.chain_id) {
      this.forgetNames(state.chain_id);
    }
    report.eventsNextHeight = state.events_next_height;
    // Rows wait for the first full sync to end and for the identity sync's
    // place, so their raters and targets are mapped when they are written.
    if (state.last_full_sync_at === null || state.next_height === null) {
      logger.info('[RATING EVENTS WAIT FOR THE FIRST FULL SYNC]');
      return;
    }
    const until = Number(state.next_height);
    let cursor: RatingEventsCursor;
    if (state.events_next_height === null) {
      // From the import's start, with nothing left of an earlier start;
      // without one, from a ledger built at the latest finalized height.
      let first: RatingEventsCursor = {
        next: Number(importStart),
        rebuildHeight: null,
        rebuildAfter: null,
        goneAt: null,
        stuckRuns: 0
      };
      if (importStart === null) {
        const head = await this.gateway.getHead(true);
        const pin = Number(head.finalizedHeight);
        logger.error(
          `[NO IMPORT START] [NO RATING EVENTS UP TO ${pin}] [THE LEDGER IS BUILT AT ${pin}]`
        );
        first = { ...first, next: pin + 1, rebuildHeight: pin };
      }
      await this.db.executeNativeQueriesInTransaction(async (conn) => {
        await this.db.clearRatingEvents(conn);
        await this.db.saveRatingEventsCursor(first, this.now(), conn);
      });
      this.forgetNames(state.chain_id);
      cursor = first;
      report.eventsNextHeight = cursor.next;
    } else {
      cursor = cursorOf(state);
    }
    while (this.now() < deadline) {
      if (cursor.rebuildHeight !== null) {
        cursor = await this.rebuild(cursor, deadline, report);
        report.eventsNextHeight = cursor.next;
        continue;
      }
      const from = cursor.next;
      if (from >= until) break;
      const page = await readWholeBlocks(this.gateway, from, {
        limit: PAGE_BLOCKS,
        families: RATING_EVENT_FAMILIES,
        sleep: this.sleep
      });
      if (!page) {
        cursor = await this.afterGone(cursor);
        if (cursor.rebuildHeight === null) break;
        continue;
      }
      if (page.atHead || page.nextHeight <= from) break;
      if (isOtherChain(state.chain_id, page.network)) {
        logger.warn(
          `[FEED PAGE OF ANOTHER CHAIN] [${page.network}] [NEXT RUN]`
        );
        break;
      }
      const next = Math.min(page.nextHeight, until);
      const blocks = page.blocks.filter((it) => Number(it.height) < next);
      let written: { cursor: RatingEventsCursor; withoutWriter: number };
      try {
        written = await this.writePage(
          blocks,
          // A page read: a gone seen earlier was a node's.
          { ...cursor, next, goneAt: null },
          importDone,
          deadline,
          report
        );
      } catch (error) {
        if (!(error instanceof OutOfTime)) throw error;
        logger.warn(`[OUT OF TIME IN THE PAGE AT ${from}] [NEXT RUN]`);
        break;
      }
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

  /** Throws OutOfTime when the run has no time left for another read. */
  private ensureTime(deadline: number) {
    if (this.now() >= deadline) throw new OutOfTime();
  }

  /**
   * The feed no longer holds the cursor's height. One answer may be a
   * node's: the first time it is noted, and only when the next run finds it
   * gone too is the ledger rebuilt (the rows of the gap are lost).
   */
  private async afterGone(
    cursor: RatingEventsCursor
  ): Promise<RatingEventsCursor> {
    const from = cursor.next;
    const next = await this.nextHeld(from);
    if (next !== null && next <= from) {
      logger.error(
        `[RATING EVENTS: FEED GONE AT ${from}] [STILL HELD] [NEXT RUN]`
      );
      return cursor;
    }
    if (cursor.goneAt !== from) {
      logger.error(
        `[RATING EVENTS: FEED GONE AT ${from}] [TAKEN AS A GAP IF THE NEXT RUN FINDS IT GONE TOO]`
      );
      const seen = { ...cursor, goneAt: from };
      await this.db.saveRatingEventsCursor(seen, this.now());
      return seen;
    }
    return await this.startRebuild(cursor, `FEED GONE AT ${from}`);
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

  /**
   * A ledger rebuild at the latest finalized height, from an empty ledger:
   * the heights from the cursor's to it give no rows.
   */
  private async startRebuild(
    cursor: RatingEventsCursor,
    why: string
  ): Promise<RatingEventsCursor> {
    const head = await this.gateway.getHead(true);
    const pin = Number(head.finalizedHeight);
    logger.error(
      `[RATING EVENTS: ${why}] [NO ROWS FOR HEIGHTS ${cursor.next} TO ${pin}] [THE LEDGER IS REBUILT AT ${pin}]`
    );
    const rebuilding = {
      ...cursor,
      rebuildHeight: pin,
      rebuildAfter: null,
      goneAt: null
    };
    await this.db.executeNativeQueriesInTransaction(async (conn) => {
      await this.db.clearRatingLedger(conn);
      await this.db.saveRatingEventsCursor(rebuilding, this.now(), conn);
    });
    return rebuilding;
  }

  /**
   * Steps of the ledger rebuild: the identities at the pinned height, a
   * page at a time, each with raters giving its ratings there; each step's
   * rows and place in one transaction. Done, the follower goes on from the
   * next height. When the gateway no longer holds the pin, the rebuild
   * starts again at a newer one.
   */
  private async rebuild(
    initial: RatingEventsCursor,
    deadline: number,
    report: RatingEventsReport
  ): Promise<RatingEventsCursor> {
    let cursor = initial;
    const pin = Number(cursor.rebuildHeight);
    const started = this.now();
    let identities = 0;
    const took = () =>
      `[${identities} IDENTITIES IN ${this.now() - started} MS THIS RUN]`;
    while (this.now() < deadline) {
      const rows: (RatingLedgerKey & RatingLedgerRow)[] = [];
      const names = new Map<string, string>();
      let next: string | null;
      try {
        this.ensureTime(deadline);
        const page = await this.gateway.listIdentities({
          height: pin,
          after: cursor.rebuildAfter,
          limit: REBUILD_PAGE
        });
        if (!page) throw new Error(`No identity list at ${pin}`);
        const targets = page.items
          .filter((it) => (it.rep?.raters ?? 0) + (it.nic?.raters ?? 0) > 0)
          .map((it) => it.principalId);
        const lists: ChainRating[][] = [];
        for (let i = 0; i < targets.length; i += REBUILD_READS_AT_ONCE) {
          lists.push(
            ...(await Promise.all(
              targets
                .slice(i, i + REBUILD_READS_AT_ONCE)
                .map((target) => this.ratingsAt(target, pin, deadline))
            ))
          );
        }
        for (const rating of lists.flat()) {
          const row = ledgerRowOfRating(rating, pin);
          if (!row) {
            noteRatingEventProblem(
              report,
              `${pin}: a rating of ${rating.target} not read`
            );
            continue;
          }
          rows.push(row);
          const name = rating.category?.name;
          if (row.matterCode === 1 && typeof name === 'string') {
            names.set(row.category, name);
          }
        }
        next = page.next;
        identities += page.items.length;
      } catch (error) {
        if (error instanceof OutOfTime) {
          logger.info(
            `[RATING LEDGER REBUILD AT ${pin} GOES ON NEXT RUN] ${took()}`
          );
          return cursor;
        }
        if (isGoneForGood(error, pin)) {
          return await this.startRebuild(
            cursor,
            `LEDGER REBUILD AT ${pin} GONE`
          );
        }
        throw error;
      }
      const done = next === null;
      const after: RatingEventsCursor = done
        ? {
            next: pin + 1,
            rebuildHeight: null,
            rebuildAfter: null,
            goneAt: null,
            stuckRuns: cursor.stuckRuns
          }
        : { ...cursor, rebuildAfter: next };
      const stored = Array.from(names.entries())
        .filter(([id]) => !this.storedCategories.has(id))
        .map(([id, name]) => ({ id, name }));
      await this.db.executeNativeQueriesInTransaction(async (conn) => {
        await this.db.writeRatingLedger(rows, [], conn);
        await this.db.writeRatingCategories(stored, conn);
        await this.db.saveRatingEventsCursor(after, this.now(), conn);
      });
      names.forEach((name, id) => {
        this.categoryNames.set(id, name);
        this.storedCategories.add(id);
      });
      cursor = after;
      if (done) {
        logger.info(
          `[RATING LEDGER REBUILT AT ${pin}] [GOING ON FROM ${pin + 1}] ${took()}`
        );
        return cursor;
      }
    }
    logger.info(`[RATING LEDGER REBUILD AT ${pin} GOES ON NEXT RUN] ${took()}`);
    return cursor;
  }

  /** A target's ratings at the pinned height, every page. */
  private async ratingsAt(
    target: string,
    pin: number,
    deadline: number
  ): Promise<ChainRating[]> {
    const all: ChainRating[] = [];
    let after: string | null = null;
    for (;;) {
      this.ensureTime(deadline);
      const page = await this.gateway.getRatings(
        { target },
        { height: pin, after, limit: 500 }
      );
      all.push(...(page?.items ?? []));
      after = page?.next ?? null;
      if (!after) return all;
    }
  }

  /** One page's rows, ledger, names and place, in one transaction. */
  private async writePage(
    blocks: readonly ChainFeedBlock[],
    after: RatingEventsCursor,
    importDone: number | null,
    deadline: number,
    report: RatingEventsReport
  ): Promise<{ cursor: RatingEventsCursor; withoutWriter: number }> {
    const { changes, categoryNames, totals, unreadable } =
      ratingChangesOf(blocks);
    categoryNames.forEach((name, id) => this.categoryNames.set(id, name));
    if (unreadable.length) {
      logger.error(`[RATING RECORDS NOT READ] ${unreadable.join(', ')}`);
      unreadable.forEach((it) => noteRatingEventProblem(report, it));
    }
    await this.loadCategoryNames(changes, deadline);
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
      } else if (set.get(key)?.stale || row?.stale) {
        this.ensureTime(deadline);
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
      // The block's own total, else the ledger's when none of its rows is
      // stale, else the chain's at the height.
      const base = running.has(totalKey)
        ? (running.get(totalKey) ?? null)
        : this.ledgerTotal(totalsBefore.get(totalKey));
      const roughBase =
        rough.get(totalKey) ?? totalsBefore.get(totalKey)?.total ?? 0;
      let total: number | null =
        totals.get(change.height)?.get(totalKey) ??
        (base !== null && known ? base + change.value - before : null);
      if (total === null && changed) {
        this.ensureTime(deadline);
        total = await this.totalAt(change, totalsAt);
        if (total === null) {
          noteRatingEventProblem(
            report,
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
        noteRatingEventProblem(
          report,
          `${change.height}: no name for the category ${change.categoryId}`
        );
        continue;
      }
      if (change.matter === 'REP' && isHelpBotCreditCategory(name)) continue;
      if (!known) {
        noteRatingEventProblem(
          report,
          `${change.height}: the value before is not known (origin UNKNOWN)`
        );
      }
      if (name.length > CATEGORY_NAME_MAX) {
        noteRatingEventProblem(
          report,
          `${change.height}: the category name of ${change.categoryId} cut to ${CATEGORY_NAME_MAX} characters`
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
        matter_category: name.slice(0, CATEGORY_NAME_MAX),
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

  /** The ledger's total when none of its rows is stale; else null. */
  private ledgerTotal(
    entry: { total: number; stale: number } | undefined
  ): number | null {
    if ((entry?.stale ?? 0) > 0) return null;
    return entry?.total ?? 0;
  }

  /**
   * The rating's value at the height before the change, from the chain (0
   * when it had none); null when the gateway no longer holds that height or
   * the value can't be read. Any other error (a node that hasn't finalized
   * the height yet among them) ends the run: the page waits.
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
      if (!isGoneForGood(error, height)) throw error;
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
        if (!isGoneForGood(error, change.height)) throw error;
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
  private async loadCategoryNames(
    changes: readonly ChainRatingChange[],
    deadline: number
  ) {
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
      this.ensureTime(deadline);
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

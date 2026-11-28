import { createHash } from 'node:crypto';
import { appFeatures, AppFeatures } from '@/app-features';
import { afterCommitAwaited } from '@/db/after-commit';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { sendPriorityAlertIfConfigured } from '@/priority-alerts.context';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { MintStateWriter, mintStateWriter } from './mint-log-apply';
import { MintStateReader, mintStateReader } from './mint-log-capture';
import { changedParts, diffCardState, differingParts } from './mint-log-diff';
import {
  MintLogHead,
  MintLogHeadDb,
  mintHeadKey,
  mintLogHeadDb
} from './mint-log-head.db';
import {
  MINT_ADMIN_RECORD_TYPE,
  MINT_USER_RECORD_TYPE,
  MintIntent,
  recordMismatch
} from './mint-log-intent';
import {
  getMintLogPorts,
  MintLogPorts,
  MintRecordLogEntry,
  MintRecordVerifyResult,
  MintVerifiedRecord
} from './mint-log-ports';
import { MINT_ROW_PART_SPECS } from './mint-log-parts';
import {
  MINT_KIND_CHAIN,
  MINT_KIND_PARTS,
  MINT_LOG_ENTRY_VERSION,
  MINT_LOG_LANE,
  MINT_ROW_PARTS,
  MintCardEffects,
  MintCardRef,
  MintCardState,
  MintLogActor,
  MintLogChecks,
  MintLogEntryBody,
  MintLogKind
} from './mint-log.types';

const logger = Logger.get('MINT_LOG');
const REPLAY_SAVEPOINT = 'mint_log_replay';
const WITHIN_SAVEPOINT = 'mint_log_within';

/**
 * A user's own collaboration writes. They need the user's device grant, and
 * until most artists have one they keep shadow rules in primary mode
 * (MINT_LOG_COLLAB_RECORDS turns the requirement on).
 */
const USER_ENROLMENT_KINDS: ReadonlySet<MintLogKind> = new Set<MintLogKind>([
  'collab.invite',
  'collab.respond'
]);

export type MintLogMode = 'off' | 'shadow' | 'primary';

export interface MintWriteSpec<T = unknown> {
  readonly kind: MintLogKind;
  /** The card, or how to find it once the log lock is held. */
  readonly card:
    | MintCardRef
    | ((connection: ConnectionWrapper<any>) => Promise<MintCardRef>);
  readonly actor: MintLogActor;
  /** Admin and user writes: the request. Service writes: what triggered them. */
  readonly intent: MintIntent;
  /** The `x-6529-signed-records` header, as received. */
  readonly signedRecords?: string | null;
  /**
   * The route already verified the admin's wallet signature over this request
   * (NextGen uploads), and the intent carries it, so no device record is
   * needed.
   */
  readonly walletSigned?: boolean;
  /**
   * The write runs inside another write that carries the user's authority
   * (a drop write, `drop.write`): no record of its own is needed.
   */
  readonly enclosing?: string;
  /** Read under the log lock, before the writer runs. */
  readonly inputs?: (
    connection: ConnectionWrapper<any>
  ) => Promise<Record<string, unknown>>;
  /** For a write whose result lives outside the tables (a GitHub commit). */
  readonly outputs?: (value: T) => Record<string, unknown>;
  /**
   * 'write' (default): the log lock is held while the writer runs.
   * 'capture': for a long writer (the Arweave upload) the lock is held only to
   * capture and log afterwards; the entry keeps only the kind's declared parts,
   * since other writes in between log their own changes.
   */
  readonly lockScope?: 'write' | 'capture';
  /**
   * writeWithin only: read its kind's parts with FOR UPDATE. For a
   * caller whose transaction may hold a snapshot older than its locks (Drop
   * Forge's job and signer transactions run at the server's REPEATABLE
   * READ): its DELETEs and UPDATEs act on the latest rows, and a plain read
   * would miss rows committed in between: a delete of such a row would go
   * unlogged, and an update would be logged against a stale before.
   */
  readonly readCurrent?: boolean;
}

export class InvalidSignedRecordException extends CustomApiCompliantException {
  constructor(reason: string, detail: string) {
    super(400, `Invalid signed record: ${detail}`, 'INVALID_SIGNED_RECORD', {
      reason
    });
  }
}

export class MintLogUnavailableException extends CustomApiCompliantException {
  constructor(detail: string) {
    super(
      503,
      `The mint log is unavailable: ${detail}`,
      'MINT_LOG_UNAVAILABLE'
    );
  }
}

/** The log's own failure after the writer committed: report, don't hide. */
class MintLogTransactionLost extends Error {}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface Captured {
  readonly card: MintCardRef;
  readonly before: MintCardState;
  readonly inputs: Record<string, unknown>;
  /**
   * Whether the subscriptions switch named the identity tables, read once
   * for the write; every capture of the write uses it.
   */
  readonly identityTruth?: boolean;
  /** Parts read with FOR UPDATE: its kind's parts (readCurrent). */
  readonly current?: ReadonlySet<string>;
}

/**
 * A failed write that changed nothing needs no entry, and neither does a
 * service write that found nothing to do (a claim that already exists), nor
 * a write inside another that left this card as it was (a drop edit that
 * kept the artwork).
 */
function needsEntry<T>(
  spec: MintWriteSpec<T>,
  outcome: Outcome<unknown>,
  effects: MintCardEffects
): boolean {
  if (changedParts(effects).length) return true;
  return outcome.ok && spec.actor.type !== 'service' && !spec.enclosing;
}

function declaredOnly(
  kind: MintLogKind,
  effects: MintCardEffects
): MintCardEffects {
  const declared = MINT_KIND_PARTS[kind];
  const kept: Record<string, unknown> = {};
  for (const part of changedParts(effects)) {
    if (declared.includes(part)) kept[part] = effects[part];
  }
  return kept as MintCardEffects;
}

export function entrySha256(entry: MintLogEntryBody): string {
  return createHash('sha256').update(canonicalizeJson(entry)).digest('hex');
}

function cardLabel(card: MintCardRef): string {
  return card.key === undefined
    ? `${card.contract}#${card.card_id}`
    : `${card.contract}:${card.key}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Wraps a write to the minting tables. Under the log lock it captures the
 * card's rows, runs the writer, captures again, and queues one entry with the
 * row changes in the same transaction as the lock. The writers themselves are
 * unchanged: with both flags off this runs the writer and nothing else.
 */
export class MintLogRecorder {
  constructor(
    private readonly features: Pick<
      AppFeatures,
      | 'isMintLogShadowEnabled'
      | 'isMintLogPrimaryEnabled'
      | 'isMintLogReplayCheckEnabled'
    > &
      Partial<
        Pick<AppFeatures, 'isMintLogCollabRecordsRequired'>
      > = appFeatures,
    private readonly ports: () => MintLogPorts = getMintLogPorts,
    private readonly db: () => SqlExecutor = dbSupplier,
    private readonly reader: MintStateReader = mintStateReader,
    private readonly writer: MintStateWriter = mintStateWriter,
    private readonly head: MintLogHeadDb = mintLogHeadDb
  ) {}

  mode(): MintLogMode {
    if (this.features.isMintLogPrimaryEnabled()) return 'primary';
    if (this.features.isMintLogShadowEnabled()) return 'shadow';
    return 'off';
  }

  async write<T>(spec: MintWriteSpec<T>, run: () => Promise<T>): Promise<T> {
    const mode = this.mode();
    if (mode === 'off') return run();
    let ports: MintLogPorts;
    try {
      ports = this.ports();
    } catch (error) {
      if (mode === 'primary') throw error;
      await this.skipped(spec, error);
      return run();
    }
    if (!ports.log) {
      if (mode === 'primary') {
        throw new MintLogUnavailableException('no record log is bound');
      }
      logger.warn(
        `[MINT_LOG_SHADOW_IDLE] [${spec.kind}] no record log is bound`
      );
      return run();
    }
    const record = await this.authorize(spec, mode, ports);
    if (spec.lockScope === 'capture') {
      return this.loggedAfter(spec, mode, record, run);
    }
    return this.logged(spec, mode, record, run);
  }

  /**
   * Shadow mode: the log failed before the writer ran (a lock wait, a
   * deadlock, a missing table). The write goes ahead unlogged, and the gap
   * is alerted: a later genesis or the replay check shows it.
   */
  private async skipped<T>(
    spec: MintWriteSpec<T>,
    error: unknown,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const message = `[MINT_LOG_SHADOW_SKIPPED] [${spec.kind}] the write ran unlogged: ${errorText(error)}`;
    if (connection) {
      await this.alertAfterCommit(message, connection);
      return;
    }
    await this.alert(message);
  }

  private async alert(message: string): Promise<void> {
    logger.error(message);
    await this.sendAlert(message);
  }

  private async sendAlert(message: string): Promise<void> {
    await sendPriorityAlertIfConfigured('Mint log', new Error(message)).catch(
      (alertError) =>
        logger.warn(`[MINT_LOG_ALERT_FAILED] ${errorText(alertError)}`)
    );
  }

  /**
   * As alert, but the priority alert, a network call, goes out once the
   * caller's transaction commits, so it isn't made while the caller's locks
   * and the mint log's head are held, and the commit waits for it in full,
   * so a Lambda invocation doesn't end first. The error is logged at once.
   * If the transaction rolls back, the write it was about is gone with it,
   * and so is the alert.
   */
  private async alertAfterCommit(
    message: string,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    logger.error(message);
    await afterCommitAwaited(connection, () => this.sendAlert(message));
  }

  /**
   * Logs a write that runs inside the caller's transaction (a drop write, a
   * decision result): the head is locked on the caller's connection, and the
   * entry commits or rolls back with the caller's changes. A writer that
   * throws leaves nothing to log, since the caller's transaction rolls back
   * with it. In shadow mode a failure of the log's own statements is rolled
   * back to a savepoint and reported, and the caller's write goes on.
   */
  async writeWithin<T>(
    spec: MintWriteSpec<T>,
    connection: ConnectionWrapper<any>,
    run: () => Promise<T>
  ): Promise<T> {
    const mode = this.mode();
    if (mode === 'off') return run();
    let ports: MintLogPorts;
    try {
      ports = this.ports();
    } catch (error) {
      if (mode === 'primary') throw error;
      await this.skipped(spec, error, connection);
      return run();
    }
    if (!ports.log) {
      if (mode === 'primary') {
        throw new MintLogUnavailableException('no record log is bound');
      }
      logger.warn(
        `[MINT_LOG_SHADOW_IDLE] [${spec.kind}] no record log is bound`
      );
      return run();
    }
    const record = await this.authorize(spec, mode, ports);
    const started = await this.guarded(spec, mode, connection, async () => {
      const card =
        typeof spec.card === 'function'
          ? await spec.card(connection)
          : spec.card;
      const head = await this.head.lock(
        connection,
        mintHeadKey(MINT_KIND_CHAIN[spec.kind], card)
      );
      const inputs = spec.inputs ? await spec.inputs(connection) : {};
      const identityTruth = await this.reader.identityTruthFor?.(card);
      const current = spec.readCurrent
        ? new Set<string>(MINT_KIND_PARTS[spec.kind])
        : undefined;
      const before = await this.reader.capture(card, connection, {
        identityTruth,
        current
      });
      return {
        head,
        captured: { card, before, inputs, identityTruth, current }
      };
    });
    const value = await run();
    if (!started) return value;
    const entry = await this.guarded(spec, mode, connection, () =>
      this.finish(
        spec,
        record,
        started.captured,
        { ok: true, value },
        started.head,
        connection
      )
    );
    if (entry) await this.report(entry, connection);
    return value;
  }

  /**
   * Primary: the log's statements fail the caller's transaction. Shadow:
   * they run in a savepoint, and a failure is undone, reported and skipped.
   */
  private async guarded<T, R>(
    spec: MintWriteSpec<T>,
    mode: MintLogMode,
    connection: ConnectionWrapper<any>,
    step: () => Promise<R>
  ): Promise<R | null> {
    if (mode === 'primary') return step();
    const execute = (sql: string) =>
      this.db().execute(sql, undefined, { wrappedConnection: connection });
    await execute(`SAVEPOINT ${WITHIN_SAVEPOINT}`);
    try {
      const result = await step();
      await execute(`RELEASE SAVEPOINT ${WITHIN_SAVEPOINT}`);
      return result;
    } catch (error) {
      // A deadlock ends the caller's transaction whole; then there is
      // nothing left to save and the caller must see the error.
      await execute(`ROLLBACK TO SAVEPOINT ${WITHIN_SAVEPOINT}`).catch(() => {
        throw error;
      });
      await this.alertAfterCommit(
        `[MINT_LOG_SHADOW_FAILED] [${spec.kind}] ${errorText(error)}`,
        connection
      );
      return null;
    }
  }

  /**
   * The head a write locks before its card is known. A collaboration's
   * head is its artwork's, so its card must be given, not looked up.
   */
  private lockKey<T>(spec: MintWriteSpec<T>): string {
    const chain = MINT_KIND_CHAIN[spec.kind];
    return mintHeadKey(
      chain,
      typeof spec.card === 'function' ? null : spec.card
    );
  }

  /**
   * Primary: an admin or user write needs a verified record for this request
   * by the signed-in wallet (`mint.admin` for an admin, `mint.user` for a
   * user). Shadow: the record is checked and
   * kept when present, and a problem is logged, never thrown.
   */
  private async authorize<T>(
    spec: MintWriteSpec<T>,
    mode: MintLogMode,
    ports: MintLogPorts
  ): Promise<MintVerifiedRecord | null> {
    if (spec.actor.type === 'service' || spec.walletSigned || spec.enclosing) {
      return null;
    }
    const recordType =
      spec.actor.type === 'admin'
        ? MINT_ADMIN_RECORD_TYPE
        : MINT_USER_RECORD_TYPE;
    // Records are required in primary mode, except a user's collaboration
    // invite or reply until the team turns that on (most artists have no
    // device grant yet): those keep shadow rules.
    const required =
      mode === 'primary' &&
      (!USER_ENROLMENT_KINDS.has(spec.kind) ||
        this.features.isMintLogCollabRecordsRequired?.() === true);
    const problem = (reason: string, detail: string) => {
      if (required) {
        throw new InvalidSignedRecordException(reason, detail);
      }
      logger.warn(
        `[MINT_LOG_SHADOW_RECORD] [${spec.kind}] [${reason}] [wallet ${spec.actor.wallet ?? 'none'}] ${detail}`
      );
      return null;
    };
    if (!spec.signedRecords) {
      return problem(
        'missing',
        `this write needs a signed ${recordType} record`
      );
    }
    if (!ports.records) {
      if (required) {
        throw new MintLogUnavailableException('no record verifier is bound');
      }
      return null;
    }
    let events: unknown[];
    try {
      events = ports.records.decodeHeader(spec.signedRecords);
    } catch (error) {
      return problem('shape', errorText(error));
    }
    if (events.length !== 1) {
      return problem('shape', 'send exactly one record');
    }
    let verified: MintRecordVerifyResult;
    try {
      verified = await ports.records.verify(events[0]);
    } catch (error) {
      // The verifier itself failed (a grant lookup, say): not the caller's
      // fault, and under shadow rules never a reason to fail the write.
      if (required) {
        throw new MintLogUnavailableException(
          `the record could not be checked: ${errorText(error)}`
        );
      }
      logger.warn(
        `[MINT_LOG_SHADOW_RECORD] [${spec.kind}] [verify] ${errorText(error)}`
      );
      return null;
    }
    if (!verified.ok) {
      return problem(verified.reason, verified.detail);
    }
    const mismatch = recordMismatch(
      verified.record,
      spec.kind,
      spec.intent,
      spec.actor.wallet,
      recordType
    );
    if (mismatch) return problem('intent', mismatch);
    return verified.record;
  }

  private async logged<T>(
    spec: MintWriteSpec<T>,
    mode: MintLogMode,
    record: MintVerifiedRecord | null,
    run: () => Promise<T>
  ): Promise<T> {
    // Set inside the transaction callback; a holder keeps TypeScript from
    // narrowing them to their initial null after the call.
    const state: { outcome: Outcome<T> | null; captured: Captured | null } = {
      outcome: null,
      captured: null
    };
    let entry: MintLogEntryBody | null;
    try {
      entry = await this.db().executeNativeQueriesInTransaction(
        async (connection) => {
          const head = await this.head.lock(connection, this.lockKey(spec));
          const card =
            typeof spec.card === 'function'
              ? await spec.card(connection)
              : spec.card;
          const inputs = spec.inputs ? await spec.inputs(connection) : {};
          const identityTruth = await this.reader.identityTruthFor?.(card);
          const before = await this.reader.capture(card, connection, {
            identityTruth
          });
          const captured: Captured = { card, before, inputs, identityTruth };
          state.captured = captured;
          const outcome = await settle(run);
          state.outcome = outcome;
          return this.finish(spec, record, captured, outcome, head, connection);
        },
        { isolationLevel: 'READ COMMITTED' }
      );
    } catch (error) {
      if (!state.outcome || !state.captured) {
        // The log failed before the writer ran.
        if (mode === 'primary') throw error;
        await this.skipped(spec, error);
        return run();
      }
      entry = await this.afterLostTransaction(
        spec,
        mode,
        record,
        state.captured,
        state.outcome,
        error
      );
    }
    if (entry) await this.report(entry);
    const finished = state.outcome;
    if (!finished) throw new Error('Mint write finished without an outcome');
    if (!finished.ok) throw finished.error;
    return finished.value;
  }

  /**
   * The writer committed its own changes, but the log transaction died after
   * it. Log what the tables now hold in a fresh transaction. If that fails
   * too: in primary mode the change is undone, since nothing may change the
   * tables without an entry; in shadow mode the tables stay as the old path
   * left them and the gap is alerted.
   */
  private async afterLostTransaction<T>(
    spec: MintWriteSpec<T>,
    mode: MintLogMode,
    record: MintVerifiedRecord | null,
    captured: Captured,
    outcome: Outcome<T>,
    cause: unknown
  ): Promise<MintLogEntryBody | null> {
    logger.error(
      `[MINT_LOG_TRANSACTION_LOST] [${spec.kind}] ${errorText(cause)}`
    );
    try {
      return await this.recover(spec, record, captured, outcome);
    } catch (error) {
      await this.alert(
        `[MINT_LOG_ENTRY_LOST] [${spec.kind}] [card ${cardLabel(captured.card)}] ${errorText(error)}`
      );
      if (mode === 'primary') {
        await this.revert(spec, captured);
        throw new MintLogUnavailableException(
          'the change was undone because its log entry could not be written'
        );
      }
      return null;
    }
  }

  private async revert<T>(
    spec: MintWriteSpec<T>,
    captured: Captured
  ): Promise<void> {
    await this.db().executeNativeQueriesInTransaction(
      async (connection) => {
        await this.head.lock(
          connection,
          mintHeadKey(MINT_KIND_CHAIN[spec.kind], captured.card)
        );
        const current = await this.reader.capture(captured.card, connection, {
          identityTruth: captured.identityTruth
        });
        // The identity final rows are the subscriptions journal's: their
        // phase writes are journaled, so a revert leaves them and says so.
        // Only recorder.write() reverts, and no route logs a phase pull
        // through it (the routes use writeWithin, whose writer rolls back
        // with the log); the rebuild check's probe seed is the one caller.
        const undo = diffCardState(current, captured.before);
        const identityParts = MINT_ROW_PARTS.filter(
          (part) =>
            MINT_ROW_PART_SPECS[part].identitySubscriptions && undo[part]
        );
        for (const part of identityParts) {
          delete (undo as Record<string, unknown>)[part];
          logger.error(
            `[MINT_LOG_REVERT_KEPT_IDENTITY_ROWS] [${spec.kind}] [card ${cardLabel(captured.card)}] ${part}`
          );
        }
        await this.writer.apply(captured.card, undo, connection);
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }

  private async finish<T>(
    spec: MintWriteSpec<T>,
    record: MintVerifiedRecord | null,
    captured: Captured,
    outcome: Outcome<T>,
    head: MintLogHead,
    connection: ConnectionWrapper<any>
  ): Promise<MintLogEntryBody | null> {
    const after = await this.reader.capture(captured.card, connection, {
      identityTruth: captured.identityTruth,
      current: captured.current
    });
    const effects = diffCardState(captured.before, after);
    if (!needsEntry(spec, outcome, effects)) return null;
    const replay = this.features.isMintLogReplayCheckEnabled()
      ? await this.replay(captured, effects, after, connection)
      : { replay: 'skipped' as const, replay_mismatches: [] };
    const entry = this.entry(
      spec,
      record,
      captured,
      effects,
      head,
      outcome,
      replay
    );
    await this.append(entry, record, connection);
    return entry;
  }

  /**
   * Logs a write whose writer ran outside the log transaction: after a lost
   * transaction, or for a write whose lock scope is 'capture'.
   */
  private async recover<T>(
    spec: MintWriteSpec<T>,
    record: MintVerifiedRecord | null,
    captured: Captured,
    outcome: Outcome<T>,
    replay: 'aborted' | 'skipped' = 'aborted'
  ): Promise<MintLogEntryBody | null> {
    return this.db().executeNativeQueriesInTransaction(
      async (connection) => {
        const head = await this.head.lock(
          connection,
          mintHeadKey(MINT_KIND_CHAIN[spec.kind], captured.card)
        );
        const after = await this.reader.capture(captured.card, connection, {
          identityTruth: captured.identityTruth
        });
        const diff = diffCardState(captured.before, after);
        const effects =
          spec.lockScope === 'capture' ? declaredOnly(spec.kind, diff) : diff;
        if (!needsEntry(spec, outcome, effects)) return null;
        const entry = this.entry(
          spec,
          record,
          captured,
          effects,
          head,
          outcome,
          {
            replay,
            replay_mismatches: []
          }
        );
        await this.append(entry, record, connection);
        return entry;
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }

  /**
   * The 'capture' lock scope: capture, run unlocked, then log. A failure to
   * log after the writer committed goes the way of a lost transaction:
   * alerted, and undone in primary mode.
   */
  private async loggedAfter<T>(
    spec: MintWriteSpec<T>,
    mode: MintLogMode,
    record: MintVerifiedRecord | null,
    run: () => Promise<T>
  ): Promise<T> {
    let captured: Captured;
    try {
      captured = await this.db().executeNativeQueriesInTransaction(
        async (connection): Promise<Captured> => {
          const card =
            typeof spec.card === 'function'
              ? await spec.card(connection)
              : spec.card;
          const inputs = spec.inputs ? await spec.inputs(connection) : {};
          const identityTruth = await this.reader.identityTruthFor?.(card);
          const before = await this.reader.capture(card, connection, {
            identityTruth
          });
          return { card, before, inputs, identityTruth };
        },
        { isolationLevel: 'READ COMMITTED' }
      );
    } catch (error) {
      if (mode === 'primary') throw error;
      await this.skipped(spec, error);
      return run();
    }
    const outcome = await settle(run);
    let entry: MintLogEntryBody | null;
    try {
      entry = await this.recover(spec, record, captured, outcome, 'skipped');
    } catch (error) {
      entry = await this.afterLostTransaction(
        spec,
        mode,
        record,
        captured,
        outcome,
        error
      );
    }
    if (entry) await this.report(entry);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Inside a savepoint that is always rolled back: undo the write with the
   * reducer and compare with the captured state before it, then redo it and
   * compare with the state after it. This runs the rebuild's code on every
   * logged write without changing a row.
   */
  private async replay(
    captured: Captured,
    effects: MintCardEffects,
    after: MintCardState,
    connection: ConnectionWrapper<any>
  ): Promise<Pick<MintLogChecks, 'replay' | 'replay_mismatches'>> {
    const execute = (sql: string) =>
      this.db().execute(sql, undefined, { wrappedConnection: connection });
    await execute(`SAVEPOINT ${REPLAY_SAVEPOINT}`);
    try {
      const mismatches: string[] = [];
      const undo = diffCardState(after, captured.before);
      await this.writer.apply(captured.card, undo, connection);
      const undone = await this.reader.capture(captured.card, connection, {
        identityTruth: captured.identityTruth,
        current: captured.current
      });
      mismatches.push(
        ...differingParts(undone, captured.before).map((part) => `undo:${part}`)
      );
      await this.writer.apply(captured.card, effects, connection);
      const redone = await this.reader.capture(captured.card, connection, {
        identityTruth: captured.identityTruth,
        current: captured.current
      });
      mismatches.push(
        ...differingParts(redone, after).map((part) => `redo:${part}`)
      );
      return {
        replay: mismatches.length ? 'mismatch' : 'match',
        replay_mismatches: mismatches
      };
    } catch (error) {
      logger.error(`[MINT_LOG_REPLAY_FAILED] ${errorText(error)}`);
      return { replay: 'mismatch', replay_mismatches: [errorText(error)] };
    } finally {
      try {
        await execute(`ROLLBACK TO SAVEPOINT ${REPLAY_SAVEPOINT}`);
      } catch (error) {
        // The transaction itself is gone (a deadlock rolls it back whole).
        // eslint-disable-next-line no-unsafe-finally
        throw new MintLogTransactionLost(errorText(error));
      }
    }
  }

  private entry<T>(
    spec: MintWriteSpec<T>,
    record: MintVerifiedRecord | null,
    captured: Captured,
    effects: MintCardEffects,
    head: MintLogHead,
    outcome: Outcome<T>,
    checks: Pick<MintLogChecks, 'replay' | 'replay_mismatches'>
  ): MintLogEntryBody {
    const declared = MINT_KIND_PARTS[spec.kind];
    return {
      v: MINT_LOG_ENTRY_VERSION,
      kind: spec.kind,
      chain: MINT_KIND_CHAIN[spec.kind],
      seq: head.seq + 1,
      prev: head.hash,
      at: Time.currentMillis(),
      card: captured.card,
      actor: spec.actor,
      record_id: record?.eventId ?? null,
      intent: {
        route: spec.intent.route,
        params: spec.intent.params,
        body: spec.intent.body ?? null
      },
      inputs: captured.inputs,
      outputs: outcome.ok && spec.outputs ? spec.outputs(outcome.value) : null,
      effects,
      checks: {
        undeclared: changedParts(effects).filter(
          (part) => !declared.includes(part)
        ),
        merkle_raw: (effects.merkle?.upsert ?? [])
          .filter((root) => root.raw_proofs !== null)
          .map((root) => String(root.row.phase)),
        replay: checks.replay,
        replay_mismatches: checks.replay_mismatches
      },
      writer_error: outcome.ok ? null : errorText(outcome.error)
    };
  }

  private async append(
    entry: MintLogEntryBody,
    record: MintVerifiedRecord | null,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const ports = this.ports();
    if (!ports.log) {
      throw new MintLogUnavailableException('no record log is bound');
    }
    const entries: MintRecordLogEntry[] = [];
    if (record && ports.records) {
      entries.push({
        t: 'event',
        lane: MINT_LOG_LANE,
        event: record.event,
        grant: await ports.records.grantProof(record)
      });
    }
    entries.push({
      t: 'entry',
      lane: MINT_LOG_LANE,
      chain: 'public',
      body: entry as unknown as Record<string, unknown>
    });
    await ports.log.append(entries, { connection });
    await this.head.advance(
      { seq: entry.seq, hash: entrySha256(entry) },
      connection,
      mintHeadKey(entry.chain, entry.card)
    );
  }

  /**
   * Alerts an entry's problems. Given the caller's connection (writeWithin),
   * the priority alert waits for the caller's commit, as a shadow failure's.
   */
  private async report(
    entry: MintLogEntryBody,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const problems = [
      ...entry.checks.undeclared.map((part) => `undeclared part ${part}`),
      ...entry.checks.merkle_raw.map((phase) => `raw proofs kept for ${phase}`),
      ...entry.checks.replay_mismatches.map((part) => `replay ${part}`)
    ];
    if (!problems.length) return;
    const card = entry.card ? cardLabel(entry.card) : 'none';
    const message = `[MINT_LOG_MISMATCH] [${entry.chain} ${entry.seq}] [${entry.kind}] [card ${card}] ${problems.join('; ')}`;
    if (connection) {
      await this.alertAfterCommit(message, connection);
      return;
    }
    await this.alert(message);
  }
}

export const mintLogRecorder = new MintLogRecorder();

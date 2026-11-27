import { afterCommitMark, dropAfterCommitSince } from '@/db/after-commit';
import { markProxySessionPinned } from '@/db/proxy-session-pinning';
import { Logger } from '@/logging';
import type { RequestContext } from '@/request.context';
import { sqlExecutor, type ConnectionWrapper } from '@/sql-executor';
import { distributionCursorBlock, latestTdhBlock } from './mint-log-inputs';
import { mintCard } from './mint-log-parts';
import { mintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import type { MintLogActor, MintLogKind } from './mint-log.types';

const logger = Logger.get('MINT_LOG_DROP_FORGE');

/** Drop Forge's worker: a service, acting on what an admin queued. */
const DROP_FORGE_ACTOR: MintLogActor = {
  type: 'service',
  wallet: null,
  authority: 'drop-forge'
};

function spec<T>(args: {
  readonly kind: MintLogKind;
  readonly contract: string;
  readonly claim: number;
  readonly step: string;
  readonly params?: Record<string, string>;
  readonly inputs?: MintWriteSpec<T>['inputs'];
}): MintWriteSpec<T> {
  return {
    kind: args.kind,
    card: mintCard(args.contract, args.claim),
    actor: DROP_FORGE_ACTOR,
    intent: {
      route: `Drop Forge ${args.step}`,
      params: {
        contract: args.contract.toLowerCase(),
        claim_id: String(args.claim),
        ...args.params
      },
      body: null
    },
    inputs: args.inputs,
    // Drop Forge's transactions run at the server's REPEATABLE READ. The
    // signer transaction takes its snapshot at its first plain read (find()
    // for a targeted tick, active() otherwise), after the signer and settings
    // locks but before the launch lock and the mint log's head; the job's
    // first plain read comes after the preparation lock today.
    readCurrent: true
  };
}

/**
 * A phase Drop Forge prepares in the background: the subscriptions' phase
 * columns, the phase's distribution rows and its merkle root and proofs,
 * logged as the phase split the route logs (dist.phase), with the same
 * inputs. The public phase has no allowlist results.
 */
export function dropForgePhaseSpec<T>(args: {
  readonly contract: string;
  readonly claim: number;
  readonly plan: string;
  readonly phase: string;
  readonly phaseName: string;
  readonly results: readonly { wallet: string; amount: number }[];
}): MintWriteSpec<T> {
  return spec<T>({
    kind: 'dist.phase',
    contract: args.contract,
    claim: args.claim,
    step: 'phase preparation',
    params: { allowlist_id: args.plan, phase_id: args.phase },
    inputs: async (connection) => ({
      allowlist_id: args.plan,
      phase_id: args.phase,
      phase_name: args.phaseName,
      tdh_block: await latestTdhBlock(connection),
      allowlist_results: args.results.map((result) => [
        result.wallet.toLowerCase(),
        result.amount
      ])
    })
  });
}

/** Drop Forge's finalize: the normalized rows, as the normalize route logs. */
export function dropForgeNormalizeSpec<T>(args: {
  readonly contract: string;
  readonly claim: number;
}): MintWriteSpec<T> {
  return spec<T>({
    kind: 'dist.normalize',
    contract: args.contract,
    claim: args.claim,
    step: 'finalize',
    // Minted counts restart from zero; mints after this block add to them.
    inputs: async (connection) => ({
      distribution_cursor_block: await distributionCursorBlock(connection)
    })
  });
}

/** A completion flag Drop Forge mirrors into the claim's actions. */
function dropForgeClaimActionSpec<T>(args: {
  readonly contract: string;
  readonly claim: number;
  readonly action: string;
}): MintWriteSpec<T> {
  return spec<T>({
    kind: 'claim.action',
    contract: args.contract,
    claim: args.claim,
    step: 'completion',
    params: { action: args.action }
  });
}

/**
 * Logs a Drop Forge write inside the transaction it already runs in, after
 * Drop Forge's own locks: the order every path takes is Drop Forge's locks,
 * then the mint log's head. A rollback of that transaction, or of the job's
 * savepoint, drops the entry with the rows. With the mint log off it only
 * runs the write, as Drop Forge did before the mint log.
 */
export async function logDropForgeWrite<T>(
  writeSpec: MintWriteSpec<T>,
  ctx: RequestContext,
  write: () => Promise<T>
): Promise<T> {
  if (mintLogRecorder.mode() === 'off') return write();
  if (!ctx.connection) {
    throw new Error(
      `Drop Forge logs ${writeSpec.kind} inside its own transaction; none was given`
    );
  }
  return mintLogRecorder.writeWithin(writeSpec, ctx.connection, write);
}

interface QueuedClaimAction {
  readonly contract: string;
  readonly claim: number;
  readonly action: string;
  readonly write: (ctx: RequestContext) => Promise<unknown>;
  /**
   * A held write that fails is undone on its own, with its mint log entry,
   * and this runs in the same transaction, which then goes on to commit.
   */
  readonly failed: (error: unknown) => Promise<void>;
}

interface ClaimActionQueue {
  readonly items: QueuedClaimAction[];
  closed: boolean;
}

/** Open queues, by the transaction they belong to. */
const claimActionQueues = new WeakMap<object, ClaimActionQueue>();

const CLAIM_ACTION_SAVEPOINT = 'drop_forge_claim_action';

/**
 * A misuse of the held writes (a second hold, a write queued too late). It
 * fails the whole transaction, never just one write. The prototype is set
 * by hand, as for MintApplyError, so `instanceof` holds when compiled to ES5.
 */
class ClaimActionHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimActionHoldError';
    Object.setPrototypeOf(this, ClaimActionHoldError.prototype);
  }
}

/** The transaction's own handle, as after-commit.ts keys it, not a wrapper. */
function queueKey(connection: ConnectionWrapper<any>): object {
  const handle = connection.connection;
  return handle && typeof handle === 'object' ? handle : connection;
}

/**
 * One held write under its own savepoint. If the write fails, or in primary
 * mode its mint log entry, the savepoint undoes the write, its entry and
 * the head's advance together (the next entry reads the head again under
 * its lock, so it takes the same seq), and the item's failed() runs. In
 * shadow mode a failed entry never gets here: the recorder undoes it in
 * its own savepoint and alerts, and the write stays, unlogged, as any
 * shadow write would. If the transaction is already gone (a deadlock rolls
 * it back whole), the savepoint is gone too, and the write's own error
 * goes up.
 */
async function writeHeld(
  item: QueuedClaimAction,
  ctx: RequestContext,
  connection: ConnectionWrapper<any>
): Promise<void> {
  const execute = (sql: string) =>
    sqlExecutor.execute(sql, undefined, { wrappedConnection: connection });
  await execute(`SAVEPOINT ${CLAIM_ACTION_SAVEPOINT}`);
  const mark = afterCommitMark(connection);
  try {
    await logDropForgeWrite(dropForgeClaimActionSpec(item), ctx, () =>
      item.write(ctx)
    );
  } catch (error) {
    if (error instanceof ClaimActionHoldError) throw error;
    await execute(`ROLLBACK TO SAVEPOINT ${CLAIM_ACTION_SAVEPOINT}`).catch(
      () => {
        throw error;
      }
    );
    // What the savepoint undid has no after-commit work left: a shadow
    // alert for a flag that is not written now is dropped with it.
    dropAfterCommitSince(connection, mark);
    await item.failed(error);
    return;
  }
  await execute(`RELEASE SAVEPOINT ${CLAIM_ACTION_SAVEPOINT}`);
}

/**
 * The lock-wait budget of one pass's held flags. While a flag waits for a
 * lock, the mint log's head mostly, the signer's and the launch's rows stay
 * locked. The head may be held by a phase step on another card or an
 * admin's phase split. 10 s is about 1.5 times the longest holder
 * measured: a phase step on a card with 4,000 allowlisted wallets held it
 * 6.5 s, finalize 6.3 s. The first flag may wait the whole budget, each
 * later one what is left of it, but at least
 * HELD_FLAG_MIN_LOCK_WAIT_SECONDS. A flag that gives up: in primary mode it
 * fails, is unmirrored and is written on a later pass; in shadow mode it
 * commits unlogged, and the mint log alerts.
 * This relies on innodb_rollback_on_timeout being OFF, MySQL's default: a
 * timeout then undoes only its statement, and the flag's savepoint the
 * rest. With it ON, a timeout rolls back the whole pass, as a deadlock
 * does, and the pass fails and runs again.
 */
export const HELD_FLAG_LOCK_WAIT_SECONDS = 10;

/** InnoDB's shortest lock wait: a later flag still tries the head once. */
export const HELD_FLAG_MIN_LOCK_WAIT_SECONDS = 1;

/**
 * Writes the held flags under one lock-wait budget. Before each flag the
 * session's lock wait is set to what is left of HELD_FLAG_LOCK_WAIT_SECONDS,
 * in whole seconds rounded up, never below the minimum and never above the
 * session's own value. A later flag then waits past the budget by less than
 * the minimum, so a pass waits for the head at most the budget plus the
 * minimum for each later flag. The session's own value is put back at the
 * end, so the signer's last UPDATE waits as before. A session variable set
 * by hand pins the connection's RDS Proxy session, so the connection's
 * handle is marked pinned. An API pool connection is then retired when the
 * request ends instead of being kept (proxy-session-pinning); a Lambda's
 * handle is a TypeORM query runner, where the mark has no effect, and its
 * connection ends with the invocation.
 */
async function writeHeldFlags(
  items: readonly QueuedClaimAction[],
  ctx: RequestContext,
  connection: ConnectionWrapper<any>
): Promise<void> {
  const options = { wrappedConnection: connection };
  const [row] = await sqlExecutor.execute<{ seconds: number | string }>(
    'SELECT @@SESSION.innodb_lock_wait_timeout AS seconds',
    undefined,
    options
  );
  const previous = Number(row?.seconds);
  if (!Number.isInteger(previous) || previous < 1) {
    for (const item of items) await writeHeld(item, ctx, connection);
    return;
  }
  const setWait = (seconds: number) =>
    sqlExecutor.execute(
      'SET SESSION innodb_lock_wait_timeout = :seconds',
      { seconds },
      options
    );
  const deadline = Date.now() + HELD_FLAG_LOCK_WAIT_SECONDS * 1000;
  let current = previous;
  try {
    for (const item of items) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const seconds = Math.min(
        previous,
        Math.max(HELD_FLAG_MIN_LOCK_WAIT_SECONDS, left)
      );
      if (seconds !== current) {
        await setWait(seconds);
        current = seconds;
        const handle = connection.connection;
        if (handle && typeof handle === 'object') {
          markProxySessionPinned(handle, { reason: 'session_settings' });
        }
      }
      await writeHeld(item, ctx, connection);
    }
  } finally {
    if (current !== previous) {
      await setWait(previous).catch((error) =>
        logger.error(
          `[DROP_FORGE_LOCK_WAIT_NOT_RESTORED] the session's lock wait stays at ${current} s: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
}

/**
 * The most completion flags one signer pass holds. Each costs its captures
 * and may wait for the head, with the signer's rows locked; a flag past
 * this waits for the next pass, which the launch gets before it completes.
 */
export const HELD_FLAGS_PER_PASS = 2;

/**
 * Runs `fn` in Drop Forge's signer transaction with its claim-action writes
 * held back, then writes them, each logged, before returning, so the
 * caller commits them with the rest. The mint log's head is then taken only
 * at the end, after every chain call `fn` makes. Each held write runs under
 * its own savepoint: one that fails is undone alone and reported through its
 * failed(), and the rest of the transaction commits. A write queued while
 * the held ones are being written throws, so none is committed unwritten
 * and unreported. After the hold ends, a write goes ahead at once.
 *
 * With the mint log off nothing is held: `fn` runs as it did before the
 * mint log, and each flag is written where it is mirrored.
 */
export async function withDropForgeClaimActions<T>(
  ctx: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  if (mintLogRecorder.mode() === 'off') return fn();
  const connection = ctx.connection;
  if (!connection) {
    throw new Error('Drop Forge holds claim actions only inside a transaction');
  }
  const key = queueKey(connection);
  if (claimActionQueues.has(key)) {
    // One queue per transaction: a second would hide the first's flags.
    throw new ClaimActionHoldError(
      'Drop Forge already holds claim actions for this transaction'
    );
  }
  const queue: ClaimActionQueue = { items: [], closed: false };
  claimActionQueues.set(key, queue);
  try {
    const value = await fn();
    queue.closed = true;
    if (queue.items.length) {
      await writeHeldFlags(queue.items, ctx, connection);
    }
    return value;
  } finally {
    queue.closed = true;
    claimActionQueues.delete(key);
  }
}

/**
 * What became of a completion flag's write: held to the end of the signer
 * transaction, left for the next pass (the pass already holds
 * HELD_FLAGS_PER_PASS), or written now.
 */
export type ClaimActionWrite = 'held' | 'deferred' | 'written';

/**
 * A completion flag's write: held back to the end of the signer transaction
 * when one is open (withDropForgeClaimActions), otherwise written and
 * logged at once, in the caller's transaction or in its own. A flag the
 * pass has no room for is not written; the caller leaves it unmirrored.
 */
export async function writeDropForgeClaimAction(
  ctx: RequestContext,
  item: QueuedClaimAction
): Promise<ClaimActionWrite> {
  const queue = ctx.connection
    ? claimActionQueues.get(queueKey(ctx.connection))
    : undefined;
  if (queue) {
    if (queue.closed) {
      throw new ClaimActionHoldError(
        `Claim action ${item.action} queued after the transaction's claim actions were written`
      );
    }
    if (queue.items.length >= HELD_FLAGS_PER_PASS) {
      logger.info(
        `[DROP_FORGE_FLAG_DEFERRED] [${item.contract.toLowerCase()} ${item.claim}] [${item.action}] waits for the next pass`
      );
      return 'deferred';
    }
    queue.items.push(item);
    return 'held';
  }
  if (ctx.connection) {
    await logDropForgeWrite(dropForgeClaimActionSpec(item), ctx, () =>
      item.write(ctx)
    );
    return 'written';
  }
  await mintLogRecorder.write(dropForgeClaimActionSpec(item), () =>
    item.write(ctx)
  );
  return 'written';
}

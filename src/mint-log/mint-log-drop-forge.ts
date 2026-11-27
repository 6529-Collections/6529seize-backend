import { Logger } from '@/logging';
import type { RequestContext } from '@/request.context';
import { sqlExecutor, type ConnectionWrapper } from '@/sql-executor';
import { distributionCursorBlock, latestTdhBlock } from './mint-log-inputs';
import { mintCard } from './mint-log-parts';
import { mintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import type { MintLogActor, MintLogKind } from './mint-log.types';

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
 * savepoint, drops the entry with the rows.
 */
export async function logDropForgeWrite<T>(
  writeSpec: MintWriteSpec<T>,
  ctx: RequestContext,
  write: () => Promise<T>
): Promise<T> {
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
    await item.failed(error);
    return;
  }
  await execute(`RELEASE SAVEPOINT ${CLAIM_ACTION_SAVEPOINT}`);
}

const logger = Logger.get('MINT_LOG_DROP_FORGE');

/**
 * How long a held flag's statements wait for a lock, the mint log's head
 * first, before they give up. The signer's and the launch's rows stay
 * locked meanwhile, and the head may be held by a phase step on another
 * card or an admin's phase split. Primary: the flag fails, is unmirrored
 * and is written on a later pass. Shadow: it commits unlogged, and the mint
 * log alerts.
 */
export const HELD_FLAG_LOCK_WAIT_SECONDS = 15;

/**
 * Runs `fn` with the connection's lock wait cut to
 * HELD_FLAG_LOCK_WAIT_SECONDS (never raised), then puts the session's own
 * value back, so the signer's last UPDATE and the pooled connection's next
 * user wait as before.
 */
async function withHeldFlagLockWait<T>(
  connection: ConnectionWrapper<any>,
  fn: () => Promise<T>
): Promise<T> {
  const options = { wrappedConnection: connection };
  const [row] = await sqlExecutor.execute<{ seconds: number | string }>(
    'SELECT @@SESSION.innodb_lock_wait_timeout AS seconds',
    undefined,
    options
  );
  const previous = Number(row?.seconds);
  if (!Number.isInteger(previous) || previous < 1) return fn();
  await sqlExecutor.execute(
    'SET SESSION innodb_lock_wait_timeout = :seconds',
    { seconds: Math.min(previous, HELD_FLAG_LOCK_WAIT_SECONDS) },
    options
  );
  try {
    return await fn();
  } finally {
    await sqlExecutor
      .execute(
        'SET SESSION innodb_lock_wait_timeout = :seconds',
        { seconds: previous },
        options
      )
      .catch((error) =>
        logger.error(
          `[DROP_FORGE_LOCK_WAIT_NOT_RESTORED] the session's lock wait stays at ${HELD_FLAG_LOCK_WAIT_SECONDS} s: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }
}

/**
 * Runs `fn` in Drop Forge's signer transaction with its claim-action writes
 * held back, then writes them, each logged, before returning, so the
 * caller commits them with the rest. The mint log's head is then taken only
 * at the end, after every chain call `fn` makes. Each held write runs under
 * its own savepoint: one that fails is undone alone and reported through its
 * failed(), and the rest of the transaction commits. A write queued while
 * the held ones are being written throws, so none is committed unwritten
 * and unreported. After the hold ends, a write goes ahead at once.
 */
export async function withDropForgeClaimActions<T>(
  ctx: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
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
      await withHeldFlagLockWait(connection, async () => {
        for (const item of queue.items) {
          await writeHeld(item, ctx, connection);
        }
      });
    }
    return value;
  } finally {
    queue.closed = true;
    claimActionQueues.delete(key);
  }
}

/**
 * A completion flag's write: held back to the end of the signer transaction
 * when one is open (withDropForgeClaimActions), otherwise written and
 * logged at once, in the caller's transaction or in its own.
 */
export async function writeDropForgeClaimAction(
  ctx: RequestContext,
  item: QueuedClaimAction
): Promise<void> {
  const queue = ctx.connection
    ? claimActionQueues.get(queueKey(ctx.connection))
    : undefined;
  if (queue) {
    if (queue.closed) {
      throw new ClaimActionHoldError(
        `Claim action ${item.action} queued after the transaction's claim actions were written`
      );
    }
    queue.items.push(item);
    return;
  }
  if (ctx.connection) {
    await logDropForgeWrite(dropForgeClaimActionSpec(item), ctx, () =>
      item.write(ctx)
    );
    return;
  }
  await mintLogRecorder.write(dropForgeClaimActionSpec(item), () =>
    item.write(ctx)
  );
}

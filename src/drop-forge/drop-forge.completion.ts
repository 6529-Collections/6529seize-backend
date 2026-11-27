import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { isSupportedMintingClaimActionType } from '@/minting-claims/minting-claim-actions';
import {
  ClaimActionWrite,
  writeDropForgeClaimAction
} from '@/mint-log/mint-log-drop-forge';
import {
  addLaunchEvent,
  type DropForgeRepository
} from '@/drop-forge/drop-forge.repository';
import { Logger } from '@/logging';
import { MINTING_CLAIM_ACTIONS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { mintLogRecorder } from '@/mint-log/mint-log-recorder';
import { randomUUID } from 'node:crypto';

const logger = Logger.get('DROP_FORGE_COMPLETION');

/** Saves the launch record in the caller's transaction. */
type SaveLaunch = (record: LaunchRecord, ctx: RequestContext) => Promise<void>;

/** A short reason for an operator: the database error code, not its SQL. */
function failureReason(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  if (typeof code === 'string' && code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 120);
}

/**
 * The start of a flag's first event, to raise it once per flag. With the
 * mint log on, it is also how a later pass knows the flag was missed
 * (firstMiss): keep this wording, or existing misses are no longer seen.
 */
const failedFlagEvent = (flag: string) =>
  `completion flag ${flag} was not written`;

/** The start of the one alert for a flag still unwritten after the set time. */
const unwrittenFlagAlert = (flag: string) =>
  `completion flag ${flag} is still not written`;

/**
 * How long a flag may stay unwritten, retried on each delivery, before an
 * event asks an operator for it.
 */
export const FLAG_ALERT_AFTER_MS = 10 * 60 * 1000;

/**
 * How an operator sets the flag by hand: the claim action route
 * (api.minting-claims.actions.routes.ts), with its two body fields and,
 * in primary mode, the admin's signed record the route needs.
 */
const setFlagByHand = (record: LaunchRecord, flag: string) =>
  `POST /api/minting-claims/actions/${record.data.contract}/${record.data.claim_id} with {"action":"${flag}","completed":true}, as a claims admin (in primary mode with the admin's signed record, x-6529-signed-records)`;

/**
 * A flag that a pass didn't write (with the mint log on: it failed, or the
 * pass already held its two) is bookkeeping, not chain safety. It is left
 * unmirrored, and a later pass writes it, the same delivery's next one or a
 * later delivery's, whatever the launch's state (hasUnwrittenFlags keeps
 * the deliveries coming). Its first
 * miss posts one plain event in the launch's reports; if the launch still
 * lacks it FLAG_ALERT_AFTER_MS later, one error with the alert mention asks
 * for it by hand (a retry then finds the row and leaves it). The rest of
 * the transaction, reservations and sent actions included, commits.
 */
async function flagNotWritten(
  record: LaunchRecord,
  flag: string,
  reason: string,
  ctx: RequestContext,
  save: SaveLaunch
): Promise<void> {
  const completed = record.data.completion_flags ?? [];
  record.data.completion_flags = completed.filter((it) => it !== flag);
  if (!firstMiss(record, flag)) {
    addLaunchEvent(
      record,
      `Claim #${record.data.claim_id}: ${failedFlagEvent(flag)} (${reason}); Drop Forge writes it again on a later pass.`
    );
  } else {
    alertIfOverdue(record, flag);
  }
  await save(record, ctx);
}

/** The flag's first-miss event on the launch, if a pass ever missed it. */
function firstMiss(record: LaunchRecord, flag: string) {
  return record.data.events.find((event) =>
    event.content.includes(failedFlagEvent(flag))
  );
}

/**
 * Adds the one alert for a flag still unwritten FLAG_ALERT_AFTER_MS after
 * its first miss. Returns whether it did.
 */
function alertIfOverdue(record: LaunchRecord, flag: string): boolean {
  const first = firstMiss(record, flag);
  if (
    !first ||
    Date.now() - first.at < FLAG_ALERT_AFTER_MS ||
    record.data.events.some((event) =>
      event.content.includes(unwrittenFlagAlert(flag))
    )
  )
    return false;
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: ${unwrittenFlagAlert(flag)} ${FLAG_ALERT_AFTER_MS / 60_000} minutes after it was first missed; set it by hand: ${setFlagByHand(record, flag)}.`,
    true
  );
  return true;
}

async function flagFailed(
  record: LaunchRecord,
  flag: string,
  error: unknown,
  ctx: RequestContext,
  save: SaveLaunch
): Promise<void> {
  const reason = failureReason(error);
  logger.error(
    `[DROP_FORGE_FLAG_FAILED] [launch ${record.id}] [${flag}] ${reason}`
  );
  await flagNotWritten(record, flag, reason, ctx, save);
}

/**
 * A flag's row, written only where the claim has none: an admin's row for
 * it, set or unset (the claim action route upserts a row with completed
 * false to unset, api.minting-claims.actions.routes.ts; nothing deletes
 * one), stays as it is. Used for every retry of a flag.
 */
export const completionFlagRows = {
  async insertIfAbsent(
    row: {
      readonly contract: string;
      readonly claim_id: number;
      readonly action: string;
      readonly wallet: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    const wallet = row.wallet.toLowerCase();
    await sqlExecutor.execute(
      `insert into ${MINTING_CLAIM_ACTIONS_TABLE}
         (id, contract, claim_id, action, completed, created_by_wallet, updated_by_wallet, created_at, updated_at)
       values (:id, :contract, :claim_id, :action, true, :wallet, :wallet, :now, :now)
       on duplicate key update id = id`,
      {
        id: randomUUID(),
        contract: row.contract.toLowerCase(),
        claim_id: row.claim_id,
        action: row.action,
        wallet,
        now
      },
      { wrappedConnection: ctx.connection }
    );
  }
};

function flagsForLabel(label: string, separatePublic: boolean): string[] {
  switch (label) {
    case 'Pay Artist':
      return ['PAY_ARTIST'];
    case 'Airdrop - Artist':
      return ['ARTIST_AIRDROP'];
    case 'Airdrop - Team':
      return ['TEAM_AIRDROP'];
    case 'Research airdrop':
      return ['RESEARCH_AIRDROP'];
    default: {
      if (label.toLowerCase().includes('public'))
        return ['PUBLIC_PHASE_AIRDROP'];
      const phase = /phase\s*(\d)/i.exec(label)?.[1];
      if (!phase) return [];
      const flags = [`PHASE${phase}_AIRDROP`];
      if (phase === '2' && !separatePublic) flags.push('PUBLIC_PHASE_AIRDROP');
      return flags;
    }
  }
}

function completedFlags(record: LaunchRecord): string[] {
  const groups = new Map<string, boolean>();
  for (const action of record.data.actions) {
    if (action.kind === 'PAY_ARTIST' && action.state === 'CONFIRMED')
      groups.set('Pay Artist', true);
    if (action.kind !== 'AIRDROP' || !action.label) continue;
    groups.set(
      action.label,
      (groups.get(action.label) ?? true) &&
        action.state === 'CONFIRMED' &&
        !action.unfilled_tokens
    );
  }
  return Array.from(groups)
    .filter(([, completed]) => completed)
    .flatMap(([label]) =>
      flagsForLabel(label, !!record.data.separate_public_airdrops)
    );
}

/**
 * The flags a pass missed (its "was not written" event is on the launch)
 * and no pass has written since: a completed group's supported flag that
 * isn't in completion_flags. Read from the launch record alone, so a
 * launch's other missing flags (one from before this change) stay as on
 * main.
 */
function unwrittenFlags(record: LaunchRecord): string[] {
  const completed = record.data.completion_flags ?? [];
  return completedFlags(record).filter(
    (flag) =>
      !completed.includes(flag) &&
      isSupportedMintingClaimActionType(record.data.contract, flag) &&
      !!firstMiss(record, flag)
  );
}

export function hasUnwrittenFlags(record: LaunchRecord): boolean {
  return unwrittenFlags(record).length > 0;
}

/**
 * With the mint log on, adds the one alert for each flag still unwritten
 * FLAG_ALERT_AFTER_MS after its first miss, even when no pass gets to try
 * it (another launch holds the signer, or a manual transaction isn't
 * confirmed yet). Returns whether it added one. The launch handler calls
 * it on each delivery.
 */
function alertOverdueFlags(record: LaunchRecord): boolean {
  if (mintLogRecorder.mode() === 'off') return false;
  let added = false;
  for (const flag of unwrittenFlags(record))
    added = alertIfOverdue(record, flag) || added;
  return added;
}

/**
 * The launch handler's step, on each delivery: with the mint log on, reads
 * the launch and, only when an alert is due, adds it (alertOverdueFlags).
 * With the mint log off it reads nothing.
 */
export async function alertOverdueLaunchFlags(
  id: string,
  repository: Pick<DropForgeRepository, 'find' | 'change'>
): Promise<void> {
  if (mintLogRecorder.mode() === 'off') return;
  const launch = await repository.find(id, {});
  if (!launch || !alertOverdueFlags(launch)) return;
  await repository.change(
    id,
    async (latest) => {
      alertOverdueFlags(latest);
    },
    {}
  );
}

/** How a pass writes its flags: all of them, or only the missed ones. */
interface MirrorOptions {
  /** A later delivery's retry: only flags a pass missed before. */
  readonly missedOnly?: boolean;
}

/**
 * Whether this write of the flag is a retry, with the mint log on: one of
 * a flag that a pass missed before, as its event on the launch shows. A
 * retry never overwrites the claim's row; a first write upserts, as a
 * mirror always has. A flag the pass deferred gets its event at once, so
 * its first actual write is a retry too.
 */
function isRetry(record: LaunchRecord, flag: string): boolean {
  return mintLogRecorder.mode() !== 'off' && !!firstMiss(record, flag);
}

async function mirrorFlags(
  record: LaunchRecord,
  flags: string[],
  ctx: RequestContext,
  save: SaveLaunch,
  options: MirrorOptions,
  index = 0,
  pending = false
): Promise<boolean> {
  if (index >= flags.length) return pending;
  const flag = flags[index];
  const completed = record.data.completion_flags!;
  let outcome: ClaimActionWrite | null = null;
  if (
    !completed.includes(flag) &&
    isSupportedMintingClaimActionType(record.data.contract, flag) &&
    (!options.missedOnly || !!firstMiss(record, flag))
  ) {
    // With the mint log on, held back to the end of the signer transaction,
    // then logged (writeDropForgeClaimAction); with it off, written now.
    const row = {
      contract: record.data.contract,
      claim_id: record.data.claim_id,
      action: flag,
      wallet: record.data.signer
    };
    const retry = isRetry(record, flag);
    outcome = await writeDropForgeClaimAction(ctx, {
      contract: record.data.contract,
      claim: record.data.claim_id,
      action: flag,
      write: (txCtx) =>
        retry
          ? completionFlagRows.insertIfAbsent(row, txCtx)
          : mintingClaimActionsDb.upsertAction(
              { ...row, completed: true },
              txCtx
            ),
      failed: (error) => flagFailed(record, flag, error, ctx, save)
    });
    // A deferred flag stays unmirrored, for a later delivery.
    if (outcome === 'deferred') {
      await flagNotWritten(
        record,
        flag,
        'the pass already holds two flags',
        ctx,
        save
      );
    } else {
      completed.push(flag);
    }
  }
  return mirrorFlags(
    record,
    flags,
    ctx,
    save,
    options,
    index + 1,
    pending || outcome === 'held' || outcome === 'deferred'
  );
}

/**
 * Mirrors the launch's completed actions into the claim's action flags.
 * With the mint log on, in the signer transaction the writes are held to
 * its end; `save` stores the launch record again if one of them fails
 * there. Returns whether a flag is still to be written: held to the end of
 * this pass, or left for the next one. With the mint log off every flag is
 * written here, and it returns false.
 */
export async function mirrorCompletion(
  record: LaunchRecord,
  ctx: RequestContext,
  save: SaveLaunch,
  options: MirrorOptions = {}
): Promise<boolean> {
  record.data.completion_flags ??= [];
  return mirrorFlags(record, completedFlags(record), ctx, save, options);
}

import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { isSupportedMintingClaimActionType } from '@/minting-claims/minting-claim-actions';
import { writeDropForgeClaimAction } from '@/mint-log/mint-log-drop-forge';
import { addLaunchEvent } from '@/drop-forge/drop-forge.repository';
import { Logger } from '@/logging';

const logger = Logger.get('DROP_FORGE_COMPLETION');

/** Saves the launch record in the caller's transaction. */
type SaveLaunch = (record: LaunchRecord, ctx: RequestContext) => Promise<void>;

/** A short reason for an operator: the database error code, not its SQL. */
function failureReason(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  if (code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 120);
}

/** The start of a flag failure's event, to raise it once per flag. */
const failedFlagEvent = (flag: string) =>
  `completion flag ${flag} was not written`;

/**
 * How an operator sets the flag by hand: the claim action route
 * (api.minting-claims.actions.routes.ts), with its two body fields and,
 * in primary mode, the admin's signed record the route needs.
 */
const setFlagByHand = (record: LaunchRecord, flag: string) =>
  `POST /api/minting-claims/actions/${record.data.contract}/${record.data.claim_id} with {"action":"${flag}","completed":true}, as a claims admin (in primary mode with the admin's signed record, x-6529-signed-records)`;

/**
 * A flag that failed to write is bookkeeping, not chain safety: it is left
 * unmirrored, so the next pass that mirrors the launch writes it again, and
 * its first failure shows as a warning event in the launch's reports. The
 * rest of the transaction, reservations and sent actions included, commits.
 * A running launch isn't completed while it has a flag to write (the
 * worker's reserve), so it gets that pass; one that has ended doesn't, and
 * its event says how to set the flag by hand.
 */
async function flagFailed(
  record: LaunchRecord,
  flag: string,
  error: unknown,
  ctx: RequestContext,
  save: SaveLaunch
): Promise<void> {
  const completed = record.data.completion_flags ?? [];
  record.data.completion_flags = completed.filter((it) => it !== flag);
  const reason = failureReason(error);
  logger.error(
    `[DROP_FORGE_FLAG_FAILED] [launch ${record.id}] [${flag}] ${reason}`
  );
  const raised = record.data.events.some((event) =>
    event.content.includes(failedFlagEvent(flag))
  );
  if (!raised) {
    const ended = record.state === 'COMPLETED' || record.state === 'CANCELLED';
    addLaunchEvent(
      record,
      `Claim #${record.data.claim_id}: ${failedFlagEvent(flag)} (${reason}); ` +
        (ended
          ? `the launch has ended, so set it by hand: ${setFlagByHand(record, flag)}.`
          : `Drop Forge writes it again on a later pass, before the launch completes. If the launch ends first, set it by hand: ${setFlagByHand(record, flag)}.`),
      true
    );
  }
  await save(record, ctx);
}

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

async function mirrorFlags(
  record: LaunchRecord,
  flags: string[],
  ctx: RequestContext,
  save: SaveLaunch,
  index = 0,
  mirrored = false
): Promise<boolean> {
  if (index >= flags.length) return mirrored;
  const flag = flags[index];
  const completed = record.data.completion_flags!;
  const write =
    !completed.includes(flag) &&
    isSupportedMintingClaimActionType(record.data.contract, flag);
  if (write) {
    // Held back to the end of the signer transaction, then logged in the
    // mint log (writeDropForgeClaimAction).
    await writeDropForgeClaimAction(ctx, {
      contract: record.data.contract,
      claim: record.data.claim_id,
      action: flag,
      write: (txCtx) =>
        mintingClaimActionsDb.upsertAction(
          {
            contract: record.data.contract,
            claim_id: record.data.claim_id,
            action: flag,
            completed: true,
            wallet: record.data.signer
          },
          txCtx
        ),
      failed: (error) => flagFailed(record, flag, error, ctx, save)
    });
    completed.push(flag);
  }
  return mirrorFlags(record, flags, ctx, save, index + 1, mirrored || write);
}

/**
 * Mirrors the launch's completed actions into the claim's action flags.
 * In the signer transaction the writes are held to its end; `save` stores
 * the launch record again if one of them fails there. Returns whether it
 * wrote or held any flag.
 */
export async function mirrorCompletion(
  record: LaunchRecord,
  ctx: RequestContext,
  save: SaveLaunch
): Promise<boolean> {
  record.data.completion_flags ??= [];
  return mirrorFlags(record, completedFlags(record), ctx, save);
}

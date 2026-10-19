import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { isSupportedMintingClaimActionType } from '@/minting-claims/minting-claim-actions';

function flagsForLabel(label: string): string[] {
  switch (label) {
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
      if (phase === '2') flags.push('PUBLIC_PHASE_AIRDROP');
      return flags;
    }
  }
}

function completedFlags(record: LaunchRecord): string[] {
  const groups = new Map<string, boolean>();
  for (const action of record.data.actions) {
    if (action.kind !== 'AIRDROP' || !action.label) continue;
    groups.set(
      action.label,
      (groups.get(action.label) ?? true) && action.state === 'CONFIRMED'
    );
  }
  return Array.from(groups)
    .filter(([, completed]) => completed)
    .flatMap(([label]) => flagsForLabel(label));
}

async function mirrorFlags(
  record: LaunchRecord,
  flags: string[],
  ctx: RequestContext,
  index = 0
): Promise<void> {
  if (index >= flags.length) return;
  const flag = flags[index];
  const completed = record.data.completion_flags!;
  if (
    !completed.includes(flag) &&
    isSupportedMintingClaimActionType(record.data.contract, flag)
  ) {
    await mintingClaimActionsDb.upsertAction(
      {
        contract: record.data.contract,
        claim_id: record.data.claim_id,
        action: flag,
        completed: true,
        wallet: record.data.signer
      },
      ctx
    );
    completed.push(flag);
  }
  return mirrorFlags(record, flags, ctx, index + 1);
}

export async function mirrorCompletion(
  record: LaunchRecord,
  ctx: RequestContext
): Promise<void> {
  record.data.completion_flags ??= [];
  await mirrorFlags(record, completedFlags(record), ctx);
}

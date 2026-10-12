import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { isSupportedMintingClaimActionType } from '@/minting-claims/minting-claim-actions';
export async function mirrorCompletion(
  record: LaunchRecord,
  ctx: RequestContext
): Promise<void> {
  const groups = new Map<string, boolean>();
  for (const action of record.data.actions.filter(
    (it) => it.kind === 'AIRDROP' && it.label
  )) {
    const label = action.label!;
    groups.set(
      label,
      (groups.get(label) ?? true) && action.state === 'CONFIRMED'
    );
  }
  record.data.completion_flags ??= [];
  for (const [label, completed] of Array.from(groups)) {
    if (!completed) continue;
    let flags: string[] = [];
    if (label === 'Airdrop - Artist') flags = ['ARTIST_AIRDROP'];
    else if (label === 'Airdrop - Team') flags = ['TEAM_AIRDROP'];
    else if (label === 'Research airdrop') flags = ['RESEARCH_AIRDROP'];
    else if (label.toLowerCase().includes('public'))
      flags = ['PUBLIC_PHASE_AIRDROP'];
    else {
      const phase = /phase\s*(\d)/i.exec(label)?.[1];
      if (phase)
        flags = [
          `PHASE${phase}_AIRDROP`,
          ...(phase === '2' ? ['PUBLIC_PHASE_AIRDROP'] : [])
        ];
    }
    for (const flag of flags) {
      if (
        record.data.completion_flags.includes(flag) ||
        !isSupportedMintingClaimActionType(record.data.contract, flag)
      )
        continue;
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
      record.data.completion_flags.push(flag);
    }
  }
}

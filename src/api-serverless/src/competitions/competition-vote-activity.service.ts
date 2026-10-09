import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionVoteActivityRepository } from '@/competitions/competition-vote-activity.repository';
import { CompetitionStorageMode } from '@/entities/ICompetition';
import { dropsService } from '@/api/drops/drops.api.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiWaveLog } from '@/api/generated/models/ApiWaveLog';
import { PageSortDirection } from '@/api/page-request';
import { RequestContext } from '@/request.context';
import { NotFoundException } from '@/exceptions';

export async function listCompetitionVoteActivity(
  waveId: string,
  competitionId: string,
  offset: number,
  limit: number,
  ctx: RequestContext
): Promise<ApiWaveLog[]> {
  // The competition service masks invisible waves, drafts and mismatched children.
  const competition = await competitionService.getCompetition(
    waveId,
    competitionId,
    ctx
  );
  const record = await competitionRepository.findCompetitionRecordById(
    competitionId,
    ctx
  );
  if (!record || record.wave_id !== waveId)
    throw new NotFoundException('Competition not found');
  if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER) {
    // Exactly one legacy adapter exists per wave. Native competition commands
    // write their own history, never DROP_VOTE_EDIT wave logs.
    return dropsService.findWaveLogs(
      {
        wave_id: waveId,
        offset,
        limit,
        drop_id: null,
        log_types: ['DROP_VOTE_EDIT'],
        sort_direction: PageSortDirection.DESC
      },
      ctx
    );
  }
  const transferredAt = competition.legacy_transferred_at;
  const rows =
    record.legacy_wave_id === waveId && transferredAt != null
      ? await competitionVoteActivityRepository.listTransferred(
          competitionId,
          waveId,
          transferredAt,
          offset,
          limit,
          ctx
        )
      : await competitionVoteActivityRepository.list(
          competitionId,
          offset,
          limit,
          ctx
        );
  const profiles = await identityFetcher.getOverviewsByIds(
    Array.from(
      new Set(
        rows.flatMap((row) =>
          [row.voter_profile_id, row.submitter_id, row.proxy_id].filter(
            (id): id is string => !!id
          )
        )
      )
    ),
    ctx
  );
  return rows.map((row) => ({
    id: row.legacy_id ?? `${competitionId}:${Number(row.sequence)}`,
    action: 'DROP_VOTE_EDIT',
    wave_id: waveId,
    drop_id: row.drop_id,
    invoker: profiles[row.voter_profile_id],
    drop_author: row.submitter_id ? profiles[row.submitter_id] : undefined,
    invoker_proxy: row.proxy_id ? profiles[row.proxy_id] : undefined,
    created_at: new Date(Number(row.occurred_at)),
    contents: row.legacy_id
      ? JSON.parse(row.legacy_contents!)
      : {
          oldVote: Number(row.previous_value),
          newVote: Number(row.value)
        }
  }));
}

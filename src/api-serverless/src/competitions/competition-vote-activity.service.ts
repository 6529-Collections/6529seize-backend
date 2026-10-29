import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionVoteActivityRepository } from '@/competitions/competition-vote-activity.repository';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiWaveLog } from '@/api/generated/models/ApiWaveLog';
import { RequestContext } from '@/request.context';
import { NotFoundException } from '@/exceptions';
import {
  anonymousCompetitionAuthor,
  competitionAnonymityService
} from '@/competitions/competition-anonymity';

export async function listCompetitionVoteActivity(
  waveId: string,
  competitionId: string,
  offset: number,
  limit: number,
  ctx: RequestContext
): Promise<ApiWaveLog[]> {
  // The competition service masks invisible waves, drafts and mismatched children.
  await competitionService.getCompetition(waveId, competitionId, ctx);
  const record = await competitionRepository.findCompetitionRecordById(
    competitionId,
    ctx
  );
  if (!record || record.wave_id !== waveId)
    throw new NotFoundException('Competition not found');
  const rows = await competitionVoteActivityRepository.list(
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
  const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
    rows.map((row) => row.drop_id).filter((id): id is string => !!id),
    ctx
  );
  return rows.map((row) => {
    const author = row.submitter_id ? profiles[row.submitter_id] : undefined;
    const publicAuthor =
      author && row.drop_id && hiddenDropIds.has(row.drop_id)
        ? anonymousCompetitionAuthor(author, row.drop_id)
        : author;
    return {
      id: row.legacy_id ?? `${competitionId}:${row.sequence}`,
      action: 'DROP_VOTE_EDIT',
      wave_id: waveId,
      drop_id: row.drop_id,
      invoker: profiles[row.voter_profile_id],
      drop_author: publicAuthor,
      invoker_proxy: row.proxy_id ? profiles[row.proxy_id] : undefined,
      // Retained shared logs can contain NULL despite the frozen API's Date type.
      // Keep their original wire value without changing that published contract.
      created_at:
        row.legacy_id != null && row.legacy_created_at === null
          ? (null as unknown as ApiWaveLog['created_at'])
          : new Date(Number(row.occurred_at)),
      // The retained contents column is NOT NULL JSON, validated by MySQL.
      // Preserve its complete original payload, as the legacy log API does.
      contents: row.legacy_contents
        ? JSON.parse(row.legacy_contents)
        : {
            oldVote: Number(row.previous_value),
            newVote: Number(row.value)
          }
    };
  });
}

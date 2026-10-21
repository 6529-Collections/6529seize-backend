import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import type { Competition } from '@/competitions/competition.types';
import { CompetitionCapability } from '@/entities/ICompetition';
import type { RequestContext } from '@/request.context';
import { memeCollaborationsService } from './meme-collaborations.service';

/** Freeze consent before publishing a completed designated Main Stage decision. */
export async function freezeMemeCollaborationForNativeDecision(
  decision: {
    readonly competition: Pick<Competition, 'id' | 'capabilities'>;
    readonly winners: readonly { rank: number; drop_id: string }[];
    readonly skipped: boolean;
  },
  ctx: RequestContext
): Promise<void> {
  if (
    decision.skipped ||
    !decision.competition.capabilities.includes(
      CompetitionCapability.MAIN_STAGE
    )
  )
    return;
  if (
    !(await competitionMainStageRepository.isDesignated(
      decision.competition.id,
      ctx
    ))
  )
    return;
  const nextMint = decision.winners.find((winner) => winner.rank === 1);
  if (nextMint)
    await memeCollaborationsService.freezeForMint(nextMint.drop_id, ctx);
}

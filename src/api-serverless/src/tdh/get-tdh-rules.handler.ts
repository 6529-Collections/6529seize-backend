import { ApiTdhRules } from '@/api/generated/models/ApiTdhRules';
import { ApiTdhSeasonOnePartialKey } from '@/api/generated/models/ApiTdhSeasonOnePartialKey';
import { GetTdhRulesRequest } from '@/api/generated/routes/operations';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { getAdjustedSeasons, getTdhBoostRules } from '@/tdhLoop/tdh-rules';
import { tdhRulesDb } from './api.tdh-rules.db';

export async function handleGetTdhRules(
  req: GetTdhRulesRequest
): Promise<ApiTdhRules> {
  const ctx: RequestContext = { timer: Timer.getFromRequest(req) };
  const [snapshot, seasons] = await Promise.all([
    tdhRulesDb.getLatestCompletedSnapshot(ctx),
    tdhRulesDb.getSeasonDefinitions(ctx)
  ]);

  if (!snapshot) {
    throw new NotFoundException('No completed TDH snapshot found');
  }

  const eligibleMemesCount = Number(snapshot.eligible_memes_count);
  const adjustedSeasons = getAdjustedSeasons(seasons, eligibleMemesCount);
  const rules = getTdhBoostRules(adjustedSeasons);

  return {
    snapshot: {
      block_number: snapshot.block_number,
      block_timestamp: snapshot.block_timestamp,
      eligible_memes_count: eligibleMemesCount
    },
    boost: {
      base_multiplier: rules.baseMultiplier,
      final_rounding_decimals: rules.finalRoundingDecimals,
      season_schedule: {
        bonus_per_season: rules.seasonSchedule.bonusPerSeason,
        last_boosted_season: rules.seasonSchedule.lastBoostedSeason,
        max_bonus: rules.seasonSchedule.maxBonus
      },
      season_sets: rules.seasonSets.map((season) => ({
        season: season.season,
        start_index: season.startIndex,
        end_index: season.endIndex,
        count: season.count,
        bonus: season.bonus
      })),
      full_collection: {
        first_set_bonus: rules.fullCollection.firstSetBonus,
        additional_set_initial_bonus:
          rules.fullCollection.additionalSetInitialBonus,
        additional_set_decay_ratio:
          rules.fullCollection.additionalSetDecayRatio,
        additional_sets_limit_bonus:
          rules.fullCollection.additionalSetsLimitBonus
      },
      season_one_partials: rules.seasonOnePartials.map((partial) => ({
        key:
          partial.key === 'genesis'
            ? ApiTdhSeasonOnePartialKey.Genesis
            : ApiTdhSeasonOnePartialKey.Nakamoto,
        token_ids: partial.tokenIds,
        bonus: partial.bonus
      })),
      gradients: {
        bonus_per_token: rules.gradients.bonusPerToken,
        max_count: rules.gradients.maxCount,
        max_bonus: rules.gradients.maxBonus
      }
    }
  };
}

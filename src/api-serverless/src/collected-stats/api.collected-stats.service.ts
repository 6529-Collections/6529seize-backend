import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiCollectedStats } from '@/api/generated/models/ApiCollectedStats';
import { ApiCollectedStatsSeason } from '@/api/generated/models/ApiCollectedStatsSeason';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  CollectedStatsDb,
  collectedStatsDb
} from '@/api/collected-stats/api.collected-stats.db';
import { WALLET_REGEX } from '@/constants';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';

type SeasonAccumulator = {
  balances: number[];
  total_cards_held: number;
};

export class CollectedStatsService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly collectedStatsDb: CollectedStatsDb
  ) {}

  async getStats(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiCollectedStats> {
    const identity =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        ctx
      );

    if (!identity) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }

    const wallets = this.getWalletsToSearchBy(identity, identityKey);
    const [summary, seasonDefinitions, heldBalances] = await Promise.all([
      identity.id
        ? this.collectedStatsDb.getConsolidatedCollectionSummary(
            identity.consolidation_key,
            ctx
          )
        : this.collectedStatsDb.getWalletCollectionSummary(
            wallets[0] ?? '',
            ctx
          ),
      this.collectedStatsDb.getSeasonDefinitions(ctx),
      this.collectedStatsDb.getHeldBalancesBySeasonAndToken(wallets, ctx)
    ]);

    const seasonHoldings = heldBalances.reduce((acc, row) => {
      const seasonId = Number(row.season_id);
      const balance = Number(row.balance);
      const holding = acc.get(seasonId) ?? {
        balances: [],
        total_cards_held: 0
      };

      holding.balances.push(balance);
      holding.total_cards_held += balance;
      acc.set(seasonId, holding);
      return acc;
    }, new Map<number, SeasonAccumulator>());

    return {
      boost: Number(summary?.boost ?? 1),
      nextgen_balance: Number(summary?.nextgen_balance ?? 0),
      gradients_balance: Number(summary?.gradients_balance ?? 0),
      memes_balance: Number(
        summary?.memes_balance ??
          heldBalances.reduce((total, row) => total + Number(row.balance), 0)
      ),
      unique_memes: Number(summary?.unique_memes ?? heldBalances.length),
      seasons: seasonDefinitions.map((definition) =>
        this.toApiSeasonStats(
          definition,
          seasonHoldings.get(Number(definition.season_id))
        )
      )
    };
  }

  private getWalletsToSearchBy(
    identity: ApiIdentity,
    identityKey: string
  ): string[] {
    const wallets = [
      ...(identity.wallets ?? []).map((it) => it.wallet?.toLowerCase() ?? ''),
      identity.primary_wallet?.toLowerCase() ?? ''
    ].filter((it) => it.length > 0);

    if (wallets.length > 0) {
      return Array.from(new Set(wallets));
    }

    const fallback = identity.query?.toLowerCase() ?? identityKey.toLowerCase();
    return WALLET_REGEX.exec(fallback) ? [fallback] : [];
  }

  private toApiSeasonStats(
    definition: {
      season_id: number;
      season: string;
      total_cards_in_season: number;
    },
    seasonHolding: SeasonAccumulator | undefined
  ): ApiCollectedStatsSeason {
    const totalCardsInSeason = Number(definition.total_cards_in_season);
    const balances = seasonHolding?.balances ?? [];
    const uniqueCardsHeld = balances.length;
    const totalCardsHeld = seasonHolding?.total_cards_held ?? 0;

    let setsHeld = 0;
    let partialSetUniqueCardsHeld = uniqueCardsHeld;

    if (uniqueCardsHeld === totalCardsInSeason && totalCardsInSeason > 0) {
      setsHeld = Math.min(...balances);
      partialSetUniqueCardsHeld = balances.filter(
        (balance) => balance > setsHeld
      ).length;
    }

    return {
      season: definition.season,
      total_cards_in_season: totalCardsInSeason,
      sets_held: setsHeld,
      partial_set_unique_cards_held: partialSetUniqueCardsHeld,
      total_cards_held: totalCardsHeld
    };
  }
}

export const collectedStatsService = new CollectedStatsService(
  identityFetcher,
  collectedStatsDb
);

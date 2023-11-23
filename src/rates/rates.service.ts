import { RateMatterTargetType } from '../entities/IRateMatter';
import { RateEvent, RateEventReason } from '../entities/IRateEvent';
import { BadRequestException } from '../exceptions';
import { randomUUID } from 'crypto';
import { RateCategoryInfo } from './rates.types';
import { Logger } from '../logging';
import { Time } from '../time';
import { ratesDb, RatesDb } from './rates.db';

export class RatesService {
  private readonly logger = Logger.get('RATES_SERVICE');

  constructor(private readonly ratesDb: RatesDb) {}

  public async revokeOverRates() {
    const startTime = Time.now();
    this.logger.info(`Fetching current TDH's...`);
    const activeTdhs = await this.ratesDb.getAllTdhs();
    this.logger.info(`Fetching current rate tallies...`);
    const talliesByWallets = await this.getAllRateMatterTalliesByWallets();
    this.logger.info(`Figuring out overrates...`);
    const allOverRates = this.calculateOverrateSummaries(
      activeTdhs,
      talliesByWallets
    );
    this.logger.info(`Revoking overrates...`);
    await this.createRevocationEvents(allOverRates);
    this.logger.info(`All overrates revoked in ${startTime.diffFromNow()}`);
  }

  public async registerUserRating({
    rater,
    matter,
    matterTargetType,
    matterTargetId,
    category,
    amount
  }: {
    rater: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
    category: string;
    amount: number;
  }) {
    const { ratesLeft, consolidatedWallets } =
      await this.getRatesLeftOnMatterForWallet({
        wallet: rater,
        matter,
        matterTargetType
      });
    const ratesTallyForWalletOnMatterByCategories =
      await this.ratesDb.getRatesTallyForWalletOnMatterByCategories({
        matter,
        matterTargetType,
        matterTargetId,
        wallets: consolidatedWallets
      });
    const ratesSpentOnGivenCategory =
      ratesTallyForWalletOnMatterByCategories[category] ?? 0;
    if (amount === 0) {
      return;
    }
    if (amount < 0 && Math.abs(amount) > ratesSpentOnGivenCategory) {
      throw new BadRequestException(
        `Wallet tried to revoke ${Math.abs(
          amount
        )} rates on matter and category but has only historically given ${ratesSpentOnGivenCategory} rates`
      );
    }
    if (amount > 0 && ratesLeft < amount) {
      throw new BadRequestException(
        `Wallet tried to give ${amount} rates on matter without enough rates left. Rates left: ${ratesLeft}`
      );
    }
    const allCategoriesForMatter = await this.ratesDb.getCategoriesForMatter({
      matter,
      matterTargetType
    });
    const activeCategory = allCategoriesForMatter
      .filter((c) => amount < 0 || !c.disabled_time)
      .filter((c) => c.matter === matter)
      .filter((c) => c.matter_target_type === matterTargetType)
      .find((c) => c.matter_category_tag === category);
    if (!activeCategory) {
      throw new BadRequestException(
        `Tried to rate on matter with category ${category} but no active category with such tag exists for this matter`
      );
    }
    await this.ratesDb.insertRateEvent({
      id: randomUUID(),
      rater,
      matter_target_id: matterTargetId,
      matter_target_type: matterTargetType,
      matter,
      matter_category: category,
      event_reason: RateEventReason.USER_RATED,
      amount,
      created_time: new Date()
    });
  }

  public async getRatesLeftOnMatterForWallet({
    wallet,
    matter,
    matterTargetType
  }: {
    wallet: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
  }): Promise<{
    ratesLeft: number;
    ratesSpent: number;
    consolidatedWallets: string[];
  }> {
    const { tdh, consolidatedWallets } =
      await this.getWalletTdhAndConsolidatedWallets(wallet);
    if (
      !consolidatedWallets.find((w) => w.toLowerCase() === wallet.toLowerCase())
    ) {
      consolidatedWallets.push(wallet.toLowerCase());
    }
    const ratesSpent = await this.ratesDb.getTotalRatesSpentOnMatterByWallets({
      wallets: consolidatedWallets,
      matter,
      matterTargetType
    });
    return {
      ratesLeft: tdh - ratesSpent,
      ratesSpent: ratesSpent,
      consolidatedWallets
    };
  }

  public async getCategoriesInfoOnMatter({
    matterTargetType,
    matterTargetId,
    matter,
    wallets
  }: {
    wallets: string[];
    matterTargetType: RateMatterTargetType;
    matter: string;
    matterTargetId: string;
  }): Promise<RateCategoryInfo[]> {
    const categories = await this.ratesDb.getCategoriesForMatter({
      matter,
      matterTargetType
    });
    const totalTalliesByCategory =
      await this.ratesDb.getTotalTalliesByCategories(
        matterTargetType,
        matterTargetId,
        matter
      );
    const walletsRatesByCategory =
      await this.ratesDb.getRatesTallyForWalletOnMatterByCategories({
        wallets,
        matter,
        matterTargetType,
        matterTargetId
      });
    return categories.map<RateCategoryInfo>((c) => ({
      tally: totalTalliesByCategory[c.matter_category_tag] ?? 0,
      authenticated_wallet_rates:
        walletsRatesByCategory[c.matter_category_tag] ?? 0,
      category_tag: c.matter_category_tag,
      category_enabled: !c.disabled_time,
      category_display_name: c.matter_category_display_name,
      category_media: JSON.parse(c.matter_category_media ?? '{}')
    }));
  }

  private calculateOverrateSummaries(
    activeTdhs: {
      tdh: number;
      wallets: string[];
    }[],
    talliesByWallets: Record<
      string,
      Record<
        string,
        { matter: string; matter_target_type: string; tally: number }
      >
    >
  ) {
    // create mock 0 tdhs for wallets that have historically rated but are not part of community anymore
    for (const wallet of Object.keys(talliesByWallets)) {
      const walletNotFoundFromTdhs = !activeTdhs.find((tdh) =>
        tdh.wallets.map((it) => it.toLowerCase()).includes(wallet.toLowerCase())
      );
      if (walletNotFoundFromTdhs) {
        activeTdhs.push({
          tdh: 0,
          wallets: [wallet]
        });
      }
    }
    return activeTdhs.reduce(
      (aggregatedTallies, activeTdh) => {
        const talliesForConsolidationGroupsByMatter: Record<
          string,
          {
            tally: number;
            matter: string;
            matter_target_type: string;
            rate_participating_wallets: string[];
            tdh: number;
          }
        > = {};
        // aggregate all consolidation group rates by matter
        for (const wallet of activeTdh.wallets) {
          const allMattersTalliesForWallet = talliesByWallets[wallet] || {};
          for (const [key, matterTallyDescription] of Object.entries(
            allMattersTalliesForWallet
          )) {
            if (!talliesForConsolidationGroupsByMatter[key]) {
              // for the first wallet in consolidation group that has spent rates on this matter
              talliesForConsolidationGroupsByMatter[key] = {
                matter: matterTallyDescription.matter,
                matter_target_type: matterTallyDescription.matter_target_type,
                tally: matterTallyDescription.tally,
                rate_participating_wallets: [wallet],
                tdh: activeTdh.tdh
              };
            } else {
              // for other wallets in consolidation group that has spent rates on this matter
              talliesForConsolidationGroupsByMatter[key] = {
                matter: matterTallyDescription.matter,
                matter_target_type: matterTallyDescription.matter_target_type,
                tally:
                  talliesForConsolidationGroupsByMatter[key].tally +
                  matterTallyDescription.tally,
                rate_participating_wallets: [
                  wallet,
                  ...talliesForConsolidationGroupsByMatter[key]
                    .rate_participating_wallets
                ],
                tdh: activeTdh.tdh
              };
            }
          }
        }
        // keep only the ones where rate count exceeds TDH
        aggregatedTallies.push(
          ...Object.values(talliesForConsolidationGroupsByMatter).filter(
            (t) => t.tally > activeTdh.tdh
          )
        );
        return aggregatedTallies;
      },
      [] as {
        tdh: number;
        tally: number;
        matter: string;
        matter_target_type: string;
        rate_participating_wallets: string[];
      }[]
    );
  }

  private async getAllRateMatterTalliesByWallets() {
    const activeRateTally =
      await this.ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget();
    return activeRateTally.reduce((a, vt) => {
      const rater = vt.rater.toLowerCase();
      if (!a[rater]) {
        a[rater] = {};
      }
      a[rater][`${vt.matter}-${vt.matter_target_type}`] = {
        matter: vt.matter,
        matter_target_type: vt.matter_target_type,
        tally: +vt.rate_tally
      };
      return a;
    }, {} as Record<string, Record<string, { matter: string; matter_target_type: string; tally: number }>>);
  }

  private async createRevocationEvents(
    allOverRates: {
      tdh: number;
      tally: number;
      matter: string;
      matter_target_type: string;
      rate_participating_wallets: string[];
    }[]
  ) {
    await this.ratesDb.executeNativeQueriesInTransaction(
      async (connectionHolder) => {
        for (const overRate of allOverRates) {
          const overRateAmount = overRate.tally - overRate.tdh;

          const toBeRevokedEvents: RateEvent[] =
            await this.ratesDb.getToBeRevokedEvents(
              overRate,
              overRateAmount,
              connectionHolder
            );
          const reverseRateEventsByKey: Record<string, RateEvent> = {};
          let reverseRateAmount = 0;
          for (const event of toBeRevokedEvents) {
            const key = `${event.matter}-${event.matter_target_type}-${event.rater}-${event.matter_target_id}-${event.matter_category}`;
            let toAdd = event.amount;
            if (reverseRateAmount + toAdd > overRateAmount) {
              toAdd = overRateAmount - reverseRateAmount;
            }
            reverseRateAmount += toAdd;
            if (!reverseRateEventsByKey[key]) {
              reverseRateEventsByKey[key] = {
                ...event,
                id: randomUUID(),
                created_time: new Date(),
                event_reason: RateEventReason.TDH_CHANGED,
                amount: -toAdd
              };
            } else {
              reverseRateEventsByKey[key].amount -= toAdd;
            }
          }
          const reverseRateEvents = Object.values(
            reverseRateEventsByKey
          ).filter((e) => e.amount !== 0);
          for (const reverseRaterEvent of reverseRateEvents) {
            await this.ratesDb.insertRateEvent(
              reverseRaterEvent,
              connectionHolder
            );
          }
          this.logger.info(
            `Created ${reverseRateEvents.length} rate revocation events on matter ${overRate.matter_target_type}/${overRate.matter}`
          );
        }
      }
    );
  }

  private async getWalletTdhAndConsolidatedWallets(
    wallet: string
  ): Promise<{ tdh: number; consolidatedWallets: string[]; blockNo: number }> {
    if (!/0x[a-fA-F0-9]{40}/.exec(wallet)) {
      return { tdh: 0, consolidatedWallets: [], blockNo: 0 };
    }
    const walletTdh = await this.ratesDb.getTdhInfoForWallet(wallet);
    const consolidatedWallets = walletTdh?.wallets ?? [];
    if (!consolidatedWallets.includes(wallet.toLowerCase())) {
      consolidatedWallets.push(wallet.toLowerCase());
    }
    return {
      tdh: walletTdh?.tdh ?? 0,
      consolidatedWallets: consolidatedWallets,
      blockNo: walletTdh?.block ?? 0
    };
  }
}

export const ratesService: RatesService = new RatesService(ratesDb);

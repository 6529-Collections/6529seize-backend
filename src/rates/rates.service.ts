import { RateMatterTargetType } from '../entities/IRateMatter';
import { RateEvent, RateEventReason } from '../entities/IRateEvent';
import { BadRequestException } from '../exceptions';
import { randomUUID } from 'crypto';
import { RateCategoryInfo } from './rates.types';
import { Logger } from '../logging';
import { Time } from '../time';
import { ratesDb, RatesDb } from './rates.db';
import { profilesService } from '../profiles/profiles.service';

export class RatesService {
  private readonly logger = Logger.get('RATES_SERVICE');

  constructor(private readonly ratesDb: RatesDb) {}

  public async revokeOverRates() {
    const startTime = Time.now();
    this.logger.info(`Fetching current TDH's...`);
    const activeTdhs = await this.ratesDb.getAllProfilesTdhs();
    this.logger.info(`Fetching current rate tallies...`);
    const talliesByRaters = await this.getAllRateMatterTalliesGroupedByRaters();
    this.logger.info(`Figuring out overrates...`);
    const allOverRates = this.calculateOverrateSummaries(
      activeTdhs,
      talliesByRaters
    );
    this.logger.info(`Revoking overrates...`);
    await this.createRevocationEvents(allOverRates);
    this.logger.info(`All overrates revoked in ${startTime.diffFromNow()}`);
  }

  public async registerUserRatingWithWallet({
    raterWallet,
    matter,
    matterTargetType,
    matterTargetId,
    category,
    amount
  }: {
    raterWallet: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
    category: string;
    amount: number;
  }) {
    const rater = await profilesService.getProfileIdByWallet(raterWallet);
    if (!rater) {
      throw new BadRequestException(
        `Wallet ${raterWallet} doesn't have a profile. Profile needs to be created before user can rate.`
      );
    }
    await ratesService.registerUserRating({
      raterProfileId: rater,
      matter,
      matterTargetType,
      matterTargetId,
      category,
      amount
    });
  }

  public async registerUserRating({
    raterProfileId,
    matter,
    matterTargetType,
    matterTargetId,
    category,
    amount
  }: {
    raterProfileId: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
    matterTargetId: string;
    category: string;
    amount: number;
  }) {
    if (amount === 0) {
      return;
    }
    const { ratesLeft } = await this.getRatesLeftOnMatterForProfile({
      profileId: raterProfileId,
      matter,
      matterTargetType
    });
    const ratesTallyForProfileOnMatterByCategories =
      await this.ratesDb.getRatesTallyForProfileOnMatterByCategories({
        matter,
        matterTargetType,
        matterTargetId,
        profileId: raterProfileId
      });
    const ratesSpentOnGivenCategory =
      ratesTallyForProfileOnMatterByCategories[category] ?? 0;
    if (amount < 0 && Math.abs(amount) > ratesSpentOnGivenCategory) {
      throw new BadRequestException(
        `Profile tried to revoke ${Math.abs(
          amount
        )} rates on matter and category but has only historically given ${ratesSpentOnGivenCategory} rates`
      );
    }
    if (amount > 0 && ratesLeft < amount) {
      throw new BadRequestException(
        `Profile tried to give ${amount} rates on matter but only has ${ratesLeft} rates left`
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
        `Profile tried to rate on matter with category ${category} but no active category with such tag exists for this matter`
      );
    }
    await this.ratesDb.insertRateEvent({
      id: randomUUID(),
      rater: raterProfileId,
      matter_target_id: matterTargetId,
      matter_target_type: matterTargetType,
      matter,
      matter_category: category,
      event_reason: RateEventReason.USER_RATED,
      amount,
      created_time: new Date()
    });
  }

  public async getRatesLeftOnMatterForProfile({
    profileId,
    matter,
    matterTargetType
  }: {
    profileId: string;
    matter: string;
    matterTargetType: RateMatterTargetType;
  }): Promise<{
    ratesLeft: number;
    ratesSpent: number;
  }> {
    const tdh = await this.ratesDb.getTdhInfoForProfile(profileId);
    const ratesSpent = await this.ratesDb.getTotalRatesSpentOnMatterByProfileId(
      {
        profileId,
        matter,
        matterTargetType
      }
    );
    return {
      ratesLeft: tdh - ratesSpent,
      ratesSpent: ratesSpent
    };
  }

  public async getCategoriesInfoOnMatter({
    matterTargetType,
    matterTargetId,
    matter,
    profileId
  }: {
    profileId?: string | null;
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
    const profileRatesByCategory = profileId
      ? await this.ratesDb.getRatesTallyForProfileOnMatterByCategories({
          profileId,
          matter,
          matterTargetType,
          matterTargetId
        })
      : {};
    return categories.map<RateCategoryInfo>((c) => ({
      tally: totalTalliesByCategory[c.matter_category_tag] ?? 0,
      authenticated_profile_rates:
        profileRatesByCategory[c.matter_category_tag] ?? 0,
      category_tag: c.matter_category_tag,
      category_enabled: !c.disabled_time,
      category_display_name: c.matter_category_display_name,
      category_media: JSON.parse(c.matter_category_media ?? '{}')
    }));
  }

  private calculateOverrateSummaries(
    activeTdhs: {
      tdh: number;
      profile_id: string;
    }[],
    talliesByRaters: Record<
      string,
      Record<
        string,
        {
          matter: string;
          matter_target_type: string;
          tally: number;
        }
      >
    >
  ) {
    // create mock 0 tdhs for profiles that have historically rated but are not part of community anymore
    for (const raterId of Object.keys(talliesByRaters)) {
      const profilesNotFoundFromTdhs = !activeTdhs.find(
        (tdh) => tdh.profile_id === raterId
      );
      if (profilesNotFoundFromTdhs) {
        activeTdhs.push({
          tdh: 0,
          profile_id: raterId
        });
      }
    }
    return activeTdhs.reduce(
      (aggregatedTallies, activeTdh) => {
        const talliesForProfilesByMatter: Record<
          string,
          {
            tally: number;
            matter: string;
            matter_target_type: string;
            profileId: string;
            tdh: number;
          }
        > = {};
        const allMattersTalliesForProfile =
          talliesByRaters[activeTdh.profile_id] || {};
        for (const [key, matterTallyDescription] of Object.entries(
          allMattersTalliesForProfile
        )) {
          if (!talliesForProfilesByMatter[key]) {
            talliesForProfilesByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally: matterTallyDescription.tally,
              profileId: activeTdh.profile_id,
              tdh: activeTdh.tdh
            };
          } else {
            talliesForProfilesByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally:
                talliesForProfilesByMatter[key].tally +
                matterTallyDescription.tally,
              profileId: activeTdh.profile_id,
              tdh: activeTdh.tdh
            };
          }
        }
        aggregatedTallies.push(
          ...Object.values(talliesForProfilesByMatter).filter(
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
        profileId: string;
      }[]
    );
  }

  private async getAllRateMatterTalliesGroupedByRaters() {
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
      profileId: string;
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
}

export const ratesService: RatesService = new RatesService(ratesDb);

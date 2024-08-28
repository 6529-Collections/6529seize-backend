import { Time } from '../time';
import { dropsDb, DropsDb } from './drops.db';
import { ratingsDb, RatingsDb } from '../rates/ratings.db';
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { Logger } from '../logging';

class DropOverRatesRevocationService {
  private readonly logger = Logger.get(DropOverRatesRevocationService.name);
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly ratingsDb: RatingsDb
  ) {}

  public async revokeOverRates() {
    const start = Time.now();
    this.logger.info(`Starting to revoke drops overrates`);
    await this.ratingsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const overRates = await this.dropsDb.findOverspentRateCredits(
          {
            reservationStartTime: Time.todayUtcMidnight().minusDays(30)
          },
          connection
        );
        const overRatesByRater = Object.values(
          overRates.reduce((acc, overRate) => {
            const raterId = overRate.rater_id;
            if (!acc[raterId]) {
              acc[raterId] = {
                tdhSpentOnDropReps: [],
                rater_id: raterId,
                profile_tdh: overRate.whole_credit,
                total_reserved_tdh: overRate.total_credit_spent
              };
            }
            acc[raterId].tdhSpentOnDropReps.push({
              id: overRate.id,
              rater_id: overRate.rater_id,
              drop_id: overRate.drop_id,
              credit_spent: overRate.credit_spent,
              timestamp: overRate.timestamp,
              wave_id: overRate.wave_id
            });
            return acc;
          }, {} as Record<string, { tdhSpentOnDropReps: DropVoteCreditSpending[]; rater_id: string; profile_tdh: number; total_reserved_tdh: number }>)
        );
        for (const {
          tdhSpentOnDropReps,
          rater_id,
          profile_tdh,
          total_reserved_tdh
        } of overRatesByRater) {
          this.logger.info(`Found drop overrates for profile ${rater_id}`);
          const tdhToRevoke = total_reserved_tdh - profile_tdh;
          const coefficient = tdhToRevoke / total_reserved_tdh;
          let tdhRevokeLeft = tdhToRevoke;
          while (tdhRevokeLeft > 0) {
            const tdhSpentOnDropRep = tdhSpentOnDropReps.pop();
            if (!tdhSpentOnDropRep) {
              break;
            }
            const amountOfTdhToReduce = Math.ceil(
              tdhSpentOnDropRep.credit_spent * coefficient
            );
            const newTdhSpent =
              tdhSpentOnDropRep.credit_spent - amountOfTdhToReduce;
            tdhRevokeLeft -= newTdhSpent;
            if (newTdhSpent > 0) {
              await this.dropsDb.updateCreditSpentOnDropRates(
                {
                  reservationId: tdhSpentOnDropRep.id,
                  credit_spent: newTdhSpent
                },
                connection
              );
            } else {
              await this.dropsDb.deleteCreditSpentOnDropRates(
                tdhSpentOnDropRep.id,
                connection
              );
            }
          }
        }
      }
    );
    this.logger.info(`Revoked drops overrates in ${start.diffFromNow()}`);
  }
}

export const dropOverRaterRevocationService =
  new DropOverRatesRevocationService(dropsDb, ratingsDb);

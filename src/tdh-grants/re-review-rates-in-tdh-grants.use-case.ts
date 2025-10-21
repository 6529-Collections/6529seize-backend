import { RequestContext } from '../request.context';
import { Logger } from '../logging';
import {
  TdhGrantOverflowRow,
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import { TdhGrantStatus } from '../entities/ITdhGrant';

type AdjustedGrant = {
  grant_id: string;
  grantor_id: string;
  original_tdh_rate: number;
  suggested_tdh_rate: number;
  scale_factor: number;
};

type SegmentBucket = {
  grantorId: string;
  segFrom: number;
  segTo: number | null;
  target: number;
  grants: TdhGrantOverflowRow[];
};

export class ReReviewRatesInTdhGrantsUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly tdhGrantsRepository: TdhGrantsRepository) {}

  public async handle(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->handle`);
      this.logger.info(
        `Starting to review TDH grants rates and adjusting them in case of overflows`
      );
      const connection = ctx.connection;
      if (!connection) {
        throw new Error(`This action can only be done in a transaction`);
      }
      const overFlowedGrantsWithGrantorRates =
        await this.tdhGrantsRepository.getOverflowedGrantsWithGrantorRates(ctx);
      if (!overFlowedGrantsWithGrantorRates.length) {
        this.logger.info(`Found no overflowed grants`);
        return;
      }
      this.logger.info(
        `Found ${overFlowedGrantsWithGrantorRates.length} overflowed grants. Adjusting them`
      );
      // 2) Group by (grantor_id, seg_valid_from, seg_valid_to)
      const segKey = (r: TdhGrantOverflowRow): string =>
        r.grantor_id +
        '|' +
        r.seg_valid_from +
        '|' +
        (r.seg_valid_to ?? 'NULL');

      const bySegment = new Map<string, SegmentBucket>();

      for (const r of overFlowedGrantsWithGrantorRates) {
        const key = segKey(r);
        let bucket = bySegment.get(key);
        if (!bucket) {
          bucket = {
            grantorId: r.grantor_id,
            segFrom: r.seg_valid_from,
            segTo: r.seg_valid_to ?? null,
            target: r.grantors_tdh_rate,
            grants: []
          };
          bySegment.set(key, bucket);
        }
        bucket.grants.push(r);
      }

      // --- compute min scale factor per grant
      const perGrantMinFactor = new Map<string, number>();

      bySegment.forEach((bucket: SegmentBucket) => {
        const sum: number = bucket.grants.reduce<number>(
          (acc: number, g: TdhGrantOverflowRow) => acc + g.grant_tdh_rate,
          0
        );
        const safeTarget: number = Math.max(0, bucket.target);
        const f: number = sum > 0 ? Math.min(1, safeTarget / sum) : 1;

        for (const g of bucket.grants) {
          const prev = perGrantMinFactor.get(g.grant_id);
          perGrantMinFactor.set(
            g.grant_id,
            prev === undefined ? f : Math.min(prev, f)
          );
        }
      });

      // --- build final adjusted list (no iterator usage)
      const seen = new Set<string>();
      const adjusted: AdjustedGrant[] = [];

      for (const r of overFlowedGrantsWithGrantorRates) {
        if (seen.has(r.grant_id)) return;
        seen.add(r.grant_id);

        const f = perGrantMinFactor.get(r.grant_id) ?? 1;
        adjusted.push({
          grant_id: r.grant_id,
          grantor_id: r.grantor_id,
          original_tdh_rate: r.grant_tdh_rate,
          suggested_tdh_rate: r.grant_tdh_rate * f,
          scale_factor: f
        });
      }
      this.logger.info(
        `Adjustments prepared. Disabling current versions of grants`
      );
      await this.tdhGrantsRepository.bulkUpdateStatus(
        {
          ids: adjusted.map((it) => it.grant_id),
          status: TdhGrantStatus.DISABLED,
          error:
            'Sum of active grants in this timespan exceeded grantors xTDH rate'
        },
        ctx
      );
      this.logger.info(
        `Current versions disabled. Inserting replacement grants.`
      );
      await this.tdhGrantsRepository.insertReplacementGrants(
        adjusted.map((it) => ({
          grant_id: it.grant_id,
          new_rate: it.suggested_tdh_rate
        })),
        ctx
      );
      this.logger.info(`Replacement grants inserted.`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }
}

export const reReviewRatesInTdhGrantsUseCase =
  new ReReviewRatesInTdhGrantsUseCase(tdhGrantsRepository);

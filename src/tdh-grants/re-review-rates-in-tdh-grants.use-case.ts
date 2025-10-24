import { RequestContext } from '../request.context';
import { Logger } from '../logging';
import {
  GrantWithCap,
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import { TdhGrantEntity, TdhGrantStatus } from '../entities/ITdhGrant';
import { randomUUID } from 'node:crypto';
import { Time } from '../time';
import { collections } from '../collections';

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
        `Found ${overFlowedGrantsWithGrantorRates.length} overflowed grants. Creating replacements`
      );
      const replacements = this.buildReplacementGrants(
        overFlowedGrantsWithGrantorRates
      );
      this.logger.info(`Replacements prepared. Inserting them`);
      await this.tdhGrantsRepository.bulkInsert(replacements, ctx);
      this.logger.info(`Replacement grants inserted.`);
      this.logger.info(`Disabling old versions of grants`);
      await this.tdhGrantsRepository.bulkUpdateStatus(
        {
          ids: collections.distinct(
            overFlowedGrantsWithGrantorRates.map((it) => it.id)
          ),
          status: TdhGrantStatus.DISABLED,
          error:
            'Sum of active grants in this timespan exceeded grantors xTDH rate. Created replacement grants'
        },
        ctx
      );
      this.logger.info(`Old versions of grants disabled`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }

  private buildReplacementGrants(rows: GrantWithCap[]): TdhGrantEntity[] {
    if (!rows.length) return [];
    const WINDOW_START = 0;
    const WINDOW_END = 99_999_999_999_999;
    const nowMillis = Time.currentMillis();

    const byGrantor: Record<string, GrantWithCap[]> = {};
    for (const r of rows) {
      (byGrantor[r.grantor_id] ??= []).push(r);
    }

    const out: TdhGrantEntity[] = [];

    for (const grantorId in byGrantor) {
      const grantsRaw = byGrantor[grantorId];
      const capacity = grantsRaw[0].grantor_x_tdh_rate || 0;

      const uniq: Record<string, GrantWithCap> = {};
      for (const g of grantsRaw) uniq[g.id] = g;
      const grants = Object.keys(uniq).map((k) => uniq[k]);

      type Span = {
        g: GrantWithCap;
        from: number;
        to: number;
        toWasNull: boolean;
      };

      const spans: Span[] = [];
      const points: number[] = [WINDOW_START, WINDOW_END];

      for (const g of grants) {
        const from = Math.max(g.valid_from!, WINDOW_START);
        const toWasNull = g.valid_to == null;
        const to = toWasNull ? WINDOW_END : Math.min(g.valid_to!, WINDOW_END);
        if (from < to) {
          points.push(from, to);
          spans.push({ g, from, to, toWasNull });
        }
      }

      points.sort((a, b) => a - b);

      const segments: TdhGrantEntity[] = [];

      for (let i = 0; i < points.length - 1; i++) {
        const segStart = points[i];
        const segEnd = points[i + 1];
        if (segStart >= segEnd) continue;

        const active: Span[] = [];
        for (const s of spans) {
          if (s.from < segEnd && s.to > segStart) active.push(s);
        }
        if (!active.length) continue;

        let totalRate = 0;
        for (const s of active) totalRate += s.g.tdh_rate;

        const scale = totalRate > 0 ? Math.min(1, capacity / totalRate) : 1;

        for (const s of active) {
          const start = Math.max(segStart, s.from);
          const end = Math.min(segEnd, s.to);
          if (start >= end) continue;

          const newRate = s.g.tdh_rate * scale;
          const segValidTo = s.toWasNull && end === WINDOW_END ? null : end;

          segments.push({
            id: randomUUID(),
            tokenset_id: s.g.tokenset_id ?? null,
            replaced_grant_id: s.g.id,
            grantor_id: s.g.grantor_id,
            target_chain: s.g.target_chain,
            target_contract: s.g.target_contract,
            target_partition: s.g.target_partition,
            token_mode: s.g.token_mode,
            target_tokens: s.g.target_tokens ?? null,
            created_at: nowMillis,
            updated_at: nowMillis,
            valid_from: start,
            valid_to: segValidTo,
            tdh_rate: newRate,
            status: TdhGrantStatus.GRANTED,
            error_details: null,
            is_irrevocable: s.g.is_irrevocable
          });
        }
      }

      segments.sort((a, b) =>
        a.replaced_grant_id! === b.replaced_grant_id!
          ? a.valid_from! - b.valid_from!
          : a.replaced_grant_id! < b.replaced_grant_id!
            ? -1
            : 1
      );

      const merged: TdhGrantEntity[] = [];
      for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (
          last &&
          last.replaced_grant_id === seg.replaced_grant_id &&
          (last.valid_to ?? WINDOW_END) === seg.valid_from &&
          Math.abs(last.tdh_rate - seg.tdh_rate) <= 1e-9 &&
          last.status === seg.status &&
          last.grantor_id === seg.grantor_id &&
          last.target_chain === seg.target_chain &&
          last.target_contract === seg.target_contract &&
          last.target_partition === seg.target_partition &&
          last.token_mode === seg.token_mode &&
          last.target_tokens === seg.target_tokens &&
          last.is_irrevocable === seg.is_irrevocable
        ) {
          merged[merged.length - 1] = {
            ...last,
            valid_to: seg.valid_to
          };
        } else {
          merged.push(seg);
        }
      }

      out.push(...merged);
    }

    return out;
  }
}

export const reReviewRatesInTdhGrantsUseCase =
  new ReReviewRatesInTdhGrantsUseCase(tdhGrantsRepository);

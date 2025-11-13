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

type Span = {
  g: GrantWithCap;
  from: number;
  to: number;
  toWasNull: boolean;
};

export class ReReviewRatesInTdhGrantsUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  private static readonly WINDOW_START = 0;
  private static readonly WINDOW_END = 99_999_999_999_999;

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

    const nowMillis = Time.currentMillis();
    const byGrantor = this.groupByGrantor(rows);
    const out: TdhGrantEntity[] = [];

    for (const grantorId in byGrantor) {
      const grantsRaw = byGrantor[grantorId];
      const capacity = grantsRaw[0].grantor_x_tdh_rate || 0;

      const grants = this.dedupeGrantsById(grantsRaw);
      const spans = this.toSpans(grants);
      if (!spans.length) continue;

      const points = this.collectSortedBreakpoints(spans);
      const segments = this.buildScaledSegmentsForGrantor(
        spans,
        points,
        capacity,
        nowMillis
      );

      const merged = this.mergeAdjacentSegments(segments);
      out.push(...merged);
    }

    return out;
  }

  private groupByGrantor(rows: GrantWithCap[]): Record<string, GrantWithCap[]> {
    const by: Record<string, GrantWithCap[]> = {};
    for (const r of rows) {
      const grantorId = r.grantor_id;
      if (!by[grantorId]) {
        by[grantorId] = [];
      }
      by[grantorId].push(r);
    }
    return by;
  }

  private dedupeGrantsById(rows: GrantWithCap[]): GrantWithCap[] {
    const map: Record<string, GrantWithCap> = {};
    for (const g of rows) {
      map[g.id] = g;
    }
    const out: GrantWithCap[] = [];
    for (const id in map) out.push(map[id]);
    return out;
  }

  private toSpans(grants: GrantWithCap[]): Span[] {
    const spans: Span[] = [];
    for (const g of grants) {
      const from = Math.max(
        g.valid_from!,
        ReReviewRatesInTdhGrantsUseCase.WINDOW_START
      );
      const toWasNull = g.valid_to == null;
      const to = toWasNull
        ? ReReviewRatesInTdhGrantsUseCase.WINDOW_END
        : Math.min(g.valid_to, ReReviewRatesInTdhGrantsUseCase.WINDOW_END);

      if (from < to) {
        spans.push({ g, from, to, toWasNull });
      }
    }
    return spans;
  }

  private collectSortedBreakpoints(spans: Span[]): number[] {
    const raw: number[] = [
      ReReviewRatesInTdhGrantsUseCase.WINDOW_START,
      ReReviewRatesInTdhGrantsUseCase.WINDOW_END
    ];
    for (const span of spans) {
      raw.push(span.from, span.to);
    }
    raw.sort((a, b) => a - b);
    const points: number[] = [];
    let last: number | undefined = undefined;
    for (const v of raw) {
      if (last === undefined || v !== last) {
        points.push(v);
        last = v;
      }
    }
    return points;
  }

  private getActiveSpans(
    spans: Span[],
    segStart: number,
    segEnd: number
  ): Span[] {
    const act: Span[] = [];
    for (const s of spans) {
      if (s.from < segEnd && s.to > segStart) act.push(s);
    }
    return act;
  }

  private computeScale(active: Span[], capacity: number): number {
    if (!active.length) return 1;
    let total = 0;
    for (const a of active) total += a.g.tdh_rate;
    if (total <= 0) return 1;
    return Math.min(1, capacity / total);
  }

  private makeReplacementEntity(
    source: Span,
    segStart: number,
    segEnd: number,
    newRate: number,
    nowMillis: number
  ): TdhGrantEntity {
    const isWindowEnd = segEnd === ReReviewRatesInTdhGrantsUseCase.WINDOW_END;
    const segValidTo = source.toWasNull && isWindowEnd ? null : segEnd;

    return {
      id: randomUUID(),
      tokenset_id: source.g.tokenset_id ?? null,
      replaced_grant_id: source.g.id,
      grantor_id: source.g.grantor_id,
      target_chain: source.g.target_chain,
      target_contract: source.g.target_contract,
      target_partition: source.g.target_partition,
      token_mode: source.g.token_mode,
      created_at: nowMillis,
      updated_at: nowMillis,
      valid_from: segStart,
      valid_to: segValidTo,
      tdh_rate: newRate,
      status: TdhGrantStatus.GRANTED,
      error_details: null,
      is_irrevocable: source.g.is_irrevocable
    };
  }

  private buildScaledSegmentsForGrantor(
    spans: Span[],
    points: number[],
    capacity: number,
    nowMillis: number
  ): TdhGrantEntity[] {
    const segments: TdhGrantEntity[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      if (segStart >= segEnd) continue;

      const active = this.getActiveSpans(spans, segStart, segEnd);
      if (!active.length) continue;

      const scale = this.computeScale(active, capacity);

      for (const s of active) {
        const start = Math.max(segStart, s.from);
        const end = Math.min(segEnd, s.to);
        if (start >= end) continue;

        const newRate = s.g.tdh_rate * scale;
        segments.push(
          this.makeReplacementEntity(s, start, end, newRate, nowMillis)
        );
      }
    }

    segments.sort((a, b) => {
      const aRepId = a.replaced_grant_id!;
      const bRepId = b.replaced_grant_id!;
      if (aRepId === bRepId) {
        const aValidFrom = a.valid_from!;
        const bValidFrom = b.valid_from!;
        return aValidFrom - bValidFrom;
      }
      return aRepId < bRepId ? -1 : 1;
    });

    return this.mergeAdjacentSegments(segments);
  }

  private mergeAdjacentSegments(segments: TdhGrantEntity[]): TdhGrantEntity[] {
    const merged: TdhGrantEntity[] = [];
    const WINDOW_END = ReReviewRatesInTdhGrantsUseCase.WINDOW_END;

    for (const seg of segments) {
      const last = merged.at(-1);

      const canMerge =
        !!last &&
        last.replaced_grant_id === seg.replaced_grant_id &&
        (last.valid_to ?? WINDOW_END) === seg.valid_from &&
        Math.abs(last.tdh_rate - seg.tdh_rate) <= 1e-9 &&
        last.status === seg.status &&
        last.grantor_id === seg.grantor_id &&
        last.target_chain === seg.target_chain &&
        last.target_contract === seg.target_contract &&
        last.target_partition === seg.target_partition &&
        last.token_mode === seg.token_mode &&
        last.is_irrevocable === seg.is_irrevocable;

      if (canMerge) {
        merged[merged.length - 1] = { ...last, valid_to: seg.valid_to };
      } else {
        merged.push(seg);
      }
    }

    return merged;
  }
}

export const reReviewRatesInTdhGrantsUseCase =
  new ReReviewRatesInTdhGrantsUseCase(tdhGrantsRepository);

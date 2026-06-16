import {
  DROP_MENTIONED_WAVES_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  RATINGS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { assertUnreachable } from '@/assertions';
import { ApiWaveVisibilityTier } from '@/api/generated/models/ApiWaveVisibilityTier';
import { RateMatter } from '@/entities/IRating';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';
import {
  DEMOTED_MIN_VISIBILITY_SCORE,
  EXPLORATION_NEUTRAL_MIN_VISIBILITY_SCORE,
  LOW_TRUST_LEVEL_RAW,
  MAX_LEVEL_RAW_FOR_SCORE,
  MAX_WAVE_REP_FOR_SCORE,
  MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY,
  PARTICIPATION_SATURATION_SCALE,
  RECENT_ACTIVITY_HALF_LIFE_MS,
  RECENT_ACTIVITY_SATURATION_SCALE,
  RECENT_ACTIVITY_WINDOW_MS,
  TRUSTED_LEVEL_RAW,
  TRUSTED_DIVERSITY_SATURATION_SCALE,
  TRUSTED_SUBSCRIPTION_SATURATION_SCALE,
  TRUSTED_VISIBLE_MIN_VISIBILITY_SCORE,
  WAVE_SCORE_DEFAULT_BACKFILL_BATCH_SIZE,
  WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS,
  WAVE_SCORE_MAX_BACKFILL_BATCH_SIZE,
  WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS,
  WAVE_SCORE_VERSION,
  WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS
} from './wave-score.constants';

export interface RefreshAllWaveScoresOptions {
  readonly batchSize?: number | undefined;
  readonly maxBatches?: number | undefined;
  readonly startAfterWaveId?: string | undefined;
}

export interface RefreshAllWaveScoresResult {
  readonly batches: number;
  readonly waves: number;
  readonly hasMore: boolean;
  readonly startedAfterWaveId: string | null;
  readonly lastWaveId: string | null;
}

interface WaveScoreInputRow {
  readonly wave_id: string;
  readonly creator_level_raw: number | string | null;
  readonly drops_count: number | string | null;
  readonly latest_drop_timestamp: number | string | null;
  readonly wave_rep_total: number | string | null;
  readonly wave_rep_positive: number | string | null;
  readonly wave_rep_negative: number | string | null;
  readonly wave_rep_contributor_count: number | string | null;
  readonly wave_rep_positive_contributor_count: number | string | null;
  readonly wave_rep_negative_contributor_count: number | string | null;
  readonly total_posts: number | string | null;
  readonly level_weighted_posts: number | string | null;
  readonly trusted_author_count: number | string | null;
  readonly low_trust_drop_count: number | string | null;
  readonly top_author_drops: number | string | null;
  readonly latest_trusted_drop_timestamp: number | string | null;
  readonly recent_level_weighted_posts: number | string | null;
  readonly trusted_subscriber_count: number | string | null;
  readonly trusted_subscription_weight: number | string | null;
  readonly cross_mentions: number | string | null;
}

interface WaveScoreCalculation {
  readonly wave_id: string;
  readonly wave_rep_total: number;
  readonly wave_rep_positive: number;
  readonly wave_rep_negative: number;
  readonly wave_rep_contributor_count: number;
  readonly wave_rep_positive_contributor_count: number;
  readonly wave_rep_negative_contributor_count: number;
  readonly wave_score_version: string;
  readonly wave_visibility_tier: ApiWaveVisibilityTier;
  readonly wave_visibility_rank: number;
  readonly wave_quality_score: number;
  readonly wave_hotness_score: number;
  readonly wave_rep_sort_score: number;
  readonly wave_visibility_score: number;
  readonly wave_creator_score: number;
  readonly wave_level_weighted_participation_score: number;
  readonly wave_trusted_diversity_score: number;
  readonly wave_rep_component_score: number;
  readonly wave_trusted_subscription_score: number;
  readonly wave_recent_trusted_activity_score: number;
  readonly wave_single_actor_penalty: number;
  readonly wave_low_trust_flood_penalty: number;
  readonly wave_cross_post_pressure: number;
  readonly wave_cross_post_penalty: number;
  readonly wave_negative_rep_penalty: number;
  readonly wave_safety_multiplier: number;
  readonly wave_score_calculated_at: number;
}

export class WaveScoreService extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public async refreshWaveScoresForWaveIds(
    waveIds: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    const distinctWaveIds = Array.from(new Set(waveIds)).filter(Boolean);
    if (!distinctWaveIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->refreshWaveScoresForWaveIds`);
    try {
      await this.ensureWaveMetricRows(distinctWaveIds, ctx);
      const inputRows = await this.getScoreInputRows(distinctWaveIds, ctx);
      const calculations = inputRows.map((row) => this.calculate(row));
      await Promise.all(
        calculations.map((calculation) =>
          this.persistCalculation(calculation, ctx)
        )
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->refreshWaveScoresForWaveIds`);
    }
  }

  public async refreshWaveScoresForWaveIdsBestEffort(
    waveIds: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.refreshWaveScoresForWaveIds(waveIds, ctx);
    } catch (error) {
      this.logger.error(`Failed to refresh wave scores for ${waveIds.length}`, {
        waveIds,
        error
      });
    }
  }

  public async refreshAllWaveScores(
    options: RefreshAllWaveScoresOptions = {},
    ctx: RequestContext = {}
  ): Promise<RefreshAllWaveScoresResult> {
    const batchSize = Math.max(
      1,
      Math.min(
        WAVE_SCORE_MAX_BACKFILL_BATCH_SIZE,
        options.batchSize ?? WAVE_SCORE_DEFAULT_BACKFILL_BATCH_SIZE
      )
    );
    const maxBatches = Math.max(
      1,
      options.maxBatches ?? Number.MAX_SAFE_INTEGER
    );
    let batches = 0;
    let waves = 0;
    const startedAfterWaveId = options.startAfterWaveId?.trim() || null;
    let lastWaveId: string | null = startedAfterWaveId;
    let hasMore = false;

    for (;;) {
      if (batches >= maxBatches) {
        hasMore = true;
        break;
      }
      const waveIds = await this.getWaveIdsPage(lastWaveId, batchSize, ctx);
      if (!waveIds.length) {
        hasMore = false;
        break;
      }
      await this.refreshWaveScoresForWaveIds(waveIds, ctx);
      batches += 1;
      waves += waveIds.length;
      lastWaveId = waveIds[waveIds.length - 1];
      hasMore = waveIds.length === batchSize;
      if (!hasMore) {
        break;
      }
    }

    return {
      batches,
      waves,
      hasMore,
      startedAfterWaveId,
      lastWaveId
    };
  }

  private async getWaveIdsPage(
    afterWaveId: string | null,
    batchSize: number,
    ctx: RequestContext
  ): Promise<string[]> {
    const whereClause = afterWaveId ? 'where w.id > :afterWaveId' : '';
    const params = afterWaveId ? { afterWaveId } : {};
    const rows = await this.db.execute<{ id: string }>(
      `
      select w.id
      from ${WAVES_TABLE} w
      ${whereClause}
      order by w.id asc
      limit ${batchSize}
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    return rows.map((row) => row.id);
  }

  private async ensureWaveMetricRows(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<void> {
    const params = waveIds.reduce<Record<string, string>>((acc, waveId, i) => {
      acc[`waveId${i}`] = waveId;
      return acc;
    }, {});
    await this.db.execute(
      `
      insert into ${WAVE_METRICS_TABLE} (wave_id)
      values ${waveIds.map((_, i) => `(:waveId${i})`).join(', ')}
      on duplicate key update wave_id = values(wave_id)
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
  }

  private async getScoreInputRows(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<WaveScoreInputRow[]> {
    return this.db.execute<WaveScoreInputRow>(
      `
      select
        w.id as wave_id,
        creator.level_raw as creator_level_raw,
        coalesce(wm.drops_count, 0) as drops_count,
        coalesce(wm.latest_drop_timestamp, 0) as latest_drop_timestamp,
        coalesce(rep.total_rep, 0) as wave_rep_total,
        coalesce(rep.positive_rep, 0) as wave_rep_positive,
        coalesce(rep.negative_rep, 0) as wave_rep_negative,
        coalesce(rep.contributor_count, 0) as wave_rep_contributor_count,
        coalesce(rep.positive_contributor_count, 0) as wave_rep_positive_contributor_count,
        coalesce(rep.negative_contributor_count, 0) as wave_rep_negative_contributor_count,
        coalesce(part.total_posts, 0) as total_posts,
        coalesce(part.level_weighted_posts, 0) as level_weighted_posts,
        coalesce(part.trusted_author_count, 0) as trusted_author_count,
        coalesce(part.low_trust_drop_count, 0) as low_trust_drop_count,
        coalesce(author_pressure.top_author_drops, 0) as top_author_drops,
        coalesce(part.latest_trusted_drop_timestamp, 0) as latest_trusted_drop_timestamp,
        coalesce(part.recent_level_weighted_posts, 0) as recent_level_weighted_posts,
        coalesce(subs.trusted_subscriber_count, 0) as trusted_subscriber_count,
        coalesce(subs.trusted_subscription_weight, 0) as trusted_subscription_weight,
        coalesce(cross_posts.cross_mentions, 0) as cross_mentions
      from ${WAVES_TABLE} w
        left join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id
        left join ${IDENTITIES_TABLE} creator on creator.profile_id = w.created_by
        left join (
          select
            r.matter_target_id as wave_id,
            sum(r.rating) as total_rep,
            sum(case when r.rating > 0 then r.rating else 0 end) as positive_rep,
            sum(case when r.rating < 0 then r.rating else 0 end) as negative_rep,
            count(distinct case when r.rating <> 0 then r.rater_profile_id end) as contributor_count,
            count(distinct case when r.rating > 0 then r.rater_profile_id end) as positive_contributor_count,
            count(distinct case when r.rating < 0 then r.rater_profile_id end) as negative_contributor_count
          from ${RATINGS_TABLE} r
          where r.matter = :waveRepMatter
            and r.matter_target_id in (:waveIds)
          group by 1
        ) rep on rep.wave_id = w.id
        left join (
          select
            d.wave_id,
            count(*) as total_posts,
            sum(least(100, 100 * log10(1 + greatest(coalesce(i.level_raw, 0), 0)) / log10(1 + :maxLevelRawForScore))) as level_weighted_posts,
            count(distinct case when coalesce(i.level_raw, 0) >= :trustedLevelRaw then d.author_id end) as trusted_author_count,
            sum(case when coalesce(i.level_raw, 0) < :lowTrustLevelRaw then 1 else 0 end) as low_trust_drop_count,
            max(case when coalesce(i.level_raw, 0) >= :trustedLevelRaw then d.created_at else 0 end) as latest_trusted_drop_timestamp,
            sum(
              case when d.created_at >= :recentCutoff
                then least(100, 100 * log10(1 + greatest(coalesce(i.level_raw, 0), 0)) / log10(1 + :maxLevelRawForScore))
                else 0
              end
            ) as recent_level_weighted_posts
          from ${DROPS_TABLE} d
            left join ${IDENTITIES_TABLE} i on i.profile_id = d.author_id
          where d.wave_id in (:waveIds)
          group by 1
        ) part on part.wave_id = w.id
        left join (
          select wave_id, max(author_drop_count) as top_author_drops
          from (
            select d.wave_id, d.author_id, count(*) as author_drop_count
            from ${DROPS_TABLE} d
            where d.wave_id in (:waveIds)
            group by d.wave_id, d.author_id
          ) by_author
          group by wave_id
        ) author_pressure on author_pressure.wave_id = w.id
        left join (
          select
            s.target_id as wave_id,
            count(distinct case when coalesce(i.level_raw, 0) >= :trustedLevelRaw then s.subscriber_id end) as trusted_subscriber_count,
            sum(least(100, 100 * log10(1 + greatest(coalesce(i.level_raw, 0), 0)) / log10(1 + :maxLevelRawForScore))) as trusted_subscription_weight
          from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
            left join ${IDENTITIES_TABLE} i on i.profile_id = s.subscriber_id
          where s.target_type = 'WAVE'
            and s.target_action = 'DROP_CREATED'
            and s.target_id in (:waveIds)
          group by 1
        ) subs on subs.wave_id = w.id
        left join (
          select d.wave_id, count(*) as cross_mentions
          from ${DROPS_TABLE} d
            join ${DROP_MENTIONED_WAVES_TABLE} dmw on dmw.drop_id = d.id
          where d.wave_id in (:waveIds)
            and dmw.wave_id <> d.wave_id
          group by d.wave_id
        ) cross_posts on cross_posts.wave_id = w.id
      where w.id in (:waveIds)
      `,
      {
        waveIds,
        waveRepMatter: RateMatter.WAVE_REP,
        maxLevelRawForScore: MAX_LEVEL_RAW_FOR_SCORE,
        trustedLevelRaw: TRUSTED_LEVEL_RAW,
        lowTrustLevelRaw: LOW_TRUST_LEVEL_RAW,
        recentCutoff: Time.currentMillis() - RECENT_ACTIVITY_WINDOW_MS
      },
      { wrappedConnection: ctx.connection }
    );
  }

  private calculate(row: WaveScoreInputRow): WaveScoreCalculation {
    const now = Time.currentMillis();
    const totalPosts = this.toNumber(row.total_posts);
    const topAuthorDrops = this.toNumber(row.top_author_drops);
    const lowTrustDrops = this.toNumber(row.low_trust_drop_count);
    const crossMentions = this.toNumber(row.cross_mentions);
    const positiveRep = this.toNumber(row.wave_rep_positive);
    const negativeRep = this.toNumber(row.wave_rep_negative);
    const totalRep = this.toNumber(row.wave_rep_total);

    const creatorScore = this.rawLevelScore(row.creator_level_raw);
    const participationScore = this.saturatingScore(
      this.toNumber(row.level_weighted_posts),
      PARTICIPATION_SATURATION_SCALE
    );
    const diversityScore = this.saturatingScore(
      this.toNumber(row.trusted_author_count),
      TRUSTED_DIVERSITY_SATURATION_SCALE
    );
    const subscriptionScore = this.saturatingScore(
      this.toNumber(row.trusted_subscriber_count) +
        this.toNumber(row.trusted_subscription_weight) / 100,
      TRUSTED_SUBSCRIPTION_SATURATION_SCALE
    );
    const recentScore = this.recentTrustedActivityScore(row, now);
    const repScore = this.repComponentScore(totalRep);
    const topAuthorShare = totalPosts > 0 ? topAuthorDrops / totalPosts : 0;
    const lowTrustShare = totalPosts > 0 ? lowTrustDrops / totalPosts : 0;
    const crossPostPressure = totalPosts > 0 ? crossMentions / totalPosts : 0;
    const singleActorPenalty =
      this.clamp((topAuthorShare - 0.55) / 0.45, 0, 1) * 0.35;
    const lowTrustFloodPenalty =
      totalPosts >= 20
        ? this.clamp((lowTrustShare - 0.65) / 0.35, 0, 1) * 0.3
        : 0;
    const crossPostPenalty =
      totalPosts >= 10
        ? this.clamp((crossPostPressure - 0.4) / 0.6, 0, 1) * 0.2
        : 0;
    const negativeRepPenalty =
      this.clamp(
        Math.abs(negativeRep) / (positiveRep + Math.abs(negativeRep) + 100),
        0,
        1
      ) * 0.35;
    const safetyMultiplier = this.clamp(
      1 -
        singleActorPenalty -
        lowTrustFloodPenalty -
        crossPostPenalty -
        negativeRepPenalty,
      0.25,
      1
    );
    const qualityScore =
      (WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS.creator_score * creatorScore +
        WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS.level_weighted_participation_score *
          participationScore +
        WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS.trusted_diversity_score *
          diversityScore +
        WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS.trusted_subscription_score *
          subscriptionScore +
        WAVE_SCORE_QUALITY_COMPONENT_WEIGHTS.wave_rep_component_score *
          repScore) *
      safetyMultiplier;
    const hotnessScore =
      (WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS.recent_trusted_activity_score *
        recentScore +
        WAVE_SCORE_HOTNESS_COMPONENT_WEIGHTS.quality_score * qualityScore) *
      safetyMultiplier;
    const hotnessVisibilityMultiplier = this.clamp(
      qualityScore / MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY,
      0,
      1
    );
    const gatedHotnessScore = hotnessScore * hotnessVisibilityMultiplier;
    const visibilityScore =
      WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS.quality_score * qualityScore +
      WAVE_SCORE_VISIBILITY_COMPONENT_WEIGHTS.gated_hotness_score *
        gatedHotnessScore;
    const tier = this.resolveTier(
      visibilityScore,
      qualityScore,
      gatedHotnessScore
    );
    return {
      wave_id: row.wave_id,
      wave_rep_total: totalRep,
      wave_rep_positive: positiveRep,
      wave_rep_negative: negativeRep,
      wave_rep_contributor_count: this.toNumber(row.wave_rep_contributor_count),
      wave_rep_positive_contributor_count: this.toNumber(
        row.wave_rep_positive_contributor_count
      ),
      wave_rep_negative_contributor_count: this.toNumber(
        row.wave_rep_negative_contributor_count
      ),
      wave_score_version: WAVE_SCORE_VERSION,
      wave_visibility_tier: tier,
      wave_visibility_rank: this.resolveTierRank(tier),
      wave_quality_score: this.roundScore(qualityScore),
      wave_hotness_score: this.roundScore(hotnessScore),
      wave_rep_sort_score: this.roundScore(repScore),
      wave_visibility_score: this.roundScore(visibilityScore),
      wave_creator_score: this.roundScore(creatorScore),
      wave_level_weighted_participation_score:
        this.roundScore(participationScore),
      wave_trusted_diversity_score: this.roundScore(diversityScore),
      wave_rep_component_score: this.roundScore(repScore),
      wave_trusted_subscription_score: this.roundScore(subscriptionScore),
      wave_recent_trusted_activity_score: this.roundScore(recentScore),
      wave_single_actor_penalty: this.roundScore(singleActorPenalty * 100),
      wave_low_trust_flood_penalty: this.roundScore(lowTrustFloodPenalty * 100),
      wave_cross_post_pressure: this.roundScore(crossPostPressure * 100),
      wave_cross_post_penalty: this.roundScore(crossPostPenalty * 100),
      wave_negative_rep_penalty: this.roundScore(negativeRepPenalty * 100),
      wave_safety_multiplier: this.roundScore(safetyMultiplier),
      wave_score_calculated_at: now
    };
  }

  private recentTrustedActivityScore(
    row: WaveScoreInputRow,
    now: number
  ): number {
    const recentTrustedWeight = this.toNumber(row.recent_level_weighted_posts);
    const latestTrustedDropTimestamp = this.toNumber(
      row.latest_trusted_drop_timestamp
    );
    if (recentTrustedWeight <= 0 || latestTrustedDropTimestamp <= 0) {
      return 0;
    }
    const activityScore = this.saturatingScore(
      recentTrustedWeight,
      RECENT_ACTIVITY_SATURATION_SCALE
    );
    const ageMs = Math.max(0, now - latestTrustedDropTimestamp);
    const recencyMultiplier = Math.pow(
      0.5,
      ageMs / RECENT_ACTIVITY_HALF_LIFE_MS
    );
    return activityScore * recencyMultiplier;
  }

  private async persistCalculation(
    calculation: WaveScoreCalculation,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `
      update ${WAVE_METRICS_TABLE}
      set
        wave_rep_total = :wave_rep_total,
        wave_rep_positive = :wave_rep_positive,
        wave_rep_negative = :wave_rep_negative,
        wave_rep_contributor_count = :wave_rep_contributor_count,
        wave_rep_positive_contributor_count = :wave_rep_positive_contributor_count,
        wave_rep_negative_contributor_count = :wave_rep_negative_contributor_count,
        wave_score_version = :wave_score_version,
        wave_visibility_tier = :wave_visibility_tier,
        wave_visibility_rank = :wave_visibility_rank,
        wave_quality_score = :wave_quality_score,
        wave_hotness_score = :wave_hotness_score,
        wave_rep_sort_score = :wave_rep_sort_score,
        wave_visibility_score = :wave_visibility_score,
        wave_creator_score = :wave_creator_score,
        wave_level_weighted_participation_score = :wave_level_weighted_participation_score,
        wave_trusted_diversity_score = :wave_trusted_diversity_score,
        wave_rep_component_score = :wave_rep_component_score,
        wave_trusted_subscription_score = :wave_trusted_subscription_score,
        wave_recent_trusted_activity_score = :wave_recent_trusted_activity_score,
        wave_single_actor_penalty = :wave_single_actor_penalty,
        wave_low_trust_flood_penalty = :wave_low_trust_flood_penalty,
        wave_cross_post_pressure = :wave_cross_post_pressure,
        wave_cross_post_penalty = :wave_cross_post_penalty,
        wave_negative_rep_penalty = :wave_negative_rep_penalty,
        wave_safety_multiplier = :wave_safety_multiplier,
        wave_score_calculated_at = :wave_score_calculated_at
      where wave_id = :wave_id
      `,
      calculation,
      { wrappedConnection: ctx.connection }
    );
  }

  private rawLevelScore(value: number | string | null): number {
    const raw = Math.max(0, this.toNumber(value));
    if (raw <= 0) {
      return 0;
    }
    return this.clamp(
      (100 * Math.log10(1 + raw)) / Math.log10(1 + MAX_LEVEL_RAW_FOR_SCORE),
      0,
      100
    );
  }

  private saturatingScore(value: number, scale: number): number {
    return this.clamp(
      100 * (1 - Math.exp(-Math.max(0, value) / scale)),
      0,
      100
    );
  }

  private repComponentScore(totalRep: number): number {
    if (totalRep === 0) {
      return 50;
    }
    const repMagnitude = Math.min(Math.abs(totalRep), MAX_WAVE_REP_FOR_SCORE);
    const signedSignal =
      (50 * Math.log10(1 + repMagnitude)) /
      Math.log10(1 + MAX_WAVE_REP_FOR_SCORE);
    return this.clamp(50 + Math.sign(totalRep) * signedSignal, 0, 100);
  }

  private resolveTier(
    visibilityScore: number,
    qualityScore: number,
    gatedHotnessScore: number
  ): ApiWaveVisibilityTier {
    if (
      visibilityScore >= TRUSTED_VISIBLE_MIN_VISIBILITY_SCORE &&
      (qualityScore >= MIN_QUALITY_FOR_FULL_HOTNESS_VISIBILITY ||
        gatedHotnessScore >= TRUSTED_VISIBLE_MIN_VISIBILITY_SCORE)
    ) {
      return ApiWaveVisibilityTier.TrustedVisible;
    }
    if (visibilityScore >= EXPLORATION_NEUTRAL_MIN_VISIBILITY_SCORE) {
      return ApiWaveVisibilityTier.ExplorationNeutral;
    }
    if (visibilityScore >= DEMOTED_MIN_VISIBILITY_SCORE) {
      return ApiWaveVisibilityTier.Demoted;
    }
    return ApiWaveVisibilityTier.Suppressed;
  }

  private resolveTierRank(tier: ApiWaveVisibilityTier): number {
    switch (tier) {
      case ApiWaveVisibilityTier.TrustedVisible:
        return 1;
      case ApiWaveVisibilityTier.ExplorationNeutral:
        return 2;
      case ApiWaveVisibilityTier.Demoted:
        return 3;
      case ApiWaveVisibilityTier.Suppressed:
        return 4;
      default:
        return assertUnreachable(tier);
    }
  }

  private roundScore(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private toNumber(value: number | string | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }
    return Number(value) || 0;
  }
}

export const waveScoreService = new WaveScoreService(dbSupplier);

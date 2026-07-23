import { createHash } from 'node:crypto';
import { appFeatures, AppFeatures } from '@/app-features';
import { CompetitionParityCategory } from '@/entities/ICompetition';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  competitionRepository,
  CompetitionRepository
} from '@/competitions/competition.repository';
import {
  CompetitionRoutingRecord,
  CompetitionSnapshot
} from '@/competitions/competition.types';

type SnapshotField = keyof CompetitionSnapshot;

const COMPARISONS: ReadonlyArray<{
  readonly category: CompetitionParityCategory;
  readonly field: SnapshotField;
}> = [
  {
    category: CompetitionParityCategory.CONFIG_FIELD,
    field: 'configuration'
  },
  {
    category: CompetitionParityCategory.ENTRY_MEMBERSHIP,
    field: 'entries'
  },
  {
    category: CompetitionParityCategory.ENTRY_STATUS,
    field: 'entries'
  },
  {
    category: CompetitionParityCategory.CREDIT_AVAILABLE,
    field: 'votes_and_credits'
  },
  {
    category: CompetitionParityCategory.CREDIT_SPEND,
    field: 'votes_and_credits'
  },
  {
    category: CompetitionParityCategory.VOTE_TOTAL,
    field: 'votes_and_credits'
  },
  {
    category: CompetitionParityCategory.LEADERBOARD_ORDER,
    field: 'leaderboard'
  },
  {
    category: CompetitionParityCategory.LEADERBOARD_FIELD,
    field: 'leaderboard'
  },
  {
    category: CompetitionParityCategory.DECISION_DUE_SET,
    field: 'decisions_and_winners'
  },
  {
    category: CompetitionParityCategory.WINNER_SET_OR_ORDER,
    field: 'decisions_and_winners'
  },
  {
    category: CompetitionParityCategory.OUTCOME_OR_DISTRIBUTION,
    field: 'outcomes_and_distributions'
  },
  {
    category: CompetitionParityCategory.PAUSE_HANDLING,
    field: 'pauses'
  },
  {
    category: CompetitionParityCategory.CLAIM_OR_MINT_ELIGIBILITY,
    field: 'capabilities'
  }
];

type SafeLogger = Pick<Logger, 'info' | 'warn'>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export class CompetitionShadowComparator {
  public constructor(
    private readonly repository: CompetitionRepository,
    private readonly features: AppFeatures,
    private readonly logger: SafeLogger = Logger.get(
      CompetitionShadowComparator.name
    ),
    private readonly random: () => number = Math.random
  ) {}

  public shouldSample(): boolean {
    return (
      this.features.isLegacyCompetitionShadowCompareEnabled() &&
      this.random() < this.features.getLegacyCompetitionShadowSampleRate()
    );
  }

  public async compareIfSampled(
    record: CompetitionRoutingRecord,
    loadBaseline: () => Promise<CompetitionSnapshot>,
    loadCandidate: () => Promise<CompetitionSnapshot>,
    ctx: RequestContext
  ): Promise<boolean> {
    if (!this.shouldSample()) return false;
    const [baseline, candidate] = await Promise.all([
      loadBaseline(),
      loadCandidate()
    ]);
    await this.compare(record, baseline, candidate, ctx);
    return true;
  }

  public async compare(
    record: CompetitionRoutingRecord,
    baseline: CompetitionSnapshot,
    candidate: CompetitionSnapshot,
    ctx: RequestContext
  ): Promise<void> {
    for (const comparison of COMPARISONS) {
      const baselineHash = hash(baseline[comparison.field]);
      const candidateHash = hash(candidate[comparison.field]);
      const matched = baselineHash === candidateHash;
      await this.repository.recordParityObservation(
        {
          waveId: record.wave_id,
          competitionId: record.id,
          category: comparison.category,
          matched,
          baselineHash,
          candidateHash,
          baselineStorageMode: baseline.storage_mode,
          candidateStorageMode: candidate.storage_mode,
          baselineConfigVersion: baseline.config_version,
          candidateConfigVersion: candidate.config_version,
          sourceVersion: (process.env.GIT_COMMIT_SHA ?? 'phase-1').slice(0, 64)
        },
        ctx
      );
      const message = `competition parity wave=${record.wave_id} competition=${record.id} category=${comparison.category} matched=${matched}`;
      if (matched) this.logger.info(message);
      else this.logger.warn(message);
    }
  }
}

export const competitionShadowComparator = new CompetitionShadowComparator(
  competitionRepository,
  appFeatures
);

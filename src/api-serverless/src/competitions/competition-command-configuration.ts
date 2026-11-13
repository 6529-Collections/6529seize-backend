import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { nativeCommandConfiguration } from '@/competitions/competition-command-configuration';
import {
  CompetitionRecord,
  competitionRepository
} from '@/competitions/competition.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { RequestContext } from '@/request.context';

function isCommandConfiguration(
  value: unknown
): value is ApiCompetitionDraftInput {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Boolean(
    row.rules &&
    row.participation &&
    row.voting &&
    typeof row.participation === 'object' &&
    'scope' in row.participation &&
    typeof row.voting === 'object' &&
    'scope' in row.voting
  );
}

function commandContract(
  config: ApiCompetitionDraftInput
): ApiCompetitionDraftInput {
  const { winning_max_threshold: _upperThreshold, ...rules } =
    config.rules as ApiCompetitionDraftInput['rules'] & {
      winning_max_threshold?: number | null;
    };
  return { ...config, rules };
}

/** Historical version snapshots keep their original representation. Current
 * commands normalize from native configuration without rewriting that history. */
export async function loadNativeCommandConfiguration(
  record: CompetitionRecord,
  ctx: RequestContext
): Promise<ApiCompetitionDraftInput> {
  const saved = await competitionCommandRepository.getConfiguration<unknown>(
    record.id,
    Number(record.config_version),
    ctx
  );
  if (isCommandConfiguration(saved)) return commandContract(saved);
  const competition = await new NativeCompetitionReader(
    competitionRepository,
    ctx
  ).getCompetition(record, Date.now());
  return commandContract(nativeCommandConfiguration(competition));
}

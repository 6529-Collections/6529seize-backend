import { Competition } from '@/competitions/competition.types';
import {
  CompetitionCapability,
  CompetitionEntryStatus
} from '@/entities/ICompetition';
import { validateMainStageMediaSize } from '@/drops/main-stage-media-validator';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { BadRequestException } from '@/exceptions';
import { numbers } from '@/numbers';
import { ConnectionWrapper } from '@/sql-executor';
import { WaveIdentitySubmissionDuplicates } from '@/entities/IWave';

const nativeContentPermits = new WeakSet<object>();
export type NativeEntryContentPermit = Readonly<{
  competitionId: string;
  waveId: string;
  authorId: string;
  dropId: string | null;
  connection: ConnectionWrapper<unknown>;
}>;

/** Only server code may mint this after transactional native authorization. */
export function nativeEntryContentPermit(
  value: NativeEntryContentPermit
): NativeEntryContentPermit {
  const permit = Object.freeze({ ...value });
  nativeContentPermits.add(permit);
  return permit;
}

export function isNativeEntryContentPermit(
  permit: NativeEntryContentPermit | undefined,
  model: CreateOrUpdateDropModel,
  connection: ConnectionWrapper<unknown>
): boolean {
  return (
    !!permit &&
    nativeContentPermits.has(permit) &&
    permit.connection === connection &&
    permit.waveId === model.wave_id &&
    permit.authorId === model.author_id &&
    permit.dropId === model.drop_id &&
    model.drop_type === DropType.PARTICIPATORY &&
    model.drop_id === null &&
    model.signature === null
  );
}

export function assertCompetitionEntryContent(
  competition: Competition,
  model: CreateOrUpdateDropModel
): void {
  if (model.reply_to || model.parts.some((part) => part.quoted_drop))
    throw new BadRequestException(
      'Competition entries cannot be replies or quote drops'
    );
  for (const required of competition.participation.required_metadata) {
    const values = model.metadata.filter(
      (item) => item.data_key === required.name
    );
    if (!values.length)
      throw new BadRequestException(
        `Competition requires metadata ${String(required.name)}`
      );
    if (
      required.type === 'NUMBER' &&
      !values.some((item) => numbers.parseIntOrNull(item.data_value) !== null)
    ) {
      throw new BadRequestException(
        `Competition requires metadata ${String(required.name)} to be a number`
      );
    }
  }
  const media = model.parts.flatMap((part) => part.media);
  const prefixes: Record<string, string> = {
    IMAGE: 'image/',
    VIDEO: 'video/',
    AUDIO: 'audio/'
  };
  for (const required of competition.participation.required_media) {
    const prefix = prefixes[required];
    if (!prefix || !media.some((item) => item.mime_type.startsWith(prefix)))
      throw new BadRequestException(
        `Competition requires media of type ${required}`
      );
  }
}

export async function assertCompetitionEntryMedia(
  competition: Competition,
  model: CreateOrUpdateDropModel
): Promise<void> {
  if (!competition.capabilities.includes(CompetitionCapability.MAIN_STAGE))
    return;
  for (const media of model.parts.flatMap((part) => part.media)) {
    await validateMainStageMediaSize(media.url);
  }
}

export function assertCompetitionNominationDuplicates(
  policy: string | null,
  statuses: readonly CompetitionEntryStatus[]
): void {
  if (policy === WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW) return;
  const current = statuses.filter(
    (status) =>
      status === CompetitionEntryStatus.ACTIVE ||
      status === CompetitionEntryStatus.WINNER
  );
  if (policy === WaveIdentitySubmissionDuplicates.NEVER_ALLOW && current.length)
    throw new BadRequestException(
      'This identity has already been nominated in this competition'
    );
  if (
    policy === WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN &&
    current.includes(CompetitionEntryStatus.ACTIVE)
  )
    throw new BadRequestException(
      'This identity already has an active nomination in this competition'
    );
  if (
    ![
      WaveIdentitySubmissionDuplicates.NEVER_ALLOW,
      WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN
    ].includes(policy as WaveIdentitySubmissionDuplicates)
  )
    throw new BadRequestException(
      'Competition identity duplicate policy is misconfigured'
    );
}

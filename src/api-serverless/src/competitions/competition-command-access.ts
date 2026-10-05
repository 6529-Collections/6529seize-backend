import { appFeatures } from '@/app-features';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import {
  assertWaveAndParentVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import {
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorisedException
} from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { Competition } from '@/competitions/competition.types';
import { isCompetitionDecisionPending } from '@/competitions/competition-decision-gate';

export function competitionActor(ctx: RequestContext): string {
  const actor = ctx.authenticationContext?.getActingAsId();
  if (!actor || !ctx.authenticationContext?.isUserFullyAuthenticated())
    throw new UnauthorisedException('Authentication required');
  return actor;
}

export async function visibleCompetitionWave(
  waveId: string,
  ctx: RequestContext
) {
  const groups = await getGroupsUserIsEligibleForReadContext(
    userGroupsService,
    ctx
  );
  const wave = await assertWaveAndParentVisibleOrThrow({
    wave: await wavesApiDb.findWaveById(waveId, ctx.connection),
    groupsUserIsEligibleFor: groups,
    message: 'Wave not found',
    wavesApiDb,
    ctx
  });
  return { wave, groups };
}

export async function administerCompetitionWave(
  waveId: string,
  ctx: RequestContext
) {
  const actor = competitionActor(ctx);
  const visible = await visibleCompetitionWave(waveId, ctx);
  if (
    !ctx.authenticationContext?.hasRightsTo(
      ProfileProxyActionType.CREATE_WAVE
    ) ||
    (visible.wave.created_by !== actor &&
      (!visible.wave.admin_group_id ||
        !visible.groups.includes(visible.wave.admin_group_id)))
  ) {
    throw new ForbiddenException(
      'Only wave administrators can manage competitions'
    );
  }
  return visible;
}

export function requireNativeWrites(): void {
  if (!appFeatures.isNativeCompetitionWritesEnabled())
    throw new NotFoundException('Competition commands are not enabled');
}

export async function lockNativeCompetition(
  waveId: string,
  competitionId: string,
  version: number,
  ctx: RequestContext
) {
  const record = await competitionCommandRepository.lockCompetition(
    waveId,
    competitionId,
    ctx
  );
  if (record.storage_mode !== CompetitionStorageMode.NATIVE)
    competitionConflict('Use the original wave commands for this competition');
  if (Number(record.config_version) !== version)
    competitionConflict('Competition rules changed. Reload before retrying');
  const competition = await new NativeCompetitionReader(
    competitionRepository,
    ctx
  ).getCompetition(record, Date.now());
  return { record, competition };
}

export function assertCompetitionOpen(
  competition: Competition,
  now: number,
  action: 'submit' | 'vote'
): void {
  if (
    competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
    competition.execution_mode !== CompetitionExecutionMode.ACTIVE ||
    !appFeatures.isNativeCompetitionExecutionEnabled()
  )
    competitionConflict('Competition is not accepting entries or votes');
  const period =
    action === 'submit' ? competition.participation : competition.voting;
  if (
    (period.starts_at !== null && now < period.starts_at) ||
    (period.ends_at !== null && now > period.ends_at)
  ) {
    competitionConflict(
      action === 'submit' ? 'Participation is closed' : 'Voting is closed'
    );
  }
  if (isCompetitionDecisionPending(competition, now)) {
    competitionConflict(
      'A competition decision is being finalized. Retry shortly'
    );
  }
}

export async function assertCompetitionGroup(
  groupId: string | null,
  action: ProfileProxyActionType,
  ctx: RequestContext
): Promise<void> {
  if (
    !ctx.authenticationContext?.hasRightsTo(action) ||
    (groupId !== null &&
      !(
        await userGroupsService.getGroupsUserIsEligibleForByIds(
          competitionActor(ctx),
          [groupId],
          ctx.timer
        )
      ).includes(groupId))
  ) {
    throw new ForbiddenException(
      'You are not eligible for this competition action'
    );
  }
}

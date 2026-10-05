import { administerCompetitionWave } from '@/api/competitions/competition-command-access';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { AuthenticationContext } from '@/auth-context';
import {
  CompetitionLifecycle,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import {
  competitionCommandRepository,
  competitionConflict
} from './competition-command.repository';
import {
  CompetitionCapabilityChange,
  competitionCapabilityRepository
} from './competition-capability.repository';

export class CompetitionCapabilityService {
  private async assertPublicHub(
    waveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const visited = new Set<string>();
    let currentId: string | null = waveId;
    while (currentId) {
      if (visited.has(currentId))
        competitionConflict('Invalid parent-wave relationship');
      visited.add(currentId);
      const wave = await wavesApiDb.findWaveById(currentId, ctx.connection);
      if (!wave || wave.visibility_group_id !== null || wave.is_direct_message)
        competitionConflict(
          'Privileged competitions require a public wave and public parents'
        );
      currentId = wave.parent_wave_id;
    }
  }

  public async change(
    change: CompetitionCapabilityChange,
    idempotencyKey: string,
    dryRun: boolean,
    ctx: RequestContext
  ) {
    const operators = (
      process.env.NATIVE_COMPETITION_CAPABILITY_OPERATORS ?? ''
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!operators.includes(change.actorId))
      throw new ForbiddenException(
        'This identity is not an allowlisted competition capability operator'
      );
    const operatorContext = {
      ...ctx,
      authenticationContext: AuthenticationContext.fromProfileId(change.actorId)
    };
    await administerCompetitionWave(change.waveId, operatorContext);
    const execute = async (tx: RequestContext) => {
      const competition = await competitionCommandRepository.lockCompetition(
        change.waveId,
        change.competitionId,
        tx
      );
      await administerCompetitionWave(change.waveId, tx);
      if (change.action === 'assign')
        await this.assertPublicHub(change.waveId, tx);
      if (competition.storage_mode !== CompetitionStorageMode.NATIVE)
        competitionConflict('Legacy capability assignments are immutable');
      if (
        ![CompetitionLifecycle.DRAFT, CompetitionLifecycle.PUBLISHED].includes(
          competition.lifecycle
        ) ||
        (await competitionCommandRepository.hasActivity(
          change.competitionId,
          tx
        ))
      ) {
        competitionConflict(
          'Capability assignments are immutable after the first entry or a terminal state'
        );
      }
      await competitionCapabilityRepository.change(change, dryRun, tx);
      return { ...change, dry_run: dryRun };
    };
    if (dryRun)
      return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        execute({ ...operatorContext, connection })
      );
    return competitionCommandRepository.command(
      change.actorId,
      idempotencyKey,
      { action: 'capability', change },
      execute,
      operatorContext
    );
  }
}

export const competitionCapabilityService = new CompetitionCapabilityService();

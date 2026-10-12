import { Competition } from '@/competitions/competition.types';
import {
  competitionEntryRepository,
  NativeDropEntry
} from '@/competitions/competition-entry.repository';
import {
  assertCompetitionNominationDuplicates,
  NativeEntryContentPermit
} from '@/competitions/competition-entry-content';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropEntity } from '@/entities/IDrop';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';

export type NativeEntryEdit = {
  readonly entries: readonly NativeDropEntry[];
  readonly permit?: NativeEntryContentPermit;
  readonly metadata?: CreateOrUpdateDropModel['metadata'];
};

export class CompetitionEntryDropHooks {
  public async hasActiveEntry(
    dropId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    return (await competitionEntryRepository.findDropEntries(dropId, ctx)).some(
      (entry) => entry.status === CompetitionEntryStatus.ACTIVE
    );
  }
  public async prepareUpdate(
    model: CreateOrUpdateDropModel,
    _normalizeIdentity: (competition: Competition) => Promise<void>,
    ctx: RequestContext
  ): Promise<NativeEntryEdit> {
    if (!model.drop_id || !ctx.connection)
      throw new Error('Entry update requires an existing transactional drop');
    const entries = await competitionEntryRepository.lockDropMemberships(
      model.drop_id,
      ctx
    );
    if (
      entries.some(
        (entry) =>
          !entry.legacy_origin || entry.status === CompetitionEntryStatus.WINNER
      )
    )
      throw new ForbiddenException('Competition submissions cannot be edited');
    return { entries };
  }

  public async preparePresentationUpdate(
    _drop: DropEntity,
    entries: readonly NativeDropEntry[],
    _ctx: RequestContext
  ): Promise<NativeEntryEdit> {
    if (
      entries.some(
        (entry) =>
          !entry.legacy_origin || entry.status === CompetitionEntryStatus.WINNER
      )
    )
      throw new ForbiddenException('Competition submissions cannot be edited');
    return { entries };
  }

  public async recordUpdate(
    edit: NativeEntryEdit,
    drop: DropEntity,
    actorId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!edit.entries.length) return;
    const content = await competitionEntryRepository.loadDropContent(drop, ctx);
    for (const entry of edit.entries) {
      const revision = await competitionEntryRepository.saveContent(
        entry,
        { ...content, metadata: edit.metadata ?? content.metadata },
        actorId,
        undefined,
        ctx
      );
      await nativeCompetitionRuntimeRepository.enqueueEvent(
        {
          key: `entry-content:${entry.id}:${revision}`,
          event_type: 'COMPETITION_ENTRY_UPDATED',
          occurred_at: Date.now(),
          wave_id: entry.wave_id,
          competition_id: entry.competition_id,
          competition_entry_id: entry.id,
          drop_id: entry.drop_id,
          data: { content_revision: revision }
        },
        ctx
      );
    }
  }

  public lockForDelete(
    dropId: string,
    ctx: RequestContext
  ): Promise<NativeDropEntry[]> {
    return competitionEntryRepository.lockDropMemberships(dropId, ctx);
  }

  public async beforeDelete(
    _drop: DropEntity,
    entries: readonly NativeDropEntry[],
    actorId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    for (const entry of entries) {
      await competitionEntryRepository.deleteEntry(entry.id, ctx);
      await nativeCompetitionRuntimeService.refreshCompetition(
        entry.competition_id,
        Date.now(),
        ctx
      );
      await nativeCompetitionRuntimeRepository.enqueueEvent(
        {
          key: `entry-deleted:${entry.id}`,
          event_type: 'COMPETITION_ENTRY_DELETED',
          occurred_at: Date.now(),
          wave_id: entry.wave_id,
          competition_id: entry.competition_id,
          competition_entry_id: entry.id,
          drop_id: entry.drop_id,
          data: { reason: 'DROP_DELETED', actor_id: actorId }
        },
        ctx
      );
    }
  }
}

export async function assertNativeEntryNomination(
  competition: Competition,
  model: CreateOrUpdateDropModel,
  excludedEntryId: string | null,
  ctx: RequestContext
): Promise<void> {
  if (competition.participation.submission_type !== 'IDENTITY') return;
  const nominated = model.metadata.find(
    (item) => item.data_key === 'identity'
  )?.data_value;
  if (!nominated) throw new Error('Identity nomination was not normalized');
  const statuses = await competitionEntryRepository.findNominationStatuses(
    competition.id,
    nominated,
    excludedEntryId,
    ctx
  );
  assertCompetitionNominationDuplicates(
    competition.participation.identity_submission_duplicates,
    statuses
  );
}

export const competitionEntryDropHooks = new CompetitionEntryDropHooks();

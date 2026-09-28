import {
  assertCompetitionGroup,
  assertCompetitionOpen,
  visibleCompetitionWave
} from '@/api/competitions/competition-command-access';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { Competition } from '@/competitions/competition.types';
import {
  competitionEntryRepository,
  NativeDropEntry
} from '@/competitions/competition-entry.repository';
import {
  assertCompetitionEntryContent,
  assertCompetitionEntryMedia,
  assertCompetitionNominationDuplicates,
  nativeEntryContentPermit,
  NativeEntryContentPermit
} from '@/competitions/competition-entry-content';
import {
  CompetitionEntryStatus,
  CompetitionLifecycle
} from '@/entities/ICompetition';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropEntity, DropType } from '@/entities/IDrop';
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
    normalizeIdentity: (competition: Competition) => Promise<void>,
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
          entry.signed || entry.status === CompetitionEntryStatus.WINNER
      )
    )
      throw new ForbiddenException(
        'Signed competition entries and winner content cannot be edited'
      );
    const editable: NativeDropEntry[] = [];
    for (const entry of entries) {
      if (entry.status !== CompetitionEntryStatus.ACTIVE) continue;
      const record = await competitionCommandRepository.lockCompetition(
        entry.wave_id,
        entry.competition_id,
        ctx
      );
      if (!record)
        throw new Error('Competition entry configuration is missing');
      const competition = await new NativeCompetitionReader(
        competitionRepository,
        ctx
      ).getCompetition(record, Date.now());
      if (competition.lifecycle !== CompetitionLifecycle.PUBLISHED) continue;
      const { groups } = await visibleCompetitionWave(competition.wave_id, ctx);
      assertCompetitionGroup(
        competition.participation.group_id,
        groups,
        ProfileProxyActionType.CREATE_DROP_TO_WAVE,
        ctx
      );
      assertCompetitionOpen(competition, Date.now(), 'submit');
      assertCompetitionEntryContent(competition, model);
      await assertCompetitionEntryMedia(competition, model);
      await normalizeIdentity(competition);
      await assertNativeEntryNomination(competition, model, entry.id, ctx);
      editable.push(entry);
    }
    const first = editable[0];
    return {
      entries: editable,
      metadata: model.metadata,
      permit: first
        ? nativeEntryContentPermit({
            competitionId: first.competition_id,
            waveId: model.wave_id,
            authorId: model.author_id!,
            dropId: model.drop_id,
            connection: ctx.connection
          })
        : undefined
    };
  }

  public async preparePresentationUpdate(
    drop: DropEntity,
    entries: readonly NativeDropEntry[],
    ctx: RequestContext
  ): Promise<NativeEntryEdit> {
    if (!entries.length) return { entries: [] };
    const content = await competitionEntryRepository.loadDropContent(drop, ctx);
    const active = entries.find(
      (entry) => entry.status === CompetitionEntryStatus.ACTIVE
    );
    const snapshot = active
      ? await competitionEntryRepository.getContent(active.id, ctx)
      : null;
    // Presentation changes retain the already-resolved nomination. Resolving an
    // old handle/ENS again could silently nominate a different person.
    const model: CreateOrUpdateDropModel = {
      ...content,
      metadata: snapshot?.metadata ?? content.metadata,
      drop_id: drop.id,
      author_id: drop.author_id,
      author_identity: drop.author_id,
      drop_type: DropType.CHAT,
      signature: null,
      is_additional_action_promised: null
    };
    return this.prepareUpdate(model, async () => {}, ctx);
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
    drop: DropEntity,
    entries: readonly NativeDropEntry[],
    actorId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    for (const entry of entries) {
      if (!(await competitionEntryRepository.getContent(entry.id, ctx))) {
        await competitionEntryRepository.saveContent(
          entry,
          await competitionEntryRepository.loadDropContent(drop, ctx),
          actorId ?? drop.author_id,
          undefined,
          ctx
        );
      }
      if (entry.status !== CompetitionEntryStatus.ACTIVE) continue;
      await competitionEntryRepository.setStatus(
        entry.id,
        CompetitionEntryStatus.DISQUALIFIED,
        Date.now(),
        ctx
      );
      await nativeCompetitionRuntimeService.refreshCompetition(
        entry.competition_id,
        Date.now(),
        ctx
      );
      await nativeCompetitionRuntimeRepository.enqueueEvent(
        {
          key: `entry-deleted:${entry.id}`,
          event_type: 'COMPETITION_ENTRY_DISQUALIFIED',
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

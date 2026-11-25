import { Logger } from '@/logging';
import { WaveEntity } from '@/entities/IWave';
import { InsertWaveEntity } from '@/api/waves/waves.api.db';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { isWaveCreatorOrAdmin } from '@/waves/wave-admin.helpers';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { configurationToRecord } from '@/api/competitions/competition-configuration';
import {
  CompetitionEntity,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionType
} from '@/entities/ICompetition';
import { BadRequestException } from '@/exceptions';
import {
  ChainNativeDecision,
  chainNativeDecisionOf,
  decisionDraftOf,
  hasOutcomeTemplate,
  parseDecisionDocument,
  templateOutcomes
} from './waves-chain-mirror.decisions';
import { DOC_CLASS, DocumentSource } from './waves-chain-mirror.docs';
import { ContentGate } from './waves-chain-mirror.gate';
import {
  ChainGroup,
  chainGroupOf,
  groupRowOf,
  groupShapeOf,
  GroupMember,
  nativeGroupName
} from './waves-chain-mirror.groups';
import {
  groupListId,
  nativeCompetitionId,
  waveDescriptionDropId
} from './waves-chain-mirror.ids';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';
import {
  MirroredDecision,
  MirroredGroup,
  MirroredWave,
  WavesChainObjectsDb
} from './waves-chain-mirror.objects.db';
import { PlanCounter, retryDelayMs } from './waves-chain-mirror.plan-support';
import {
  ChainWave,
  chainWaveOf,
  checkedWaveRequest,
  EMPTY_DESCRIPTION,
  isChainOwnedWave,
  metadataChangesOf,
  parseWaveDocument,
  sameDescription,
  validMetadataOf,
  WaveDocument,
  WaveDocumentPart,
  WaveGroups,
  WaveHubFields,
  waveHubPatchOf,
  waveIdOf,
  waveWrittenKey
} from './waves-chain-mirror.waves';

const logger = Logger.get('WAVES_CHAIN_MIRROR_OBJECTS');

/** How a pass over the chain's groups or waves went. */
export interface ObjectCounts {
  mirrored: number;
  unchanged: number;
  waiting: number;
  failed: number;
  /** Objects the run had no time left for. */
  left: number;
}

export interface ObjectsReport {
  readonly groups: ObjectCounts;
  readonly waves: ObjectCounts;
  /** Decisions made on the chain: their competitions rows. */
  readonly decisions: ObjectCounts;
}

export function emptyObjectsReport(): ObjectsReport {
  const counts = (): ObjectCounts => ({
    mirrored: 0,
    unchanged: 0,
    waiting: 0,
    failed: 0,
    left: 0
  });
  return { groups: counts(), waves: counts(), decisions: counts() };
}

/** 6529.io's effects after a write commits, and its services the pass asks. */
export interface ObjectEffects {
  /** A group's rows changed: its caches, and the members it may move. */
  groupsChanged(groupIds: string[], profileIds: string[]): Promise<void>;
  /** A wave was created or its groups changed (the creator follows it). */
  waveChanged(input: {
    readonly waveId: string;
    readonly groupIds: string[];
    readonly followerId: string | null;
  }): Promise<void>;
  /** The groups a profile is in (a parent wave's rule). */
  eligibleGroups(profileId: string): Promise<string[]>;
  /** The wave row 6529.io's create maps a request to. */
  newWaveEntity(input: {
    readonly id: string;
    readonly createdAt: number;
    readonly request: ApiCreateNewWave;
    readonly createdBy: string;
    readonly descriptionDropId: string;
  }): Promise<InsertWaveEntity>;
  /**
   * 6529.io's own checks of a competition config against its wave (the
   * create's relation and outcome checks): a BadRequestException refuses it.
   */
  checkCompetition(
    draft: ApiCompetitionDraftInput,
    wave: WaveEntity
  ): Promise<void>;
  /**
   * When a decision was made on the chain: the time of the block its first
   * policy version took effect at. Null when the chain can't say.
   */
  decisionCreatedAt(decisionId: string): Promise<number | null>;
}

export type ObjectsStore = Pick<
  WavesChainObjectsDb,
  | 'chainGroupsToMirror'
  | 'chainGroupsByIds'
  | 'chainWavesToMirror'
  | 'creationEvent'
  | 'mirroredGroups'
  | 'saveMirroredGroup'
  | 'mirroredWaves'
  | 'saveMirroredWave'
  | 'importedGroupId'
  | 'profilesOfAddresses'
  | 'addAddressIdentities'
  | 'groupRow'
  | 'waveRow'
  | 'dropParts'
  | 'waveMetadata'
  | 'writeGroup'
  | 'createWave'
  | 'replaceDescription'
  | 'editWave'
  | 'writeMetadata'
  | 'inTransaction'
  | 'chainDecisionsToMirror'
  | 'waveIdOfChainWave'
  | 'blockTimeAt'
  | 'mirroredDecisions'
  | 'saveMirroredDecision'
  | 'nativeCompetition'
  | 'writeNativeCompetition'
  | 'mode'
>;

/** An imported group no row matched is looked for again after this. */
const UNMATCHED_RETRY_MS = 24 * 60 * 60_000;

/**
 * identity_subscriptions.target_id is varchar(50): a wave id longer (a
 * chain id is 66 characters) can't be followed until it is widened. When
 * the column-widening change widens it to 100, this becomes 100 and the
 * chain waves written before get their creator's follow by a backfill.
 */
export const FOLLOW_TARGET_MAX = 50;

const WAVE_DOCUMENT_MISSING = 'wave_document_missing';
const DESCRIPTION_REFUSED = 'description_moderation';
const DESCRIPTION_DEFERRED = 'description_moderation_deferred';

type Outcome = 'mirrored' | 'unchanged' | 'waiting';

/** A run's waves made on the chain that a child may wait for as parent. */
interface ParentWaits {
  /** Chain wave ids that may still get a row, this run or later. */
  readonly pending: ReadonlySet<string>;
  /** Each child that waited: the parent it waited for, and its own time. */
  readonly waiting: Map<
    string,
    { readonly parentId: string; readonly createdAt: number }
  >;
}

const WAIT_FOR_PARENT = Symbol('wait for parent');
/** A child waits this long after it was made for a parent made on the chain. */
export const PARENT_WAIT_MS = 24 * 60 * 60_000;

/** Whether a decision made on the chain has a policy version to write. */
function decisionDue(
  decision: ChainNativeDecision,
  record: MirroredDecision | undefined,
  now: number
): 'due' | 'unchanged' | 'waiting' {
  if (!record) return 'due';
  if (record.written !== null && record.written >= decision.configVersion) {
    return 'unchanged';
  }
  if (record.held && record.heldVersion === decision.configVersion) {
    // A delay until its retry; a refusal until the chain's next version.
    return record.retryAt !== null && record.retryAt <= now ? 'due' : 'waiting';
  }
  return 'due';
}

/**
 * The competitions row of a decision made on the chain, as 6529.io's
 * create makes one from a draft: kept off 6529.io's own runtime
 * (DISABLED: the chain counts it), a draft until the decisions pass moves
 * its lifecycle as the chain's.
 */
export function nativeCompetitionRecord(
  draft: ApiCompetitionDraftInput,
  input: {
    readonly id: string;
    readonly waveId: string;
    readonly chainId: string;
    readonly configVersion: number;
    readonly createdAt: number;
    readonly now: number;
  }
): CompetitionEntity {
  return configurationToRecord(draft, {
    id: input.id,
    wave_id: input.waveId,
    legacy_wave_id: null,
    chain_id: input.chainId,
    execution_mode: CompetitionExecutionMode.DISABLED,
    lifecycle: CompetitionLifecycle.DRAFT,
    type: CompetitionType.RANK,
    title: '',
    description: null,
    presentation_config: [],
    participation_config: {},
    voting_config: {},
    decision_config: {},
    winner_config: {},
    outcome_config: [],
    config_version: input.configVersion,
    participation_starts_at: null,
    participation_ends_at: null,
    voting_starts_at: null,
    voting_ends_at: null,
    created_at: input.createdAt,
    updated_at: input.now,
    published_at: null,
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  });
}

/** A description's parts as the moderation gate takes a drop's content. */
function descriptionContent(
  parts: readonly WaveDocumentPart[]
): NativeEntryContent {
  return {
    title: null,
    parts: parts.map((part) => ({
      content: part.content,
      quotedDropId: null,
      quotedDropPartId: null,
      media: part.media.map((m) => ({
        url: m.url,
        mimeType: m.mime_type,
        mediaUploadId: null
      }))
    })),
    metadata: [],
    referencedNfts: [],
    mentionedUsers: [],
    mentionedWaves: [],
    mentionedGroups: [],
    hideLinkPreview: false,
    isAdditionalActionPromised: null,
    collaboratorIds: [],
    attachmentsLeftOut: 0
  };
}

/**
 * The chain's groups and waves in 6529.io's tables: groups
 * first (a wave names them), then waves. Each run takes every group and
 * wave the chain owns (made on the chain, or an imported one the chain
 * replaced) and passes over those whose chain state is the one it last
 * wrote, so a run costs two reads when nothing moved. A report-only run
 * counts what it would write and writes nothing.
 */
export class WavesChainObjectsMirror {
  constructor(
    private readonly store: ObjectsStore,
    private readonly principals: (
      ids: readonly string[]
    ) => Promise<Map<string, string>>,
    private readonly effects: ObjectEffects,
    private readonly gate: ContentGate,
    private readonly clock: () => number
  ) {}

  async run(input: {
    readonly write: boolean;
    readonly documents: DocumentSource;
    readonly counter: PlanCounter;
    readonly outOfTime: () => boolean;
  }): Promise<ObjectsReport> {
    const report = emptyObjectsReport();
    const now = this.clock();
    const groups = (await this.store.chainGroupsToMirror()).map(chainGroupOf);
    const groupRecords = await this.store.mirroredGroups(
      groups.map((g) => g.groupId)
    );
    for (const group of groups) {
      const record = groupRecords.get(group.groupId);
      if (record && record.version === group.version) {
        report.groups.unchanged++;
        continue;
      }
      if (input.outOfTime()) {
        report.groups.left++;
        continue;
      }
      await this.count(report.groups, `group ${group.groupId}`, () =>
        this.mirrorGroup(group, record, input, now)
      );
    }
    const waves = (await this.store.chainWavesToMirror())
      .map(chainWaveOf)
      .filter(isChainOwnedWave);
    const waveRecords = await this.store.mirroredWaves(
      waves.map((w) => w.waveId)
    );
    // Waves made on the chain that may still get a row: a child naming one
    // as its parent waits for it (chain ids sort in no useful order).
    let parents: ParentWaits = {
      pending: new Set(
        waves
          .filter((w) => w.origin === 'native')
          .filter((w) => {
            // Not written yet, and not refused for good: a wave held for a
            // retry (a document still on its way) may still be written.
            const r = waveRecords.get(w.waveId);
            return (
              !r ||
              (r.written === null &&
                (r.retryAt !== null || r.metadataCid !== w.metadataCid))
            );
          })
          .map((w) => w.waveId)
      ),
      waiting: new Map()
    };
    const pass = async (list: readonly ChainWave[]) => {
      for (const wave of list) {
        const record = waveRecords.get(wave.waveId);
        const due = this.waveDue(wave, record, now);
        if (due === 'unchanged') {
          report.waves.unchanged++;
          continue;
        }
        if (due === 'waiting') {
          report.waves.waiting++;
          input.counter.wait(`wave_held_${record?.held ?? 'unknown'}`);
          continue;
        }
        if (input.outOfTime()) {
          report.waves.left++;
          continue;
        }
        await this.count(report.waves, `wave ${wave.waveId}`, () =>
          this.mirrorWave(wave, record, input, now, parents)
        );
      }
    };
    await pass(waves);
    // Once more, with no waiting: the children whose parent was written
    // since, or waited for a parent of its own (6529.io keeps a parent
    // only if it is a top-level wave). The others wait for a later run.
    const waited = parents.waiting;
    const again: ChainWave[] = [];
    for (const wave of waves) {
      const child = waited.get(wave.waveId);
      if (child === undefined) continue;
      if (
        waited.has(child.parentId) ||
        (await this.store.waveRow(child.parentId))
      ) {
        again.push(wave);
      } else if (now - child.createdAt >= PARENT_WAIT_MS) {
        // Waited a day: created on its own, so it takes drops. A wave's
        // parent is set only when it is created (6529.io's update takes
        // none), so it stays a top-level wave.
        logger.warn(
          `[WAVE ${wave.waveId}] created without its parent ${child.parentId}, not written a day after`
        );
        input.counter.wait('wave_parent_wait_over');
        again.push(wave);
      }
    }
    input.counter.wait('wave_parent_not_mirrored', waited.size - again.length);
    if (again.length) {
      report.waves.waiting -= again.length;
      parents = { pending: new Set(), waiting: new Map() };
      await pass(again);
    }
    await this.mirrorDecisions(input, now, report);
    return report;
  }

  private async count(
    counts: ObjectCounts,
    what: string,
    action: () => Promise<Outcome>
  ): Promise<void> {
    try {
      counts[await action()]++;
    } catch (error) {
      counts.failed++;
      logger.error(`[WAVES CHAIN MIRROR] ${what} failed: ${error}`);
    }
  }

  // ------------------------------------------------------------ groups

  private async mirrorGroup(
    group: ChainGroup,
    record: MirroredGroup | undefined,
    input: { readonly write: boolean; readonly counter: PlanCounter },
    now: number
  ): Promise<Outcome> {
    const { counter } = input;
    const wait = (reason: string): Outcome => {
      counter.wait(reason);
      return 'waiting';
    };
    const def = group.definition;
    if (!def) return wait('group_unreadable');
    const shape = groupShapeOf(def);
    if (!shape.ok) return wait(shape.reason);
    let groupId: string | null = group.groupId;
    if (group.origin !== 'native') {
      groupId = await this.importedGroupId(group, record, input.write, now);
      if (!groupId) return wait('imported_group_unmatched');
    }
    const existing = await this.store.groupRow(groupId);
    if (group.origin !== 'native' && !existing) {
      return wait('imported_group_missing');
    }
    const members = [...(shape.includes ?? []), ...shape.excludes];
    const principalIds = [
      ...(group.controller ? [group.controller] : []),
      ...(shape.criteria.rep_rater ? [shape.criteria.rep_rater] : []),
      ...members.filter((m) => m.kind === 'principal').map((m) => m.value)
    ];
    const profiles = await this.principals(principalIds);
    const repUser = shape.criteria.rep_rater
      ? (profiles.get(shape.criteria.rep_rater) ?? null)
      : null;
    if (shape.criteria.rep_rater && !repUser) {
      return wait('group_rater_unmapped');
    }
    if (members.some((m) => m.kind === 'principal' && !profiles.has(m.value))) {
      return wait('group_member_unmapped');
    }
    const controllerProfile = group.controller
      ? (profiles.get(group.controller) ?? null)
      : null;
    const createdBy = controllerProfile ?? existing?.created_by ?? null;
    if (!createdBy) return wait('group_controller_unmapped');
    // The driver may read a datetime back as text.
    let createdAt = existing ? new Date(existing.created_at) : null;
    if (!createdAt) {
      const created = await this.store.creationEvent(
        'GROUP_CREATED',
        group.groupId
      );
      const time = created?.time ?? group.activeFrom;
      if (!time) return wait('group_without_time');
      createdAt = new Date(time);
    }
    const includeListId = shape.includes?.length
      ? groupListId(group.groupId, group.version, 'include')
      : null;
    const excludeListId = shape.excludes.length
      ? groupListId(group.groupId, group.version, 'exclude')
      : null;
    const row = groupRowOf({
      id: groupId,
      name: existing?.name ?? nativeGroupName(group.groupId),
      createdAt,
      createdBy,
      criteria: shape.criteria,
      repUser,
      includeListId,
      excludeListId,
      visible: existing ? !!existing.visible : true,
      isPrivate: existing ? !!existing.is_private : false
    });
    const addresses = members
      .filter((m) => m.kind === 'address')
      .map((m) => m.value);
    const known = await this.store.profilesOfAddresses(addresses);
    const unknown = addresses.filter((a) => !known.has(a));
    if (unknown.length && this.store.mode === 'rebuild') {
      // A rebuild takes address-only identities from the identity area's
      // own rebuild, never makes them.
      counter.wait('group_address_identity_missing');
      return 'waiting';
    }
    counter.change('community_groups', existing ? 'update' : 'insert');
    counter.change(
      'profile_groups',
      'insert',
      (shape.includes?.length ?? 0) + shape.excludes.length
    );
    counter.change('identities', 'insert', unknown.length);
    if (!input.write) return 'mirrored';
    const touched = await this.store.inTransaction(async (connection) => {
      let profilesOfAddresses = known;
      if (unknown.length) {
        // As 6529.io's group create does for a listed address.
        await this.store.addAddressIdentities(unknown, connection);
        profilesOfAddresses = new Map([
          ...Array.from(known),
          ...Array.from(
            await this.store.profilesOfAddresses(unknown, connection)
          )
        ]);
      }
      const profileOf = (m: GroupMember): string | null =>
        m.kind === 'principal'
          ? (profiles.get(m.value) ?? null)
          : (profilesOfAddresses.get(m.value) ?? null);
      const listOf = (list: readonly GroupMember[] | null) =>
        (list ?? []).map(profileOf).filter((p): p is string => p !== null);
      const changed = await this.store.writeGroup(
        {
          row,
          replaces: !!existing,
          includes: listOf(shape.includes),
          excludes: listOf(shape.excludes),
          oldListIds: [
            existing?.profile_group_id ?? null,
            existing?.excluded_profile_group_id ?? null,
            record?.includeListId ?? null,
            record?.excludeListId ?? null
          ].filter((id): id is string => !!id)
        },
        connection
      );
      await this.store.saveMirroredGroup(
        group.groupId,
        {
          groupId: groupId!,
          version: group.version,
          includeListId,
          excludeListId
        },
        now,
        connection
      );
      return changed;
    });
    await this.effects.groupsChanged([groupId], touched);
    return 'mirrored';
  }

  /** An imported group's community_groups id, kept once found. */
  private async importedGroupId(
    group: Pick<ChainGroup, 'groupId' | 'legacyId'>,
    record: MirroredGroup | undefined,
    write: boolean,
    now: number
  ): Promise<string | null> {
    if (record?.groupId) return record.groupId;
    if (!group.legacyId) return null;
    if (record && now - record.updatedAt < UNMATCHED_RETRY_MS) return null;
    const found = await this.store.importedGroupId(group.legacyId);
    if (write) {
      await this.store.saveMirroredGroup(
        group.groupId,
        {
          groupId: found ?? '',
          version: null,
          includeListId: null,
          excludeListId: null
        },
        now
      );
    }
    return found;
  }

  /**
   * 6529.io's ids of a wave's groups: a group made on the chain once the
   * mirror wrote it, an imported group's own row. A wave waits for a group
   * that has neither.
   */
  private async waveGroups(
    wave: ChainWave,
    write: boolean,
    now: number
  ): Promise<
    | { ok: true; groups: WaveGroups; chatWait: string | null }
    | { ok: false; reason: string }
  > {
    const ids = [wave.readGroupId, wave.postGroupId, wave.adminGroupId].filter(
      (id): id is string => id !== null
    );
    const { mapped, failed } = await this.mappedGroups(ids, write, now);
    // The read and admin groups are needed; the post group only while chat
    // is on (with chat off the import made it the admin group or a group of
    // the controller alone, which 6529.io has no row of).
    const read = wave.readGroupId;
    const post = wave.postGroupId;
    for (const id of [read, wave.adminGroupId]) {
      if (id && failed.has(id)) return { ok: false, reason: failed.get(id)! };
    }
    const of = (id: string | null) => (id ? (mapped.get(id) ?? null) : null);
    return {
      ok: true,
      groups: {
        visibility: of(read),
        chat: of(post),
        admin: of(wave.adminGroupId)
      },
      chatWait: post ? (failed.get(post) ?? null) : null
    };
  }

  /**
   * 6529.io's group ids of chain groups: a group made (or replaced) on the
   * chain once it is written, an imported one matched to its row. The
   * others are `failed`, with the reason.
   */
  private async mappedGroups(
    ids: readonly string[],
    write: boolean,
    now: number
  ): Promise<{ mapped: Map<string, string>; failed: Map<string, string> }> {
    const chain = new Map(
      (await this.store.chainGroupsByIds(ids)).map((row) => {
        const group = chainGroupOf(row);
        return [group.groupId, group];
      })
    );
    const records = await this.store.mirroredGroups(ids);
    const mapped = new Map<string, string>();
    const failed = new Map<string, string>();
    for (const id of Array.from(new Set(ids))) {
      const group = chain.get(id);
      const record = records.get(id);
      if (!group) {
        failed.set(id, 'wave_group_unknown');
      } else if (group.origin === 'native' || group.version > 1) {
        if (!record || record.version === null || !record.groupId) {
          failed.set(id, 'wave_group_not_mirrored');
        } else {
          mapped.set(id, record.groupId);
        }
      } else {
        const found = await this.importedGroupId(group, record, write, now);
        if (found) mapped.set(id, found);
        else failed.set(id, 'wave_group_unmatched');
      }
    }
    return { mapped, failed };
  }

  // ------------------------------------------------------------ waves

  private waveDue(
    wave: ChainWave,
    record: MirroredWave | undefined,
    now: number
  ): 'due' | 'unchanged' | 'waiting' {
    if (!record) return 'due';
    const retryDue = record.retryAt !== null && record.retryAt <= now;
    if (record.written === null) {
      // Held before it was written: a delay until its retry, a refusal
      // until the chain names another document.
      if (record.retryAt !== null) return retryDue ? 'due' : 'waiting';
      return record.metadataCid === wave.metadataCid ? 'waiting' : 'due';
    }
    if (record.written !== waveWrittenKey(wave)) return 'due';
    return record.held && retryDue ? 'due' : 'unchanged';
  }

  private async mirrorWave(
    wave: ChainWave,
    record: MirroredWave | undefined,
    input: {
      readonly write: boolean;
      readonly documents: DocumentSource;
      readonly counter: PlanCounter;
    },
    now: number,
    parents: ParentWaits
  ): Promise<Outcome> {
    const { counter } = input;
    const waveId = waveIdOf(wave);
    const groups = await this.waveGroups(wave, input.write, now);
    if (!groups.ok) {
      counter.wait(groups.reason);
      return 'waiting';
    }
    // An imported wave only closed keeps 6529.io's fields: no document.
    const document =
      wave.origin === 'native' || wave.policyVersion > 1
        ? await this.document(wave, input.documents)
        : ({ kind: 'none' } as const);
    const existing = await this.store.waveRow(waveId);
    if (!existing) {
      if (wave.origin !== 'native') {
        counter.wait('imported_wave_missing');
        return 'waiting';
      }
      return this.createWave(
        wave,
        waveId,
        record,
        groups.groups,
        groups.chatWait,
        document,
        input,
        now,
        parents
      );
    }
    return this.updateWave(
      wave,
      existing,
      record,
      groups.groups,
      groups.chatWait,
      document,
      input,
      now
    );
  }

  /** A wave's document: read, missing from the store, or refused. */
  private async document(
    wave: ChainWave,
    documents: DocumentSource
  ): Promise<
    | { kind: 'read'; doc: WaveDocument }
    | { kind: 'none' | 'missing' }
    | { kind: 'refused'; reason: string }
  > {
    if (!wave.metadataCid) return { kind: 'none' };
    let bytes: Uint8Array | null;
    try {
      bytes = await documents.get(wave.metadataCid, DOC_CLASS.WAVE);
    } catch (error) {
      logger.warn(
        `[WAVES CHAIN MIRROR] wave ${wave.waveId}: document not read: ${error}`
      );
      bytes = null;
    }
    if (!bytes) return { kind: 'missing' };
    const read = parseWaveDocument(bytes);
    return read.ok
      ? { kind: 'read', doc: read.doc }
      : { kind: 'refused', reason: read.reason };
  }

  /** Holds a wave back, or its description: for good, or until a retry. */
  private async hold(
    wave: ChainWave,
    record: MirroredWave | undefined,
    fields: Pick<MirroredWave, 'waveId'> & Partial<MirroredWave>,
    reason: string,
    delay: boolean,
    write: boolean,
    now: number
  ): Promise<void> {
    if (!write) return;
    const attempts = (record?.held === reason ? record.attempts : 0) + 1;
    await this.store.saveMirroredWave(
      wave.waveId,
      {
        written: record?.written ?? null,
        metadataCid: record?.metadataCid ?? null,
        metadataKeys: record?.metadataKeys ?? [],
        ...fields,
        held: reason,
        retryAt: delay ? now + retryDelayMs(attempts) : null,
        attempts
      },
      now
    );
  }

  /**
   * A description's parts after pre-publication moderation, as 6529.io's
   * create runs it on a description drop. Refused or deferred, the parts
   * are left out (null) and the reason held.
   */
  private async moderated(
    parts: readonly WaveDocumentPart[],
    subject: {
      readonly dropId: string;
      readonly authorId: string;
      readonly waveId: string;
    },
    write: boolean
  ): Promise<{
    parts: readonly WaveDocumentPart[] | null;
    held: string | null;
  }> {
    if (!write || !parts.some((part) => part.content?.trim())) {
      return { parts, held: null };
    }
    const verdict = await this.gate.check({
      dropId: subject.dropId,
      authorProfileId: subject.authorId,
      waveId: subject.waveId,
      content: descriptionContent(parts)
    });
    if (verdict.kind === 'allowed') return { parts, held: null };
    return {
      parts: null,
      held:
        verdict.kind === 'refused' ? DESCRIPTION_REFUSED : DESCRIPTION_DEFERRED
    };
  }

  private async createWave(
    wave: ChainWave,
    waveId: string,
    record: MirroredWave | undefined,
    groups: WaveGroups,
    chatWait: string | null,
    document: Awaited<ReturnType<WavesChainObjectsMirror['document']>>,
    input: { readonly write: boolean; readonly counter: PlanCounter },
    now: number,
    parents: ParentWaits
  ): Promise<Outcome> {
    const { counter, write } = input;
    if (document.kind !== 'read') {
      const reason =
        document.kind === 'missing'
          ? WAVE_DOCUMENT_MISSING
          : document.kind === 'refused'
            ? document.reason
            : 'wave_without_document';
      await this.hold(
        wave,
        record,
        { waveId, metadataCid: wave.metadataCid },
        reason,
        document.kind === 'missing',
        write,
        now
      );
      counter.wait(reason);
      return 'waiting';
    }
    const { doc } = document;
    const created = await this.store.creationEvent('WAVE_CREATED', wave.waveId);
    const creator = created?.actor ?? wave.controller;
    const profiles = await this.principals(creator ? [creator] : []);
    const creatorId = creator ? (profiles.get(creator) ?? null) : null;
    if (!creatorId) {
      counter.wait('wave_creator_unmapped');
      return 'waiting';
    }
    const createdAt = created?.time ?? doc.createdAt;
    if (!createdAt) {
      counter.wait('wave_without_time');
      return 'waiting';
    }
    const chatEnabled = doc.chat.enabled && wave.status !== 'closed';
    if (chatEnabled && chatWait) {
      counter.wait(chatWait);
      return 'waiting';
    }
    let parentWaveId: string | null = null;
    if (doc.parentWave) {
      const parent = await this.allowedParent(
        doc.parentWave,
        creatorId,
        wave.waveId,
        parents
      );
      if (parent === WAIT_FOR_PARENT) {
        // Not created yet: created once its parent has a row (this run's
        // second pass, or a later run). The run counts the wait.
        parents.waiting.set(wave.waveId, {
          parentId: doc.parentWave.toLowerCase(),
          createdAt
        });
        return 'waiting';
      }
      parentWaveId = parent;
      if (!parentWaveId) counter.wait('wave_parent_left_out');
    }
    const checked = checkedWaveRequest({
      doc,
      groups: { ...groups, chat: chatEnabled ? groups.chat : null },
      chatEnabled,
      parentWaveId
    });
    if (!checked.ok) {
      await this.hold(
        wave,
        record,
        { waveId, metadataCid: wave.metadataCid },
        checked.reason,
        false,
        write,
        now
      );
      counter.wait(checked.reason);
      return 'waiting';
    }
    for (const field of checked.dropped) counter.wait(`wave_${field}_left_out`);
    const descriptionDropId = waveDescriptionDropId(wave.waveId);
    const request = checked.request;
    const docParts: WaveDocumentPart[] = request.description_drop.parts.map(
      (part) => ({
        content: part.content ?? null,
        media: (part.media ?? []).map((m) => ({
          url: m.url,
          mime_type: m.mime_type
        }))
      })
    );
    const moderated = await this.moderated(
      docParts,
      { dropId: descriptionDropId, authorId: creatorId, waveId },
      write
    );
    if (moderated.held) counter.wait(moderated.held);
    const { valid: metadata, dropped } = validMetadataOf(doc.metadata);
    counter.wait('wave_metadata_left_out', dropped);
    counter.change('waves', 'insert');
    counter.change('drops', 'insert');
    counter.change(
      'waves_metadatas',
      'insert',
      Object.keys(metadata ?? {}).length
    );
    const follow = waveId.length <= FOLLOW_TARGET_MAX;
    if (follow) counter.change('identity_subscriptions', 'insert');
    else counter.wait('wave_creator_follow_id_too_long');
    if (!write) return 'mirrored';
    const entity = await this.effects.newWaveEntity({
      id: waveId,
      createdAt,
      request,
      createdBy: creatorId,
      descriptionDropId
    });
    const attempts =
      moderated.held && record?.held === moderated.held
        ? record.attempts + 1
        : 1;
    await this.store.inTransaction(async (connection) => {
      await this.store.createWave(
        {
          entity,
          description: {
            dropId: descriptionDropId,
            authorId: creatorId,
            createdAt,
            parts: moderated.parts ?? EMPTY_DESCRIPTION
          },
          metadata: metadata ?? {},
          follow
        },
        connection
      );
      await this.store.saveMirroredWave(
        wave.waveId,
        {
          waveId,
          written: waveWrittenKey(wave),
          metadataCid: wave.metadataCid,
          metadataKeys: Object.keys(metadata ?? {}),
          held: moderated.held,
          retryAt:
            moderated.held === DESCRIPTION_DEFERRED
              ? now + retryDelayMs(attempts)
              : null,
          attempts: moderated.held ? attempts : 0
        },
        now,
        connection
      );
    });
    await this.effects.waveChanged({
      waveId,
      groupIds: [groups.visibility, groups.chat, groups.admin].filter(
        (id): id is string => id !== null
      ),
      followerId: creatorId
    });
    return 'mirrored';
  }

  /**
   * The parent a wave made on the chain may keep, as 6529.io's create
   * allows it: a top-level wave, not a DM, that its creator made or
   * administers (and can see). Null otherwise.
   */
  private async allowedParent(
    parentId: string,
    creatorId: string,
    childId: string,
    parents: ParentWaits
  ): Promise<string | null | typeof WAIT_FOR_PARENT> {
    const parent = await this.store.waveRow(parentId);
    if (!parent) {
      // A wave made on the chain that may still get its row: wait for it.
      const id = parentId.toLowerCase();
      return id !== childId && parents.pending.has(id) ? WAIT_FOR_PARENT : null;
    }
    if (parent.parent_wave_id !== null || parent.is_direct_message) {
      return null;
    }
    const eligible = await this.effects.eligibleGroups(creatorId);
    return isWaveCreatorOrAdmin({
      authenticatedProfileId: creatorId,
      wave: parent,
      groupIdsUserIsEligibleFor: eligible
    })
      ? parent.id
      : null;
  }

  // ------------------------------------------------------------ decisions

  /**
   * Decisions made on the chain, as 6529.io's competitions: each new
   * policy version once (the decisions pass then writes their entries,
   * votes, boards and results, and moves their lifecycle).
   */
  private async mirrorDecisions(
    input: {
      readonly write: boolean;
      readonly documents: DocumentSource;
      readonly counter: PlanCounter;
      readonly outOfTime: () => boolean;
    },
    now: number,
    report: ObjectsReport
  ): Promise<void> {
    const rows = await this.store.chainDecisionsToMirror();
    const records = await this.store.mirroredDecisions(
      rows.map((row) => row.decision_id)
    );
    for (const row of rows) {
      const read = chainNativeDecisionOf(row);
      if (!read.ok) {
        report.decisions.waiting++;
        input.counter.wait(read.reason);
        continue;
      }
      const decision = read.value;
      const record = records.get(decision.decisionId);
      const due = decisionDue(decision, record, now);
      if (due === 'unchanged') {
        report.decisions.unchanged++;
        continue;
      }
      if (due === 'waiting') {
        report.decisions.waiting++;
        input.counter.wait(`decision_held_${record?.held ?? 'unknown'}`);
        continue;
      }
      if (input.outOfTime()) {
        report.decisions.left++;
        continue;
      }
      await this.count(
        report.decisions,
        `decision ${decision.decisionId}`,
        () => this.mirrorDecision(decision, record, input, now)
      );
    }
  }

  private async mirrorDecision(
    decision: ChainNativeDecision,
    record: MirroredDecision | undefined,
    input: {
      readonly write: boolean;
      readonly documents: DocumentSource;
      readonly counter: PlanCounter;
    },
    now: number
  ): Promise<Outcome> {
    const { counter, write } = input;
    const { config } = decision;
    const competitionId = nativeCompetitionId(decision.decisionId);
    const hold = async (reason: string, delay: boolean): Promise<Outcome> => {
      counter.wait(reason);
      if (write) {
        const attempts =
          (record?.held === reason &&
          record.heldVersion === decision.configVersion
            ? record.attempts
            : 0) + 1;
        await this.store.saveMirroredDecision(
          decision.decisionId,
          {
            competitionId,
            written: record?.written ?? null,
            held: reason,
            heldVersion: decision.configVersion,
            retryAt: delay ? now + retryDelayMs(attempts) : null,
            attempts
          },
          now
        );
      }
      return 'waiting';
    };
    // Its wave, as 6529.io has it.
    const waveId = await this.store.waveIdOfChainWave(decision.waveId);
    const wave = await this.store.waveRow(waveId);
    if (!wave) {
      counter.wait('decision_wave_not_mirrored');
      return 'waiting';
    }
    const groupIds = [decision.submitGroupId, decision.voteGroupId].filter(
      (id): id is string => id !== null
    );
    const groups = await this.mappedGroups(groupIds, write, now);
    for (const id of groupIds) {
      const reason = groups.failed.get(id);
      if (reason) {
        counter.wait(reason.replace(/^wave_/, 'decision_'));
        return 'waiting';
      }
    }
    let creditorId: string | null = null;
    if (config.creditor) {
      creditorId =
        (await this.principals([config.creditor])).get(config.creditor) ?? null;
      if (!creditorId) {
        counter.wait('decision_creditor_unmapped');
        return 'waiting';
      }
    }
    // Its document, and the outcome template the config commits to.
    if (!decision.metadataCid) return hold('decision_without_document', false);
    const bytes = await this.read(
      input.documents,
      decision.metadataCid,
      DOC_CLASS.DECISION
    );
    if (!bytes) return hold('decision_document_missing', true);
    const doc = parseDecisionDocument(bytes);
    if (!doc.ok) return hold(doc.reason, false);
    let outcomes: unknown[] = [];
    if (hasOutcomeTemplate(config)) {
      const cid = doc.value.outcomeTemplateCid;
      if (!cid) return hold('decision_outcomes_unnamed', false);
      const template = await this.read(
        input.documents,
        cid,
        DOC_CLASS.OUTCOME_TEMPLATE
      );
      if (!template) return hold('decision_outcomes_missing', true);
      const read = templateOutcomes(template, config.outcomeTemplateHash);
      if (!read.ok) return hold(read.reason, false);
      outcomes = read.value;
    }
    const built = decisionDraftOf({
      doc: doc.value,
      config,
      submitGroupId: decision.submitGroupId
        ? groups.mapped.get(decision.submitGroupId)!
        : null,
      voteGroupId: decision.voteGroupId
        ? groups.mapped.get(decision.voteGroupId)!
        : null,
      creditorId,
      outcomes
    });
    if (!built.ok) {
      if (built.detail) {
        logger.warn(
          `[DECISION ${decision.decisionId}] ${built.reason}: ${built.detail}`
        );
      }
      return hold(built.reason, false);
    }
    const { draft, differences } = built.value;
    if (differences.length) {
      logger.info(
        `[DECISION ${decision.decisionId}] the chain's rules over its document's: ${differences.join(', ')}`
      );
    }
    try {
      await this.effects.checkCompetition(draft, wave);
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      logger.warn(
        `[DECISION ${decision.decisionId}] refused by 6529.io's checks: ${error.message}`
      );
      return hold('decision_config_refused', false);
    }
    const existing = await this.store.nativeCompetition(competitionId);
    if (existing && existing.configVersion >= decision.configVersion) {
      // Written before (a record lost): the record catches up.
      if (write) {
        await this.store.saveMirroredDecision(
          decision.decisionId,
          {
            competitionId,
            written: existing.configVersion,
            held: null,
            heldVersion: null,
            retryAt: null,
            attempts: 0
          },
          now
        );
      }
      return 'unchanged';
    }
    counter.change('competitions', existing ? 'update' : 'insert');
    counter.change('competition_config_versions', 'insert');
    if (!existing) counter.change('competition_lifecycle_events', 'insert');
    if (!write) return 'mirrored';
    // Its creation block's time; else, deterministic still, the chain's
    // time at its row's height.
    const createdAt =
      existing?.createdAt ??
      (await this.effects.decisionCreatedAt(decision.decisionId)) ??
      (await this.store.blockTimeAt(decision.height)) ??
      now;
    const record_ = nativeCompetitionRecord(draft, {
      id: competitionId,
      waveId: wave.id,
      chainId: decision.decisionId,
      configVersion: decision.configVersion,
      createdAt,
      now
    });
    await this.store.inTransaction(async (connection) => {
      // Locked: a run that wrote it meanwhile leaves it as it is.
      const locked = await this.store.nativeCompetition(
        competitionId,
        connection
      );
      if (locked && locked.configVersion >= decision.configVersion) return;
      await this.store.writeNativeCompetition(
        { record: record_, draft, create: !locked, now },
        connection
      );
      await this.store.saveMirroredDecision(
        decision.decisionId,
        {
          competitionId,
          written: decision.configVersion,
          held: null,
          heldVersion: null,
          retryAt: null,
          attempts: 0
        },
        now,
        connection
      );
    });
    return 'mirrored';
  }

  /** A document's bytes; null when no store has it (or it can't be read). */
  private async read(
    documents: DocumentSource,
    cid: string,
    docClass: number
  ): Promise<Uint8Array | null> {
    try {
      return await documents.get(cid, docClass);
    } catch (error) {
      logger.warn(`[WAVES CHAIN MIRROR] document ${cid} not read: ${error}`);
      return null;
    }
  }

  private async updateWave(
    wave: ChainWave,
    existing: WaveEntity,
    record: MirroredWave | undefined,
    groups: WaveGroups,
    chatWait: string | null,
    document: Awaited<ReturnType<WavesChainObjectsMirror['document']>>,
    input: { readonly write: boolean; readonly counter: PlanCounter },
    now: number
  ): Promise<Outcome> {
    const { counter, write } = input;
    const waveId = existing.id;
    // An imported wave takes its document only once the chain replaced its
    // policy; one only closed keeps 6529.io's own fields.
    const doc =
      document.kind === 'read' &&
      (wave.origin === 'native' || wave.policyVersion > 1)
        ? document.doc
        : null;
    if (document.kind === 'refused') counter.wait(document.reason);
    if (document.kind === 'missing') counter.wait(WAVE_DOCUMENT_MISSING);
    const docChanged =
      doc !== null && (!record || record.metadataCid !== wave.metadataCid);
    const descriptionRetry =
      !!record?.held?.startsWith('description') &&
      record.retryAt !== null &&
      record.retryAt <= now;
    let chatEnabled = existing.chat_enabled;
    if (doc && docChanged) chatEnabled = doc.chat.enabled;
    if (wave.status === 'closed') chatEnabled = false;
    if (chatEnabled && chatWait) {
      counter.wait(chatWait);
      return 'waiting';
    }
    const target: { -readonly [K in keyof WaveHubFields]?: WaveHubFields[K] } =
      {
        visibility_group_id: groups.visibility,
        admin_group_id: groups.admin,
        chat_enabled: chatEnabled,
        ...(chatEnabled ? { chat_group_id: groups.chat } : {})
      };
    let descriptionParts: readonly WaveDocumentPart[] | null = null;
    if (doc && docChanged) {
      const checked = checkedWaveRequest({
        doc,
        groups,
        chatEnabled,
        parentWaveId: null
      });
      if (checked.ok) {
        target.name = checked.request.name;
        target.picture = checked.request.picture ?? null;
        target.chat_links_disabled = doc.chat.linksDisabled;
        target.chat_slow_mode_cooldown_ms = doc.chat.slowModeCooldownMs;
        if (doc.chat.repliesOpen !== null) {
          target.chat_replies_open = doc.chat.repliesOpen;
        }
        if (doc.chat.repliesCollapsed !== null) {
          target.chat_replies_collapsed = doc.chat.repliesCollapsed;
        }
        target.admin_drop_deletion_enabled = doc.adminDropDeletionEnabled;
        for (const field of checked.dropped) {
          counter.wait(`wave_${field}_left_out`);
        }
        descriptionParts = checked.dropped.includes('description')
          ? null
          : doc.description.length
            ? doc.description
            : EMPTY_DESCRIPTION;
      } else {
        counter.wait(checked.reason);
      }
    } else if (doc && descriptionRetry) {
      descriptionParts = doc.description.length
        ? doc.description
        : EMPTY_DESCRIPTION;
    }
    const controllerProfile = wave.controller
      ? ((await this.principals([wave.controller])).get(wave.controller) ??
        null)
      : null;
    const createdBy =
      controllerProfile && controllerProfile !== existing.created_by
        ? controllerProfile
        : null;
    const patch = waveHubPatchOf(existing, target);
    const edits = Object.keys(patch).length > 0 || createdBy !== null;
    // The description, when the document changed it.
    let description: {
      parts: readonly WaveDocumentPart[];
      authorId: string;
    } | null = null;
    // A description held stays held until it is judged again.
    let held: string | null = record?.held?.startsWith('description')
      ? record.held
      : null;
    if (descriptionParts) {
      const current = await this.store.dropParts(existing.description_drop_id);
      if (current && !sameDescription(current.parts, descriptionParts)) {
        const moderated = await this.moderated(
          descriptionParts,
          {
            dropId: existing.description_drop_id,
            authorId: current.authorId,
            waveId
          },
          write
        );
        held = moderated.held;
        if (moderated.parts) {
          description = { parts: moderated.parts, authorId: current.authorId };
        } else {
          counter.wait(moderated.held!);
        }
      } else if (current) {
        held = null;
      }
    }
    let metadata: ReturnType<typeof metadataChangesOf> | null = null;
    let metadataKeys = record?.metadataKeys ?? [];
    if (doc && docChanged) {
      const { valid, dropped } = validMetadataOf(doc.metadata);
      counter.wait('wave_metadata_left_out', dropped);
      metadata = metadataChangesOf({
        current: await this.store.waveMetadata(waveId),
        next: valid,
        writtenBefore: metadataKeys
      });
      metadataKeys = Object.keys(valid ?? {});
    }
    if (edits) counter.change('waves', 'update');
    if (description) counter.change('drops_parts', 'update');
    if (metadata) {
      counter.change('waves_metadatas', 'insert', metadata.upsert.length);
      counter.change('waves_metadatas', 'delete', metadata.remove.length);
    }
    const writes =
      edits ||
      !!description ||
      !!(metadata && (metadata.upsert.length || metadata.remove.length));
    if (!write) return writes ? 'mirrored' : 'unchanged';
    // The document is written once it is read; a missing one is asked
    // for again later.
    const docDone = document.kind !== 'missing';
    const docHeld = docDone ? held : WAVE_DOCUMENT_MISSING;
    const attempts =
      docHeld && record?.held === docHeld ? record.attempts + 1 : 1;
    const groupsMoved =
      patch.visibility !== undefined ||
      patch.admin_group !== undefined ||
      patch.chat?.scope !== undefined ||
      patch.chat?.enabled !== undefined;
    await this.store.inTransaction(async (connection) => {
      if (edits) {
        await this.store.editWave({ waveId, patch, createdBy }, connection);
      }
      if (description) {
        await this.store.replaceDescription(
          {
            dropId: existing.description_drop_id,
            waveId,
            parts: description.parts,
            at: now
          },
          connection
        );
      }
      if (metadata)
        await this.store.writeMetadata(waveId, metadata, connection);
      await this.store.saveMirroredWave(
        wave.waveId,
        {
          waveId,
          written: docDone ? waveWrittenKey(wave) : (record?.written ?? null),
          metadataCid:
            doc && docChanged
              ? wave.metadataCid
              : (record?.metadataCid ?? null),
          metadataKeys,
          held: docHeld,
          retryAt:
            docHeld === DESCRIPTION_DEFERRED ||
            docHeld === WAVE_DOCUMENT_MISSING
              ? now + retryDelayMs(attempts)
              : null,
          attempts: docHeld ? attempts : 0
        },
        now,
        connection
      );
    });
    if (groupsMoved || createdBy) {
      await this.effects.waveChanged({
        waveId,
        groupIds: [
          existing.visibility_group_id,
          existing.chat_group_id,
          existing.admin_group_id,
          groups.visibility,
          groups.chat,
          groups.admin
        ].filter((id): id is string => id !== null),
        followerId: null
      });
    }
    return writes ? 'mirrored' : 'unchanged';
  }
}

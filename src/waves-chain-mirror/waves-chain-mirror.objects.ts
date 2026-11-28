import { Logger } from '@/logging';
import type { ConnectionWrapper } from '@/sql-executor';
import { WaveEntity } from '@/entities/IWave';
import { InsertWaveEntity } from '@/api/waves/waves.api.db';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
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
import type { EntryHold } from './waves-chain-mirror.db';
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
  InvalidLegacyIds,
  nativeCompetitionId,
  waveDescriptionDropId
} from './waves-chain-mirror.ids';
import {
  ImportedDecisionDoc,
  importedCompetitionRecord,
  parseImportedDecisionDoc
} from './waves-chain-mirror.legacy-rows';
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
  DESCRIPTION_DEFERRED,
  DESCRIPTION_REFUSED,
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
  /**
   * Decisions made on the chain: their competitions rows (and in a
   * rebuild, imported ones 6529.io has none of).
   */
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
  /**
   * Whether the chain counts `principal` a manager of the chain wave
   * `waveId` (a parent wave's rule): the gateway's
   * /v1/waves/{waveId}/rights/{principal}, isManager, read at `height`
   * (the chain index's read height; null: the client's pin). Null when
   * the gateway can't say.
   */
  waveManager(input: {
    readonly waveId: string;
    readonly principal: string;
    readonly height: number | null;
  }): Promise<boolean | null>;
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
  | 'descriptionHold'
  | 'holdDescription'
  | 'releaseDescription'
  | 'carryDescriptionHolds'
  | 'importedGroupId'
  | 'profilesOfAddresses'
  | 'addAddressIdentities'
  | 'identityRowsReached'
  | 'ownRowsWithoutProfile'
  | 'groupsHeld'
  | 'groupsHeldReported'
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
  | 'chainImportedDecisions'
  | 'competitionExists'
  | 'importedDescriptionDropId'
  | 'descriptionDropInWave'
  | 'chainImportedGroups'
  | 'insertImportedWave'
  | 'chainWaveIdOf'
  | 'insertImportedCompetition'
  | 'mode'
>;

/** An imported group no row matched is looked for again after this. */
const UNMATCHED_RETRY_MS = 24 * 60 * 60_000;

/**
 * Groups held this long for the identity mirror are reported (one WARN per
 * hold, tag GROUPS HELD FOR IDENTITY ROWS).
 */
export const GROUPS_HELD_REPORT_MS = 15 * 60_000;

/** Listed addresses still without a profile id after their identities. */
class AddressesWithoutProfile extends Error {
  constructor(readonly addresses: readonly string[]) {
    super(`addresses without a profile id: ${addresses.join(', ')}`);
    // The build's target needs this for instanceof on an Error subclass.
    Object.setPrototypeOf(this, AddressesWithoutProfile.prototype);
  }
}

/**
 * identity_subscriptions.target_id is varchar(50): a wave id longer (a
 * chain id is 66 characters) can't be followed until it is widened. When
 * the column-widening change widens it to 100, this becomes 100 and the
 * chain waves written before get their creator's follow by a backfill.
 */
export const FOLLOW_TARGET_MAX = 50;

const WAVE_DOCUMENT_MISSING = 'wave_document_missing';

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

/**
 * A named parent's fate: kept, left out (the wave is written without it),
 * or the wave waits for a read that failed; each but the kept with the
 * reason the run counts.
 */
type ParentChoice =
  | { readonly kind: 'keep'; readonly id: string }
  | { readonly kind: 'leave'; readonly reason: string }
  | { readonly kind: 'wait'; readonly reason: string }
  | typeof WAIT_FOR_PARENT;
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
    /** Objects left out for a legacy id that isn't an RFC 4122 UUID. */
    readonly legacyIds?: InvalidLegacyIds;
    /**
     * The chain index's read height (the highest height an index run read
     * at, so at or above every row it holds): the chain's answers the pass
     * asks for are read there, so they see what the index saw. Null or
     * absent: at the gateway client's pin.
     */
    readonly height?: number | null;
  }): Promise<ObjectsReport> {
    const report = emptyObjectsReport();
    const now = this.clock();
    const legacyIds =
      input.legacyIds ??
      new InvalidLegacyIds((message) =>
        logger.warn(`[WAVES CHAIN MIRROR] ${message}`)
      );
    if (input.write) await this.store.carryDescriptionHolds(now);
    // A group's legacy id is never checked as a UUID: it feeds no uuid v5,
    // and is matched by its short id, or the import's keccak fallback.
    const groups = (await this.store.chainGroupsToMirror()).map(chainGroupOf);
    const groupRecords = await this.store.mirroredGroups(
      groups.map((g) => g.groupId)
    );
    // The chain heights of the groups held for the identity mirror this run.
    const held: number[] = [];
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
        this.mirrorGroup(group, record, { ...input, held }, now)
      );
    }
    // Only a writing run keeps the hold (its state row and WARN); one that
    // left groups for later keeps a hold it can't see the end of.
    if (input.write && (held.length || !report.groups.left)) {
      await this.reportHeldGroups(held, now);
    }
    // A rebuild matches every imported group the chain never replaced to
    // 6529.io's row, keeping the match (the rows it can't make are these).
    const imported = (await this.store.chainImportedGroups()).map(chainGroupOf);
    const importedRecords = await this.store.mirroredGroups(
      imported.map((g) => g.groupId)
    );
    for (const group of imported) {
      const record = importedRecords.get(group.groupId);
      if (record?.groupId) {
        report.groups.unchanged++;
        continue;
      }
      if (input.outOfTime()) {
        report.groups.left++;
        continue;
      }
      if (await this.importedGroupId(group, record, input.write, now)) {
        report.groups.mirrored++;
      } else {
        input.counter.wait('imported_group_unmatched');
        report.groups.waiting++;
      }
    }
    const waves = (await this.store.chainWavesToMirror())
      .filter(
        (row) => legacyIds.of('wave', row.wave_id, row.legacy_id) !== undefined
      )
      .map(chainWaveOf)
      // A rebuild takes every imported wave: it writes the rows 6529.io
      // has none of.
      .filter((w) => this.store.mode === 'rebuild' || isChainOwnedWave(w));
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
    await this.importedDecisions(input, legacyIds, report);
    return report;
  }

  /**
   * A rebuild's competitions rows of the imported decisions 6529.io has
   * none of, from their documents (waves-chain-mirror.legacy-rows.ts); the
   * live mirror writes none (the store gives it no decision). Their
   * entries and results are the decisions pass's.
   */
  private async importedDecisions(
    input: {
      readonly write: boolean;
      readonly documents: DocumentSource;
      readonly counter: PlanCounter;
      readonly outOfTime: () => boolean;
    },
    legacyIds: InvalidLegacyIds,
    report: ObjectsReport
  ): Promise<void> {
    for (const row of await this.store.chainImportedDecisions()) {
      const legacyId = legacyIds.of('decision', row.decision_id, row.legacy_id);
      if (!legacyId) continue;
      if (await this.store.competitionExists(legacyId)) {
        report.decisions.unchanged++;
        continue;
      }
      if (input.outOfTime()) {
        report.decisions.left++;
        continue;
      }
      await this.count(
        report.decisions,
        `imported decision ${row.decision_id}`,
        async () => {
          const read = await this.importedDecisionDoc(
            row.data,
            input.documents
          );
          if (!read.ok) {
            input.counter.wait(read.reason);
            return 'waiting';
          }
          if (read.doc.id !== legacyId) {
            input.counter.wait('decision_document_of_another_decision');
            return 'waiting';
          }
          input.counter.change('competitions', 'insert');
          if (!input.write) return 'mirrored';
          const record = importedCompetitionRecord(read.doc);
          await this.store.inTransaction((connection) =>
            this.store.insertImportedCompetition(
              {
                record,
                capabilities: read.doc.capabilities,
                outcomes: read.doc.outcomes
              },
              connection
            )
          );
          return 'mirrored';
        }
      );
    }
  }

  /** An imported decision's document, as its chain data names it. */
  private async importedDecisionDoc(
    data: unknown,
    documents: DocumentSource
  ): Promise<
    { ok: true; doc: ImportedDecisionDoc } | { ok: false; reason: string }
  > {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const cid =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).metadataCid
        : null;
    if (typeof cid !== 'string' || !cid) {
      return { ok: false, reason: 'decision_without_document' };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await documents.get(cid, DOC_CLASS.DECISION);
    } catch (error) {
      logger.warn(`[DECISION DOCUMENT] ${cid} not read: ${error}`);
      bytes = null;
    }
    if (!bytes) return { ok: false, reason: 'decision_document_missing' };
    return parseImportedDecisionDoc(bytes);
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

  /**
   * Keeps when groups began to be held for the identity mirror, and once a
   * hold has lasted GROUPS_HELD_REPORT_MS writes one WARN naming the oldest
   * held height (again only after a hold clears and builds up again). A
   * held group only delays 6529.io's copy of it; a hold that lasts means
   * the identity mirror is behind or stopped.
   */
  private async reportHeldGroups(held: readonly number[], now: number) {
    const oldestHeight = held.length ? Math.min(...held) : null;
    const hold = await this.store.groupsHeld(
      { count: held.length, oldestHeight },
      now
    );
    if (!hold || hold.reported || now - hold.since < GROUPS_HELD_REPORT_MS) {
      return;
    }
    logger.warn(
      `[WAVES CHAIN MIRROR] [GROUPS HELD FOR IDENTITY ROWS] [OLDEST HEIGHT ${oldestHeight}] [HELD SINCE ${new Date(
        hold.since
      ).toISOString()}] [GROUPS ${held.length}]`
    );
    await this.store.groupsHeldReported();
  }

  private async mirrorGroup(
    group: ChainGroup,
    record: MirroredGroup | undefined,
    input: {
      readonly write: boolean;
      readonly counter: PlanCounter;
      /** Heights of the groups held for the identity mirror, as they are. */
      readonly held: number[];
    },
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
    if (addresses.length) {
      // Listed addresses are resolved to identities only once the identity
      // mirror stands at the group's height, live and in a rebuild alike, so
      // both resolve them the same way and no address-only row is made for
      // a wallet an identity already holds there.
      if (group.height === null) return wait('group_without_height');
      if (!(await this.store.identityRowsReached(group.height))) {
        input.held.push(group.height);
        return wait('group_identity_rows_not_reached');
      }
    }
    const known = await this.store.profilesOfAddresses(addresses);
    const unknown = addresses.filter((a) => !known.has(a));
    // From switch-on as of the group's write (its block time), a new
    // address-only row takes the address's derived id.
    const idTime = group.activeFrom;
    if (unknown.length && idTime === null) {
      return wait('group_without_block_time');
    }
    counter.change('community_groups', existing ? 'update' : 'insert');
    counter.change(
      'profile_groups',
      'insert',
      (shape.includes?.length ?? 0) + shape.excludes.length
    );
    // An address's own row without a profile id is given one (an update);
    // an address with no row, a row.
    const withoutProfile = unknown.length
      ? await this.store.ownRowsWithoutProfile(unknown)
      : new Set<string>();
    counter.change('identities', 'update', withoutProfile.size);
    counter.change(
      'identities',
      'insert',
      unknown.length - withoutProfile.size
    );
    if (!input.write) return 'mirrored';
    let touched: string[];
    try {
      touched = await this.writeGroupWithIdentities(
        unknown,
        idTime,
        known,
        async (profilesOfAddresses, connection) => {
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
        }
      );
    } catch (error) {
      if (error instanceof AddressesWithoutProfile) {
        return wait('group_address_without_profile');
      }
      throw error;
    }
    await this.effects.groupsChanged([groupId], touched);
    return 'mirrored';
  }

  /**
   * In one transaction: gives the listed addresses without an identity one
   * (as 6529.io's group create does, from switch-on as of `idTime` with the
   * address's derived id), then writes the group with every address
   * resolved. A row another writer made meanwhile is read back, never
   * written twice. An address still without a profile id (mapped to a row
   * of several wallets that has none) rolls the write back
   * (AddressesWithoutProfile): the group waits rather than leave it out.
   */
  private async writeGroupWithIdentities<T>(
    unknown: readonly string[],
    idTime: number | null,
    known: ReadonlyMap<string, string>,
    write: (
      profilesOfAddresses: ReadonlyMap<string, string>,
      connection: ConnectionWrapper<any>
    ) => Promise<T>
  ): Promise<T> {
    return this.store.inTransaction(async (connection) => {
      if (!unknown.length) return write(known, connection);
      const given = await this.store.addAddressIdentities(
        unknown,
        connection,
        idTime!
      );
      const missing = unknown.filter((a) => !given.has(a));
      if (missing.length) throw new AddressesWithoutProfile(missing);
      return write(
        new Map([...Array.from(known), ...Array.from(given)]),
        connection
      );
    });
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
      readonly height?: number | null;
    },
    now: number,
    parents: ParentWaits
  ): Promise<Outcome> {
    const { counter } = input;
    const waveId = waveIdOf(wave);
    if (!isChainOwnedWave(wave) && (await this.store.waveRow(waveId))) {
      // An imported wave the chain left as imported (a rebuild visits every
      // one): 6529.io's row stays as it is.
      return 'unchanged';
    }
    const groups = await this.waveGroups(wave, input.write, now);
    if (!groups.ok) {
      counter.wait(groups.reason);
      return 'waiting';
    }
    const existing = await this.store.waveRow(waveId);
    // An imported wave only closed keeps 6529.io's fields: no document,
    // unless a rebuild writes its row.
    const document =
      wave.origin === 'native' ||
      wave.policyVersion > 1 ||
      (!existing && this.store.mode === 'rebuild')
        ? await this.document(wave, input.documents)
        : ({ kind: 'none' } as const);
    if (!existing) {
      if (wave.origin !== 'native') {
        if (this.store.mode !== 'rebuild') {
          counter.wait('imported_wave_missing');
          return 'waiting';
        }
        return this.createImportedWave(
          wave,
          waveId,
          record,
          groups.groups,
          groups.chatWait,
          document,
          input,
          now
        );
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

  /**
   * A description's hold after it was judged: a refusal for good (until
   * the description changes), a deferral until its retry, longer each
   * time; null when it went through. A rebuild's verdict is the kept hold
   * it read, so its record's copy is the live mirror's.
   */
  private descriptionVerdict(
    held: string | null,
    kept: EntryHold | null,
    now: number
  ): EntryHold | null {
    if (!held) return null;
    if (this.store.mode === 'rebuild' && kept?.reason === held) return kept;
    const attempts = (kept?.reason === held ? kept.attempts : 0) + 1;
    return {
      reason: held,
      retryAt:
        held === DESCRIPTION_DEFERRED ? now + retryDelayMs(attempts) : null,
      attempts
    };
  }

  /**
   * Keeps a description's verdict in chain_entry_holds, under its drop id:
   * the hold a rebuild's moderation reads.
   */
  private async keepDescriptionVerdict(
    dropId: string,
    verdict: EntryHold | null,
    kept: EntryHold | null,
    now: number,
    connection: Parameters<ObjectsStore['holdDescription']>[3]
  ): Promise<void> {
    if (verdict) {
      await this.store.holdDescription(dropId, verdict, now, connection);
    } else if (kept) {
      await this.store.releaseDescription(dropId, connection);
    }
  }

  private async createWave(
    wave: ChainWave,
    waveId: string,
    record: MirroredWave | undefined,
    groups: WaveGroups,
    chatWait: string | null,
    document: Awaited<ReturnType<WavesChainObjectsMirror['document']>>,
    input: {
      readonly write: boolean;
      readonly counter: PlanCounter;
      readonly height?: number | null;
    },
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
        creator!,
        wave.waveId,
        parents,
        input.height ?? null
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
      if (parent.kind === 'wait') {
        // The chain's answer couldn't be read: asked again next run.
        counter.wait(parent.reason);
        return 'waiting';
      }
      if (parent.kind === 'keep') {
        parentWaveId = parent.id;
      } else {
        counter.wait(parent.reason);
      }
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
    const kept = await this.store.descriptionHold(descriptionDropId);
    const verdict = this.descriptionVerdict(moderated.held, kept, now);
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
      await this.keepDescriptionVerdict(
        descriptionDropId,
        verdict,
        kept,
        now,
        connection
      );
      // The record's copy of the hold only schedules the wave's next look.
      await this.store.saveMirroredWave(
        wave.waveId,
        {
          waveId,
          written: waveWrittenKey(wave),
          metadataCid: wave.metadataCid,
          metadataKeys: Object.keys(metadata ?? {}),
          held: verdict?.reason ?? null,
          retryAt: verdict?.retryAt ?? null,
          attempts: verdict?.attempts ?? 0
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
   * A rebuild's row of an imported wave 6529.io has none of: as 6529.io's
   * create makes a wave from its document and the chain's policy, under
   * its legacy id (waves-chain-mirror.legacy-rows.ts). No description drop
   * (the import-files reader's), no metadata, no follows or activity. A
   * wave the chain owns (a replaced policy, closed) then goes on as the
   * live mirror updates one.
   */
  private async createImportedWave(
    wave: ChainWave,
    waveId: string,
    record: MirroredWave | undefined,
    groups: WaveGroups,
    chatWait: string | null,
    document: Awaited<ReturnType<WavesChainObjectsMirror['document']>>,
    input: {
      readonly write: boolean;
      readonly documents: DocumentSource;
      readonly counter: PlanCounter;
    },
    now: number
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
    const creator = wave.controller
      ? ((await this.principals([wave.controller])).get(wave.controller) ??
        null)
      : null;
    if (!creator) {
      counter.wait('wave_creator_unmapped');
      return 'waiting';
    }
    if (!doc.createdAt) {
      counter.wait('wave_without_time');
      return 'waiting';
    }
    const chatEnabled = doc.chat.enabled && wave.status !== 'closed';
    if (chatEnabled && chatWait) {
      counter.wait(chatWait);
      return 'waiting';
    }
    const checked = checkedWaveRequest({
      doc,
      groups: { ...groups, chat: chatEnabled ? groups.chat : null },
      chatEnabled,
      parentWaveId: doc.parentWave
    });
    if (!checked.ok) {
      counter.wait(checked.reason);
      return 'waiting';
    }
    // The description drop is the drop archives' import's: its id from the
    // wave document when the import carries it (a UUID, of a drop of the
    // wave once that step wrote them), else from that step's mapping; one
    // empty, malformed or naming no drop of the wave is noted and not
    // written. Planned without either: '' leaves 6529.io's wave reads
    // failing for this wave until that step runs.
    let documentDropId = doc.descriptionDropId;
    if (
      documentDropId &&
      (await this.store.descriptionDropInWave(documentDropId, waveId)) === false
    ) {
      documentDropId = null;
    }
    if (
      !documentDropId &&
      (doc.descriptionDropId || doc.descriptionDropIdInvalid)
    ) {
      counter.note('wave_description_drop_id_invalid');
      logger.warn(
        `[WAVE ${wave.waveId}] its document's description_drop_id is no UUID of a drop of the wave; the drop archives' import's mapping is used`
      );
    }
    counter.change('waves', 'insert');
    if (!write) return 'mirrored';
    const entity = await this.effects.newWaveEntity({
      id: waveId,
      createdAt: doc.createdAt,
      request: checked.request,
      createdBy: creator,
      descriptionDropId:
        documentDropId ??
        (await this.store.importedDescriptionDropId(waveId)) ??
        ''
    });
    await this.store.inTransaction((connection) =>
      this.store.insertImportedWave(entity, connection)
    );
    if (!isChainOwnedWave(wave)) return 'mirrored';
    // The chain's own changes of the wave, and its record, as the live
    // mirror keeps them.
    await this.updateWave(
      wave,
      entity as unknown as WaveEntity,
      record,
      groups,
      chatWait,
      document,
      input,
      now
    );
    return 'mirrored';
  }

  /**
   * The parent a wave made on the chain may keep, as 6529.io's create
   * allows it: a top-level wave, not a DM, that its creator manages. Who
   * manages the parent is the chain's answer
   * (/v1/waves/{parent}/rights/{creator}, isManager), read at the chain
   * index's read height: the highest height an index run read at, so at or
   * above every row it holds (a full read can hold rows read above the
   * feed's height); live, a minute or so behind the head; in a rebuild, the
   * recording's mark. The answer then sees the parent and the creator the
   * index saw. 6529.io's
   * own eligibility, computed from its identities' TDH and level, isn't
   * asked, so the answer doesn't depend on 6529.io's current TDH or on
   * when a rebuild writes it.
   *
   * - A parent with no row that a wave made on the chain may still give:
   *   the child waits for it (WAIT_FOR_PARENT).
   * - A parent that isn't top-level, is a DM, or has no row and won't get
   *   one: left out.
   * - A parent the chain doesn't hold (a wave that stays on 6529.io): left
   *   out, as the chain can't say who manages it.
   * - The creator not a manager: left out.
   * - No answer, the node's not_found included: the child waits and the
   *   run asks again. A parent is set only when the wave is created, so a
   *   wrong "no" would be for good; the index has seen the parent and the
   *   creator, so a not_found is a read behind them, not an answer.
   *
   * Known limits: the answer is the chain's at the run that writes the
   * wave, live minutes after it was made. A node keeps its last 64 views
   * only, so the rights at the creation height can't be read or recorded.
   * A later rebuild reads them at its own mark, so a live row and a later
   * rebuild differ when the creator's rights on the parent changed in
   * between. A subwave of a wave that stays on 6529.io never keeps it.
   */
  private async allowedParent(
    parentId: string,
    creator: string,
    childId: string,
    parents: ParentWaits,
    height: number | null
  ): Promise<ParentChoice> {
    const leave = (reason: string): ParentChoice => ({ kind: 'leave', reason });
    const parent = await this.store.waveRow(parentId);
    if (!parent) {
      // A wave made on the chain that may still get its row: wait for it.
      const id = parentId.toLowerCase();
      return id !== childId && parents.pending.has(id)
        ? WAIT_FOR_PARENT
        : leave('wave_parent_left_out');
    }
    if (parent.parent_wave_id !== null || parent.is_direct_message) {
      return leave('wave_parent_left_out');
    }
    const chainParent = await this.store.chainWaveIdOf(parent.id);
    if (!chainParent) return leave('wave_parent_not_on_chain');
    const manages = await this.effects.waveManager({
      waveId: chainParent,
      principal: creator,
      height
    });
    if (manages === null) {
      return { kind: 'wait', reason: 'wave_parent_rights_unavailable' };
    }
    return manages
      ? { kind: 'keep', id: parent.id }
      : leave('wave_parent_not_managed');
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
    // The description's hold, as chain_entry_holds keeps it: judged again
    // when the document changes the description, or a deferral is due.
    const kept = await this.store.descriptionHold(existing.description_drop_id);
    const descriptionRetry =
      kept?.reason === DESCRIPTION_DEFERRED &&
      kept.retryAt !== null &&
      kept.retryAt <= now;
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
    // The description's verdict, when it is judged again; a hold not
    // judged again stays as it is kept.
    let held: string | null = null;
    let judged = false;
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
        judged = true;
        if (moderated.parts) {
          description = { parts: moderated.parts, authorId: current.authorId };
        } else {
          counter.wait(moderated.held!);
        }
      } else if (current) {
        held = null;
        judged = true;
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
    const verdict = judged ? this.descriptionVerdict(held, kept, now) : kept;
    // A deferral due that wasn't judged (no document to judge it by) is
    // looked at again later, not every run.
    const copy =
      verdict && verdict.retryAt !== null && verdict.retryAt <= now
        ? {
            ...verdict,
            retryAt: now + retryDelayMs(verdict.attempts + 1)
          }
        : verdict;
    const missingAttempts =
      record?.held === WAVE_DOCUMENT_MISSING ? record.attempts + 1 : 1;
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
      if (judged) {
        await this.keepDescriptionVerdict(
          existing.description_drop_id,
          verdict,
          kept,
          now,
          connection
        );
      }
      // The record's copy of the hold only schedules the wave's next look.
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
          ...(docDone
            ? {
                held: copy?.reason ?? null,
                retryAt: copy?.retryAt ?? null,
                attempts: copy?.attempts ?? 0
              }
            : {
                held: WAVE_DOCUMENT_MISSING,
                retryAt: now + retryDelayMs(missingAttempts),
                attempts: missingAttempts
              })
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

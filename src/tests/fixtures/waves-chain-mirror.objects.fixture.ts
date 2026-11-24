import { CLOUDFRONT_LINK } from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveEntity } from '@/entities/IWave';
import { ApiUpdateWaveHubRequest } from '@/api/generated/models/ApiUpdateWaveHubRequest';
import { applyWaveHubPatch } from '@/api/waves/wave-hub-update';
import { ChainGroupRow } from '@/waves-chain-mirror/waves-chain-mirror.groups';
import {
  GroupWrite,
  MirroredDecision,
  MirroredGroup,
  MirroredWave,
  NativeCompetitionRow,
  NativeCompetitionWrite,
  WaveCreate
} from '@/waves-chain-mirror/waves-chain-mirror.objects.db';
import { ChainDecisionRowRead } from '@/waves-chain-mirror/waves-chain-mirror.decisions';
import {
  ObjectEffects,
  ObjectsStore
} from '@/waves-chain-mirror/waves-chain-mirror.objects';
import {
  ChainWaveRow,
  WaveDocumentPart
} from '@/waves-chain-mirror/waves-chain-mirror.waves';
import { DocumentSource } from '@/waves-chain-mirror/waves-chain-mirror.docs';
import { EntryHold } from '@/waves-chain-mirror/waves-chain-mirror.db';
import { InsertWaveEntity } from '@/api/waves/waves.api.db';
import { CompetitionEntity } from '@/entities/ICompetition';
import { aWave } from './wave.fixture';

export const chainWord = (byte: string) => `0x${byte.repeat(32)}`;

/** A chain_groups row: a group made on the chain unless said otherwise. */
export function aChainGroupRow(
  groupId: string,
  definition: Record<string, unknown>,
  fields: {
    version?: number;
    origin?: string;
    legacyId?: string | null;
    controller?: string;
    activeFrom?: number;
  } = {}
): ChainGroupRow {
  const version = fields.version ?? 1;
  return {
    group_id: groupId,
    legacy_id: fields.legacyId ?? null,
    version,
    origin: fields.origin ?? 'native',
    data: {
      groupId,
      version,
      controller: fields.controller ?? chainWord('11'),
      visibility: 'public',
      activeFrom: fields.activeFrom ?? 1_764_000_000_000,
      origin: fields.origin ?? 'native',
      definition: {
        version,
        defHash: null,
        predicateMode: 'list_only',
        clauses: [],
        includes: [],
        excludes: [],
        storedIncludes: 0,
        storedExcludes: 0,
        activationHeight: 10,
        ...definition
      }
    }
  };
}

/** A chain_waves row. */
export function aChainWaveRow(
  waveId: string,
  fields: {
    legacyId?: string | null;
    origin?: string;
    status?: string;
    read?: string | null;
    post?: string | null;
    admin?: string | null;
    controller?: string;
    policyVersion?: number;
    metadataCid?: string | null;
  } = {}
): ChainWaveRow {
  return {
    wave_id: waveId,
    legacy_id: fields.legacyId ?? null,
    status: fields.status ?? 'open',
    read_group_id: fields.read ?? null,
    post_group_id: fields.post ?? null,
    admin_group_id: fields.admin ?? null,
    origin: fields.origin ?? 'native',
    data: {
      waveId,
      controller: fields.controller ?? chainWord('11'),
      policyVersion: fields.policyVersion ?? 1,
      metadataCid: fields.metadataCid ?? null
    }
  };
}

/** The pass's store, in memory. */
export class FakeObjectsStore implements ObjectsStore {
  mode: 'live' | 'rebuild' = 'live';
  chainGroups: ChainGroupRow[] = [];
  chainWaves: ChainWaveRow[] = [];
  events: { kind: string; id: string; time: number; actor: string }[] = [];
  groupRecords = new Map<string, MirroredGroup>();
  waveRecords = new Map<string, MirroredWave>();
  /** 6529.io's groups by the legacy UUID the import gave them. */
  importedGroups = new Map<string, string>();
  addressProfiles = new Map<string, string>();
  groups = new Map<string, UserGroupEntity>();
  waves = new Map<string, WaveEntity>();
  drops = new Map<string, { authorId: string; parts: WaveDocumentPart[] }>();
  metadata = new Map<string, Map<string, string>>();
  groupWrites: GroupWrite[] = [];
  waveCreates: WaveCreate[] = [];
  waveEdits: {
    waveId: string;
    patch: ApiUpdateWaveHubRequest;
    createdBy: string | null;
  }[] = [];
  descriptions: { dropId: string; parts: readonly WaveDocumentPart[] }[] = [];
  addedIdentities: string[] = [];
  transactions = 0;

  async chainGroupsToMirror() {
    return this.chainGroups.filter(
      (g) => g.origin === 'native' || Number(g.version) > 1
    );
  }
  async chainGroupsByIds(ids: readonly string[]) {
    return this.chainGroups.filter((g) => ids.includes(g.group_id));
  }
  async chainWavesToMirror() {
    return this.chainWaves;
  }
  async creationEvent(kind: string, id: string) {
    const event = this.events.find((e) => e.kind === kind && e.id === id);
    return event ? { time: event.time, actor: event.actor } : null;
  }
  async mirroredGroups(ids: readonly string[]) {
    return new Map(
      Array.from(this.groupRecords).filter(([id]) => ids.includes(id))
    );
  }
  async saveMirroredGroup(
    chainGroupId: string,
    record: Omit<MirroredGroup, 'updatedAt'>,
    now: number
  ) {
    this.groupRecords.set(chainGroupId, { ...record, updatedAt: now });
  }
  async mirroredWaves(ids: readonly string[]) {
    return new Map(
      Array.from(this.waveRecords).filter(([id]) => ids.includes(id))
    );
  }
  async saveMirroredWave(chainWaveId: string, record: MirroredWave) {
    this.waveRecords.set(chainWaveId, record);
  }
  /** chain_decisions' imported decisions (a rebuild's). */
  importedDecisions: {
    decision_id: string;
    legacy_id: string | null;
    data: unknown;
  }[] = [];
  competitionIds = new Set<string>();
  importedWaves: InsertWaveEntity[] = [];
  importedCompetitions: {
    record: CompetitionEntity;
    capabilities: readonly string[];
    outcomes: readonly Record<string, unknown>[];
  }[] = [];
  async chainImportedDecisions() {
    return this.mode === 'rebuild' ? this.importedDecisions : [];
  }
  async competitionExists(id: string) {
    return this.competitionIds.has(id);
  }
  /** The drop archives' import's description drop ids, by wave id. */
  descriptionDropIds = new Map<string, string>();
  async importedDescriptionDropId(waveId: string) {
    return this.descriptionDropIds.get(waveId) ?? null;
  }
  /** The drops the drop archives' import wrote, by id: their wave; null when none ran. */
  archivedDrops: Map<string, string> | null = null;
  async descriptionDropInWave(dropId: string, waveId: string) {
    if (!this.archivedDrops) return null;
    return this.archivedDrops.get(dropId) === waveId;
  }
  /** chain_groups' imported groups the chain never replaced (a rebuild's). */
  importedChainGroups: ChainGroupRow[] = [];
  async chainImportedGroups() {
    return this.mode === 'rebuild' ? this.importedChainGroups : [];
  }
  async insertImportedWave(entity: InsertWaveEntity) {
    if (this.mode !== 'rebuild') return;
    this.importedWaves.push(entity);
    this.waves.set(entity.id, entity as unknown as WaveEntity);
  }
  async insertImportedCompetition(input: {
    record: CompetitionEntity;
    capabilities: readonly string[];
    outcomes: readonly Record<string, unknown>[];
  }) {
    if (this.mode !== 'rebuild') return;
    this.importedCompetitions.push(input);
    this.competitionIds.add(input.record.id);
  }
  /** chain_entry_holds' description rows, by description drop id. */
  descriptionHolds = new Map<string, EntryHold>();
  /** Whether the records' description holds were carried over. */
  descriptionHoldsCarried = false;
  async descriptionHold(dropId: string) {
    return this.descriptionHolds.get(dropId) ?? null;
  }
  async holdDescription(dropId: string, hold: EntryHold) {
    if (this.mode === 'rebuild') return;
    this.descriptionHolds.set(dropId, hold);
  }
  async releaseDescription(dropId: string) {
    if (this.mode === 'rebuild') return;
    this.descriptionHolds.delete(dropId);
  }
  async carryDescriptionHolds() {
    if (this.mode === 'rebuild' || this.descriptionHoldsCarried) return 0;
    this.descriptionHoldsCarried = true;
    let n = 0;
    for (const record of Array.from(this.waveRecords.values())) {
      if (!record.held?.startsWith('description')) continue;
      n++;
      const dropId = this.waves.get(record.waveId)?.description_drop_id;
      if (!dropId || this.descriptionHolds.has(dropId)) continue;
      this.descriptionHolds.set(dropId, {
        reason: record.held,
        retryAt: record.retryAt,
        attempts: record.attempts
      });
    }
    return n;
  }
  async importedGroupId(legacyUuid: string) {
    return this.importedGroups.get(legacyUuid) ?? null;
  }
  async profilesOfAddresses(addresses: readonly string[]) {
    return new Map(
      addresses
        .filter((a) => this.addressProfiles.has(a))
        .map((a) => [a, this.addressProfiles.get(a)!])
    );
  }
  async addAddressIdentities(addresses: readonly string[]) {
    for (const address of addresses) {
      this.addedIdentities.push(address);
      this.addressProfiles.set(address, `profile-of-${address.slice(2, 8)}`);
    }
  }
  async groupRow(id: string) {
    return this.groups.get(id) ?? null;
  }
  async waveRow(id: string) {
    return this.waves.get(id) ?? null;
  }
  async dropParts(dropId: string) {
    return this.drops.get(dropId) ?? null;
  }
  async waveMetadata(waveId: string) {
    return new Map(this.metadata.get(waveId) ?? []);
  }
  async writeGroup(write: GroupWrite) {
    this.groupWrites.push(write);
    this.groups.set(write.row.id, {
      ...write.row,
      is_pure_profile_group: false
    });
    return [...write.includes, ...write.excludes];
  }
  async createWave(write: WaveCreate) {
    this.waveCreates.push(write);
    this.waves.set(write.entity.id, {
      ...write.entity,
      serial_no: 1
    } as unknown as WaveEntity);
    this.drops.set(write.description.dropId, {
      authorId: write.description.authorId,
      parts: [...write.description.parts]
    });
    this.metadata.set(write.entity.id, new Map(Object.entries(write.metadata)));
  }
  async replaceDescription(input: {
    dropId: string;
    parts: readonly WaveDocumentPart[];
  }) {
    this.descriptions.push(input);
    const drop = this.drops.get(input.dropId)!;
    this.drops.set(input.dropId, { ...drop, parts: [...input.parts] });
  }
  async editWave(input: {
    waveId: string;
    patch: ApiUpdateWaveHubRequest;
    createdBy: string | null;
  }) {
    this.waveEdits.push(input);
    const before = this.waves.get(input.waveId)!;
    const after = {
      ...applyWaveHubPatch(before, input.patch),
      created_by: input.createdBy ?? before.created_by
    };
    this.waves.set(input.waveId, after);
    return { before, after };
  }
  async writeMetadata(
    waveId: string,
    changes: {
      upsert: readonly { key: string; value: string }[];
      remove: readonly string[];
    }
  ) {
    const current = this.metadata.get(waveId) ?? new Map<string, string>();
    for (const key of changes.remove) current.delete(key);
    for (const { key, value } of changes.upsert) current.set(key, value);
    this.metadata.set(waveId, current);
  }
  async inTransaction<T>(fn: (connection: any) => Promise<T>): Promise<T> {
    this.transactions++;
    return fn({ connection: 'fake' });
  }

  chainDecisions: ChainDecisionRowRead[] = [];
  /** chain_waves' legacy ids: an imported wave's 6529.io id. */
  chainWaveLegacyIds = new Map<string, string>();
  blockTimes = new Map<number, number>();
  decisionRecords = new Map<string, MirroredDecision>();
  competitions = new Map<string, NativeCompetitionRow>();
  competitionWrites: NativeCompetitionWrite[] = [];

  async chainDecisionsToMirror() {
    return this.chainDecisions;
  }
  async waveIdOfChainWave(chainWaveId: string) {
    return this.chainWaveLegacyIds.get(chainWaveId) ?? chainWaveId;
  }
  async blockTimeAt(height: number) {
    return this.blockTimes.get(height) ?? null;
  }
  async mirroredDecisions(ids: readonly string[]) {
    return new Map(
      Array.from(this.decisionRecords).filter(([id]) => ids.includes(id))
    );
  }
  async saveMirroredDecision(id: string, record: MirroredDecision) {
    this.decisionRecords.set(id, record);
  }
  async nativeCompetition(id: string) {
    return this.competitions.get(id) ?? null;
  }
  async writeNativeCompetition(write: NativeCompetitionWrite) {
    this.competitionWrites.push(write);
    this.competitions.set(write.record.id, {
      id: write.record.id,
      configVersion: write.record.config_version,
      createdAt: write.record.created_at
    });
  }

  writes(): number {
    return (
      this.groupWrites.length +
      this.waveCreates.length +
      this.waveEdits.length +
      this.descriptions.length +
      this.competitionWrites.length
    );
  }
}

/** A 6529.io wave row, as the fake keeps it. */
export function aWaveRow(
  id: string,
  fields: Partial<WaveEntity> = {}
): WaveEntity {
  return {
    ...aWave(
      {
        description_drop_id: `description-of-${id}`,
        created_by: 'creator',
        chat_group_id: null,
        visibility_group_id: null,
        admin_group_id: null,
        chat_links_disabled: false,
        chat_replies_open: false,
        chat_replies_collapsed: false,
        chat_slow_mode_cooldown_ms: null,
        admin_drop_deletion_enabled: false,
        ...(fields as Record<string, unknown>)
      },
      { id, serial_no: 1, name: fields.name ?? 'A wave' }
    ),
    ...fields
  } as WaveEntity;
}

export function fakeObjectEffects(): jest.Mocked<ObjectEffects> & {
  eligible: string[];
} {
  const state = { eligible: [] as string[] };
  const effects = {
    get eligible() {
      return state.eligible;
    },
    set eligible(value: string[]) {
      state.eligible = value;
    },
    groupsChanged: jest.fn().mockResolvedValue(undefined),
    waveChanged: jest.fn().mockResolvedValue(undefined),
    eligibleGroups: jest.fn(async (): Promise<string[]> => state.eligible),
    newWaveEntity: jest.fn(
      async (input: Parameters<ObjectEffects['newWaveEntity']>[0]) => ({
        ...aWave(
          {
            created_at: input.createdAt,
            updated_at: null,
            created_by: input.createdBy,
            description_drop_id: input.descriptionDropId,
            parent_wave_id: input.request.parent_wave_id ?? null,
            picture: input.request.picture,
            visibility_group_id: input.request.visibility.scope.group_id,
            admin_group_id: input.request.wave.admin_group?.group_id ?? null,
            chat_group_id: input.request.chat.scope.group_id,
            chat_enabled: input.request.chat.enabled,
            admin_drop_deletion_enabled:
              input.request.wave.admin_drop_deletion_enabled
          },
          { id: input.id, serial_no: 0, name: input.request.name }
        ),
        serial_no: null,
        is_direct_message: false,
        voting_credit_nfts: []
      })
    ),
    checkCompetition: jest.fn().mockResolvedValue(undefined),
    decisionCreatedAt: jest.fn().mockResolvedValue(null)
  };
  return effects as unknown as jest.Mocked<ObjectEffects> & {
    eligible: string[];
  };
}

/** Documents by CID, as the store would hand them. */
export class FakeDocuments implements DocumentSource {
  docs = new Map<string, Uint8Array>();
  asked: string[] = [];
  put(cid: string, doc: unknown) {
    this.docs.set(cid, Buffer.from(`${JSON.stringify(doc)}\n`));
  }
  async get(cid: string) {
    this.asked.push(cid);
    return this.docs.get(cid) ?? null;
  }
}

/** A wave document as the frontend's newWaveDoc writes one. */
export const aWaveDoc = (fields: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'wave',
  name: 'Made on the chain',
  picture: `${CLOUDFRONT_LINK}/waves/picture.png`,
  description: [{ content: 'What this wave is about', media: [] }],
  parent_wave: null,
  chat: {
    enabled: true,
    links_disabled: false,
    replies: { open: true, collapsed: false },
    slow_mode_cooldown_ms: null
  },
  admin_drop_deletion_enabled: true,
  created_at: 1_764_000_000_000,
  metadata: { 'wave_display.rules.custom': 'Be kind' },
  ...fields
});

/** A decision's result time in the fixtures' future. */
export const FIRST_RESULT = 1_766_000_000_000;

/** A decision document as the frontend's decisionDoc writes one. */
export const aDecisionDoc = (
  fields: Record<string, unknown> = {},
  rules: Record<string, unknown> = {}
) => {
  const strategy = {
    first_decision_time: FIRST_RESULT,
    subsequent_decisions: [86_400_000],
    is_rolling: false
  };
  return {
    v: 1,
    kind: 'decision',
    type: 'RANK',
    title: 'Made on the chain',
    description: 'Pick the best',
    participation: {
      scope: { group_id: null },
      no_of_applications_allowed_per_participant: null,
      required_metadata: [],
      required_media: ['IMAGE'],
      signature_required: false,
      period: { min: null, max: null },
      terms: null,
      submission_strategy: null
    },
    voting: {
      scope: { group_id: null },
      credit_type: 'TDH',
      credit_scope: 'WAVE',
      credit_category: null,
      creditor_id: null,
      signature_required: false,
      period: { min: null, max: null },
      forbid_negative_votes: false
    },
    decisions: strategy,
    rules: {
      type: 'RANK',
      winning_threshold: null,
      winning_threshold_min_duration_ms: null,
      max_winners: null,
      max_votes_per_identity_to_drop: null,
      time_lock_ms: 3_600_000,
      decisions_strategy: strategy,
      ...rules
    },
    outcome_config: [{ type: 'MANUAL', description: 'A prize' }],
    presentation: [],
    ...fields
  };
};

/** A DecisionConfig as the gateway gives it, for the decision document's rules. */
export const aDecisionConfig = (fields: Record<string, unknown> = {}) => ({
  kind: 1,
  creditSource: 1,
  creditParam: `0x${'00'.repeat(32)}`,
  creditor: null,
  creditScope: 1,
  creditMode: 1,
  minVote: '-9007199254740991',
  maxVote: '9007199254740991',
  perEntryCap: '0',
  participationStart: '0',
  participationEnd: '0',
  votingStart: '0',
  votingEnd: '0',
  firstResult: String(FIRST_RESULT),
  gaps: ['86400000'],
  rolling: false,
  scheduleEnd: '0',
  timeLock: '3600000',
  winnersPerResult: 1,
  maxEntriesPerAuthor: 64,
  outcomeTemplateHash: `0x${'00'.repeat(32)}`,
  ballots: 1,
  threshold: '0',
  holdMs: '0',
  maxWinners: 0,
  ...fields
});

/** A chain_decisions row of a decision made on the chain. */
export function aChainDecisionRow(
  decisionId: string,
  waveId: string,
  fields: {
    configVersion?: number;
    metadataCid?: string | null;
    submitGroup?: string | null;
    voteGroup?: string | null;
    status?: string;
    height?: number;
    config?: Record<string, unknown>;
  } = {}
) {
  const zero = `0x${'00'.repeat(32)}`;
  return {
    decision_id: decisionId,
    wave_id: waveId,
    status: fields.status ?? 'published',
    height: fields.height ?? 30,
    data: {
      decisionId,
      waveId,
      legacyId: null,
      origin: 'native',
      status: fields.status ?? 'published',
      kind: 'rank',
      configVersion: fields.configVersion ?? 1,
      metadataCid: fields.metadataCid === undefined ? null : fields.metadataCid,
      submitGroup: { groupId: fields.submitGroup ?? zero, version: 1 },
      voteGroup: { groupId: fields.voteGroup ?? zero, version: 1 },
      config: aDecisionConfig(fields.config)
    }
  };
}

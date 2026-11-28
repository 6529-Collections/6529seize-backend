import {
  ADDRESS_CONSOLIDATION_KEY,
  CHAIN_DECISIONS_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
  CHAIN_EVENTS_TABLE,
  CHAIN_GROUPS_TABLE,
  CHAIN_WAVES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE
} from '@/constants';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { stableUuid } from '@/competitions/competition-id';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { CompetitionEntity } from '@/entities/ICompetition';
import { ActivityRecorder } from '@/activity/activity.recorder';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveEntity } from '@/entities/IWave';
import { DropsDb } from '@/drops/drops.db';
import { IdentitiesDb } from '@/identities/identities.db';
import { IdentityChainMirrorDb } from '@/identity-chain-mirror/identity-chain-mirror.db';
import { identityRowsReached } from '@/identity-chain-mirror/mirror-reached';
import { WaveGroupNotificationSubscriptionsDb } from '@/notifications/wave-group-notification-subscriptions.db';
import { IdentitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { InsertWaveEntity, WavesApiDb } from '@/api/waves/waves.api.db';
import { applyWaveHubPatch } from '@/api/waves/wave-hub-update';
import { ApiUpdateWaveHubRequest } from '@/api/generated/models/ApiUpdateWaveHubRequest';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  ConnectionWrapper,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { statementChunks } from '@/waves-chain-index/waves-chain-index.db';
import type { EntryHold, MirrorMode } from './waves-chain-mirror.db';
import { ChainDecisionRowRead } from './waves-chain-mirror.decisions';
import { ChainGroupRow } from './waves-chain-mirror.groups';
import { groupShortIdOf, legacyUuidOfGroupId } from './waves-chain-mirror.ids';
import {
  ChainWaveRow,
  DESCRIPTION_DEFERRED,
  DESCRIPTION_REFUSED,
  WaveDocumentPart
} from './waves-chain-mirror.waves';
import { writerPoolExecutor } from './waves-chain-mirror.writer';

type Conn = ConnectionWrapper<any>;

function opts(connection?: Conn) {
  return connection ? { wrappedConnection: connection } : undefined;
}

const ID_BYTES = 72;
/** The mirror's state row that marks the description holds carried over. */
const DESCRIPTION_HOLDS_STATE_NAME = 'description_holds';
/** The mirror's state row of groups held for the identity mirror. */
const GROUPS_HELD_STATE_NAME = 'groups_held';
const SCAN_PAGE = 5_000;

/** What the mirror last wrote of a decision made on the chain. */
export interface MirroredDecision {
  readonly competitionId: string;
  /** The policy version written; null before the first. */
  readonly written: number | null;
  readonly held: string | null;
  /** The policy version the hold is for. */
  readonly heldVersion: number | null;
  readonly retryAt: number | null;
  readonly attempts: number;
}

/** A competitions row of a decision made on the chain, as the mirror reads it. */
export interface NativeCompetitionRow {
  readonly id: string;
  readonly configVersion: number;
  readonly createdAt: number;
}

/** A competitions row to create, or a new policy version of one. */
export interface NativeCompetitionWrite {
  readonly record: CompetitionEntity;
  readonly draft: ApiCompetitionDraftInput;
  readonly create: boolean;
  readonly now: number;
}

const COMPETITION_JSON_COLUMNS = new Set([
  'participation_config',
  'voting_config',
  'decision_config',
  'winner_config',
  'outcome_config',
  'presentation_config'
]);

/** The config columns a new policy version rewrites. */
const COMPETITION_CONFIG_COLUMNS = [
  'title',
  'description',
  'type',
  'presentation_config',
  'participation_config',
  'voting_config',
  'winner_config',
  'outcome_config',
  'config_version',
  'participation_starts_at',
  'participation_ends_at',
  'voting_starts_at',
  'voting_ends_at',
  'updated_at'
];

/** What the mirror last wrote of a chain group. */
export interface MirroredGroup {
  /** community_groups.id; '' when an imported group matched no row. */
  readonly groupId: string;
  readonly version: number | null;
  readonly includeListId: string | null;
  readonly excludeListId: string | null;
  readonly updatedAt: number;
}

/** What the mirror last wrote of a chain wave, and what it holds back. */
export interface MirroredWave {
  readonly waveId: string;
  readonly written: string | null;
  readonly metadataCid: string | null;
  readonly metadataKeys: readonly string[];
  readonly held: string | null;
  readonly retryAt: number | null;
  readonly attempts: number;
}

/** A wave's group rows the mirror writes in one transaction. */
export interface GroupWrite {
  readonly row: Omit<UserGroupEntity, 'is_pure_profile_group'>;
  /** The row before, when there is one (it is replaced in place). */
  readonly replaces: boolean;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  /** List ids the row named before: deleted once no group names them. */
  readonly oldListIds: readonly string[];
}

/** A wave made on the chain, as 6529.io's create writes one. */
export interface WaveCreate {
  readonly entity: InsertWaveEntity;
  readonly description: {
    readonly dropId: string;
    readonly authorId: string;
    readonly createdAt: number;
    readonly parts: readonly WaveDocumentPart[];
  };
  readonly metadata: Readonly<Record<string, string>>;
  /** Whether the creator's follow (identity_subscriptions) is written. */
  readonly follow: boolean;
}

/**
 * The waves chain mirror's reads and writes for waves and groups: the
 * chain index's chain_waves and chain_groups, 6529.io's waves and groups
 * through their own DB classes (the create and edit paths' inserts), and
 * the mirror's records of what it wrote.
 */
export class WavesChainObjectsDb extends LazyDbAccessCompatibleService {
  private readonly waves: WavesApiDb;
  private readonly groups: UserGroupsDb;
  private readonly drops: DropsDb;
  private readonly identities: IdentitiesDb;
  private readonly identityState: IdentityChainMirrorDb;
  private readonly subscriptions: IdentitySubscriptionsDb;
  private readonly groupSubscriptions: WaveGroupNotificationSubscriptionsDb;
  private readonly activity: ActivityRecorder;

  constructor(
    supplier: () => SqlExecutor,
    /** A rebuild writes no follows, activity or outbox events. */
    readonly mode: MirrorMode = 'live',
    /**
     * A rebuild's drop archives' import, run before it: its imported
     * waves' description drop ids (lowercase legacy wave id to drop id).
     * Null when none ran.
     */
    private readonly dropArchives: {
      readonly descriptionDropIds: ReadonlyMap<string, string>;
    } | null = null
  ) {
    super(supplier);
    this.waves = new WavesApiDb(supplier);
    this.groups = new UserGroupsDb(supplier);
    this.drops = new DropsDb(supplier);
    this.identities = new IdentitiesDb(supplier);
    this.identityState = new IdentityChainMirrorDb(supplier);
    this.subscriptions = new IdentitySubscriptionsDb(supplier);
    this.groupSubscriptions = new WaveGroupNotificationSubscriptionsDb(
      supplier
    );
    this.activity = new ActivityRecorder(supplier);
  }

  // ------------------------------------------------------------ chain

  /** Groups made on the chain, and imported ones it replaced. */
  async chainGroupsToMirror(): Promise<ChainGroupRow[]> {
    return this.db.execute<ChainGroupRow>(
      `select group_id, legacy_id, version, origin, height, data
         from ${CHAIN_GROUPS_TABLE}
        where origin = 'native' or version > 1
        order by group_id`
    );
  }

  async chainGroupsByIds(ids: readonly string[]): Promise<ChainGroupRow[]> {
    const out: ChainGroupRow[] = [];
    for (const chunk of statementChunks(
      Array.from(new Set(ids)),
      () => ID_BYTES
    )) {
      out.push(
        ...(await this.db.execute<ChainGroupRow>(
          `select group_id, legacy_id, version, origin, height, data
             from ${CHAIN_GROUPS_TABLE} where group_id in (:ids)`,
          { ids: chunk }
        ))
      );
    }
    return out;
  }

  /**
   * Waves made on the chain, and imported ones whose policy it replaced or
   * that it closed; in a rebuild, every imported wave too.
   */
  async chainWavesToMirror(): Promise<ChainWaveRow[]> {
    return this.db.execute<ChainWaveRow>(
      `select wave_id, legacy_id, status, read_group_id, post_group_id,
              admin_group_id, origin, data
         from ${CHAIN_WAVES_TABLE}
        where origin = 'native' or status = 'closed'
           or cast(json_unquote(json_extract(data, '$.policyVersion'))
                   as unsigned) > 1
           or :rebuild
        order by wave_id`,
      { rebuild: this.mode === 'rebuild' }
    );
  }

  /** Decisions made on the chain. */
  async chainDecisionsToMirror(): Promise<ChainDecisionRowRead[]> {
    return this.db.execute<ChainDecisionRowRead>(
      `select decision_id, wave_id, status, height, data
         from ${CHAIN_DECISIONS_TABLE}
        where origin = 'native'
        order by decision_id`
    );
  }

  /**
   * The chain's id of a wave 6529.io holds (its own id: the legacy id of an
   * imported wave, the chain id of one made on the chain), or null when the
   * chain doesn't hold it.
   */
  async chainWaveIdOf(waveId: string): Promise<string | null> {
    const id = waveId.toLowerCase();
    const row = await this.db.oneOrNull<{ wave_id: string }>(
      `select wave_id from ${CHAIN_WAVES_TABLE}
        where wave_id = :id or legacy_id = :id
        order by wave_id
        limit 1`,
      { id }
    );
    return row?.wave_id ?? null;
  }

  /** 6529.io's id of a chain wave: an imported wave's own, else the chain's. */
  async waveIdOfChainWave(chainWaveId: string): Promise<string> {
    const row = await this.db.oneOrNull<{ legacy_id: string | null }>(
      `select legacy_id from ${CHAIN_WAVES_TABLE} where wave_id = :chainWaveId`,
      { chainWaveId }
    );
    return row?.legacy_id ?? chainWaveId;
  }

  /**
   * The chain's time at a height: the newest block time the event log holds
   * at or below it (the same for every run over one index); null when none.
   */
  async blockTimeAt(height: number): Promise<number | null> {
    const row = await this.db.oneOrNull<{ t: number | string | null }>(
      `select block_time as t from ${CHAIN_EVENTS_TABLE}
        where height <= :height
        order by height desc, seq desc
        limit 1`,
      { height }
    );
    return row?.t === null || row?.t === undefined ? null : Number(row.t);
  }

  /** The first event of `kind` of a wave or group: its block time and actor. */
  async creationEvent(
    kind: 'WAVE_CREATED' | 'GROUP_CREATED',
    id: string
  ): Promise<{ time: number; actor: string | null } | null> {
    const column = kind === 'WAVE_CREATED' ? 'wave_id' : 'group_id';
    const row = await this.db.oneOrNull<{
      block_time: number | string;
      actor: string | null;
    }>(
      `select block_time, actor from ${CHAIN_EVENTS_TABLE}
        where kind = :kind and ${column} = :id
        order by height, seq limit 1`,
      { kind, id }
    );
    return row ? { time: Number(row.block_time), actor: row.actor } : null;
  }

  // ------------------------------------------------------------ records

  async mirroredGroups(
    chainIds: readonly string[]
  ): Promise<Map<string, MirroredGroup>> {
    const out = new Map<string, MirroredGroup>();
    for (const chunk of statementChunks(
      Array.from(new Set(chainIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<Record<string, unknown>>(
        `select * from ${WAVES_CHAIN_MIRROR_GROUPS_TABLE}
          where chain_group_id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        out.set(String(row.chain_group_id), {
          groupId: String(row.group_id),
          version: row.version === null ? null : Number(row.version),
          includeListId: (row.include_list_id as string | null) ?? null,
          excludeListId: (row.exclude_list_id as string | null) ?? null,
          updatedAt: Number(row.updated_at)
        });
      }
    }
    return out;
  }

  async saveMirroredGroup(
    chainGroupId: string,
    record: Omit<MirroredGroup, 'updatedAt'>,
    now: number,
    connection?: Conn
  ): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_GROUPS_TABLE}
         (chain_group_id, group_id, version, include_list_id,
          exclude_list_id, updated_at)
       values (:chainGroupId, :groupId, :version, :includeListId,
          :excludeListId, :now)
       on duplicate key update group_id = :groupId, version = :version,
          include_list_id = :includeListId, exclude_list_id = :excludeListId,
          updated_at = :now`,
      { chainGroupId, ...record, now },
      opts(connection)
    );
  }

  async mirroredDecisions(
    chainIds: readonly string[]
  ): Promise<Map<string, MirroredDecision>> {
    const out = new Map<string, MirroredDecision>();
    for (const chunk of statementChunks(
      Array.from(new Set(chainIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<Record<string, unknown>>(
        `select * from ${WAVES_CHAIN_MIRROR_DECISIONS_TABLE}
          where chain_decision_id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        const num = (value: unknown) =>
          value === null || value === undefined ? null : Number(value);
        out.set(String(row.chain_decision_id), {
          competitionId: String(row.competition_id),
          written: num(row.written),
          held: (row.held as string | null) ?? null,
          heldVersion: num(row.held_version),
          retryAt: num(row.retry_at),
          attempts: Number(row.attempts ?? 0)
        });
      }
    }
    return out;
  }

  async saveMirroredDecision(
    chainDecisionId: string,
    record: MirroredDecision,
    now: number,
    connection?: Conn
  ): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_DECISIONS_TABLE}
         (chain_decision_id, competition_id, written, held, held_version,
          retry_at, attempts, updated_at)
       values (:chainDecisionId, :competitionId, :written, :held,
          :heldVersion, :retryAt, :attempts, :now)
       on duplicate key update competition_id = :competitionId,
          written = :written, held = :held, held_version = :heldVersion,
          retry_at = :retryAt, attempts = :attempts, updated_at = :now`,
      { chainDecisionId, ...record, now },
      opts(connection)
    );
  }

  async mirroredWaves(
    chainIds: readonly string[]
  ): Promise<Map<string, MirroredWave>> {
    const out = new Map<string, MirroredWave>();
    for (const chunk of statementChunks(
      Array.from(new Set(chainIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<Record<string, unknown>>(
        `select * from ${WAVES_CHAIN_MIRROR_WAVES_TABLE}
          where chain_wave_id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        let keys: string[] = [];
        try {
          const parsed = JSON.parse(String(row.metadata_keys ?? '[]'));
          if (Array.isArray(parsed)) keys = parsed.map(String);
        } catch {
          keys = [];
        }
        out.set(String(row.chain_wave_id), {
          waveId: String(row.wave_id),
          written: (row.written as string | null) ?? null,
          metadataCid: (row.metadata_cid as string | null) ?? null,
          metadataKeys: keys,
          held: (row.held as string | null) ?? null,
          retryAt: row.retry_at === null ? null : Number(row.retry_at),
          attempts: Number(row.attempts ?? 0)
        });
      }
    }
    return out;
  }

  async saveMirroredWave(
    chainWaveId: string,
    record: MirroredWave,
    now: number,
    connection?: Conn
  ): Promise<void> {
    const params = {
      chainWaveId,
      waveId: record.waveId,
      written: record.written,
      metadataCid: record.metadataCid,
      metadataKeys: JSON.stringify(record.metadataKeys),
      held: record.held,
      retryAt: record.retryAt,
      attempts: record.attempts,
      now
    };
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_WAVES_TABLE}
         (chain_wave_id, wave_id, written, metadata_cid, metadata_keys, held,
          retry_at, attempts, updated_at)
       values (:chainWaveId, :waveId, :written, :metadataCid, :metadataKeys,
          :held, :retryAt, :attempts, :now)
       on duplicate key update wave_id = :waveId, written = :written,
          metadata_cid = :metadataCid, metadata_keys = :metadataKeys,
          held = :held, retry_at = :retryAt, attempts = :attempts,
          updated_at = :now`,
      params,
      opts(connection)
    );
  }

  // ------------------------------------------------------------ holds

  /**
   * A wave description's moderation hold: a row of chain_entry_holds under
   * the description drop id, with no competition (''), as an entry's.
   */
  async descriptionHold(dropId: string): Promise<EntryHold | null> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select reason, retry_at, attempts from ${CHAIN_ENTRY_HOLDS_TABLE}
        where entry_id = :dropId and competition_id = ''`,
      { dropId }
    );
    if (!row) return null;
    return {
      reason: String(row.reason),
      retryAt: row.retry_at === null ? null : Number(row.retry_at),
      attempts: Number(row.attempts ?? 0)
    };
  }

  /**
   * Keeps a description's verdict, replacing the one before (a refusal
   * holds only the description it judged). A rebuild keeps none: it reads
   * the live mirror's.
   */
  async holdDescription(
    dropId: string,
    hold: EntryHold,
    now: number,
    connection?: Conn
  ): Promise<void> {
    if (this.mode === 'rebuild') return;
    await this.db.execute(
      `insert into ${CHAIN_ENTRY_HOLDS_TABLE}
         (entry_id, competition_id, reason, held_at, retry_at, attempts)
       values (:dropId, '', :reason, :now, :retryAt, :attempts)
       on duplicate key update reason = :reason, retry_at = :retryAt,
          attempts = :attempts`,
      {
        dropId,
        reason: hold.reason,
        retryAt: hold.retryAt,
        attempts: hold.attempts,
        now
      },
      opts(connection)
    );
  }

  /** A description that went through; a rebuild keeps the holds. */
  async releaseDescription(dropId: string, connection?: Conn): Promise<void> {
    if (this.mode === 'rebuild') return;
    await this.db.execute(
      `delete from ${CHAIN_ENTRY_HOLDS_TABLE}
        where entry_id = :dropId and competition_id = ''`,
      { dropId },
      opts(connection)
    );
  }

  /**
   * Once: the description holds an earlier mirror kept in its wave records
   * (waves_chain_mirror_waves.held), copied into chain_entry_holds under
   * each wave's description drop id; a hold already there is left as it
   * is. Returns how many records held one. A rebuild copies nothing.
   */
  async carryDescriptionHolds(now: number): Promise<number> {
    if (this.mode === 'rebuild') return 0;
    const done = await this.db.oneOrNull<{ name: string }>(
      `select name from ${WAVES_CHAIN_MIRROR_STATE_TABLE} where name = :name`,
      { name: DESCRIPTION_HOLDS_STATE_NAME }
    );
    if (done) return 0;
    const reasons = [DESCRIPTION_REFUSED, DESCRIPTION_DEFERRED];
    return this.inTransaction(async (connection) => {
      const options = opts(connection);
      const [row] = await this.db.execute<{ n: number | string }>(
        `select count(*) as n from ${WAVES_CHAIN_MIRROR_WAVES_TABLE}
          where held in (:reasons)`,
        { reasons },
        options
      );
      await this.db.execute(
        `insert ignore into ${CHAIN_ENTRY_HOLDS_TABLE}
           (entry_id, competition_id, reason, held_at, retry_at, attempts)
         select w.description_drop_id, '', m.held, m.updated_at, m.retry_at,
                m.attempts
           from ${WAVES_CHAIN_MIRROR_WAVES_TABLE} m
           join ${WAVES_TABLE} w on w.id = m.wave_id
          where m.held in (:reasons)`,
        { reasons },
        options
      );
      await this.db.execute(
        `insert into ${WAVES_CHAIN_MIRROR_STATE_TABLE} (name, updated_at)
         values (:name, :now)
         on duplicate key update updated_at = updated_at`,
        { name: DESCRIPTION_HOLDS_STATE_NAME, now },
        options
      );
      return Number(row?.n ?? 0);
    });
  }

  // ------------------------------------------------------------ 6529.io reads

  /**
   * The community_groups row an imported group was made from: the one whose
   * id ends in the UUID's short id, else (an id the import hashed) the one
   * whose keccak256 starts with it. Null when none is.
   */
  async importedGroupId(legacyUuid: string): Promise<string | null> {
    const short = groupShortIdOf(legacyUuid);
    if (!short) return null;
    const matches = await this.db.execute<{ id: string }>(
      `select id from ${USER_GROUPS_TABLE}
        where (id like :pattern or id = :short) and is_direct_message = false`,
      { pattern: `%-${short}`, short }
    );
    const exact = matches.filter(
      (row) => legacyUuidOfGroupId(row.id) === legacyUuid
    );
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null;
    let after = '';
    for (;;) {
      const page = await this.db.execute<{ id: string }>(
        `select id from ${USER_GROUPS_TABLE}
          where id > :after and is_direct_message = false
          order by id limit ${SCAN_PAGE}`,
        { after }
      );
      for (const row of page) {
        if (legacyUuidOfGroupId(row.id) === legacyUuid) return row.id;
      }
      if (page.length < SCAN_PAGE) return null;
      after = page[page.length - 1].id;
    }
  }

  /** Profile ids of these addresses' identities; unknown ones are left out. */
  async profilesOfAddresses(
    addresses: readonly string[],
    connection?: Conn
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of statementChunks(
      Array.from(new Set(addresses.map((a) => a.toLowerCase()))),
      () => 48
    )) {
      const rows = await this.db.execute<{
        address: string;
        profile_id: string | null;
      }>(
        `select a.address, i.profile_id
           from ${ADDRESS_CONSOLIDATION_KEY} a
           join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
          where a.address in (:addresses)`,
        { addresses: chunk },
        opts(connection)
      );
      for (const row of rows) {
        if (row.profile_id) out.set(row.address.toLowerCase(), row.profile_id);
      }
    }
    return out;
  }

  /**
   * Gives addresses no identity has one, and an address's own row without a
   * profile id one, as 6529.io's group create does for a listed address
   * (identitiesDb.insertIdentitiesOnAddressesOnly). `idTimeMillis` is the
   * block time of the group's write: from switch-on the ids are the
   * addresses' derived ones. Returns each address's profile id as it now
   * stands; one without (mapped to a row with none) is absent.
   */
  async addAddressIdentities(
    addresses: readonly string[],
    connection: Conn,
    idTimeMillis: number
  ): Promise<Map<string, string>> {
    if (!addresses.length) return new Map();
    return this.identities.insertIdentitiesOnAddressesOnly(
      addresses,
      connection,
      idTimeMillis
    );
  }

  /**
   * The addresses here whose own identities row (keyed by it) has no profile
   * id and that no other row holds: the rows a group giving them identities
   * updates (insertIdentitiesOnAddressesOnly). An own row whose address is
   * mapped to another row is left alone, so it isn't one. Read only for a
   * group that gives addresses rows, to count the plan.
   */
  async ownRowsWithoutProfile(
    addresses: readonly string[]
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const chunk of statementChunks(
      Array.from(new Set(addresses.map((a) => a.toLowerCase()))),
      () => 48
    )) {
      const rows = await this.db.execute<{ consolidation_key: string }>(
        `select i.consolidation_key from ${IDENTITIES_TABLE} i
           left join ${ADDRESS_CONSOLIDATION_KEY} a on a.address = i.consolidation_key
          where i.consolidation_key in (:keys) and i.profile_id is null
            and (a.consolidation_key is null or a.consolidation_key = i.consolidation_key)`,
        { keys: chunk }
      );
      rows.forEach((row) => out.add(row.consolidation_key.toLowerCase()));
    }
    return out;
  }

  /**
   * The addresses here mapped to another identities row (an identity of
   * several wallets): a group giving them identities leaves them as they
   * are (insertIdentitiesOnAddressesOnly), so one whose row has no profile
   * id can't be listed. Read for the addresses without a profile id, so a
   * plan waits with the group as the write does.
   */
  async addressesMappedElsewhere(
    addresses: readonly string[]
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const chunk of statementChunks(
      Array.from(new Set(addresses.map((a) => a.toLowerCase()))),
      () => 48
    )) {
      const rows = await this.db.execute<{ address: string }>(
        `select address from ${ADDRESS_CONSOLIDATION_KEY}
          where address in (:addresses) and consolidation_key <> address`,
        { addresses: chunk }
      );
      rows.forEach((row) => out.add(row.address.toLowerCase()));
    }
    return out;
  }

  /**
   * Whether the identity mirror's identities rows and wallets stand as of
   * this chain height (identityRowsReached): a group's listed addresses are
   * resolved only then, when its version is written and when its lists are
   * read again as wallets move.
   */
  async identityRowsReached(height: number): Promise<boolean> {
    return identityRowsReached(await this.identityState.getState(), height);
  }

  /**
   * The groups held for the identity mirror this run: their count and the
   * oldest one's chain height (0 groups: none held). Keeps when a hold
   * began, so it lasts across runs, and returns it with whether the hold
   * has been reported (the WARN) and the count and height kept; a run
   * without one clears it. A run that didn't look at every group
   * (`complete` false) keeps the count and height a hold already has.
   */
  async groupsHeld(
    held: {
      readonly count: number;
      readonly oldestHeight: number | null;
      readonly complete: boolean;
    },
    now: number
  ): Promise<{
    since: number;
    reported: boolean;
    count: number;
    oldestHeight: number | null;
  } | null> {
    if (!held.count) {
      await this.db.execute(
        `delete from ${WAVES_CHAIN_MIRROR_STATE_TABLE} where name = :name`,
        { name: GROUPS_HELD_STATE_NAME }
      );
      return null;
    }
    const summary = held.complete
      ? `held_height = values(held_height), held_count = values(held_count),`
      : '';
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_STATE_TABLE}
         (name, held_since, held_height, held_count, held_reported, updated_at)
       values (:name, :now, :height, :count, false, :now)
       on duplicate key update ${summary} updated_at = values(updated_at)`,
      {
        name: GROUPS_HELD_STATE_NAME,
        now,
        height: held.oldestHeight,
        count: held.count
      }
    );
    const row = await this.db.oneOrNull<{
      held_since: number | string | null;
      held_height: number | string | null;
      held_count: number | string | null;
      held_reported: number | boolean | null;
    }>(
      `select held_since, held_height, held_count, held_reported
         from ${WAVES_CHAIN_MIRROR_STATE_TABLE} where name = :name`,
      { name: GROUPS_HELD_STATE_NAME }
    );
    if (!row) return null;
    return {
      since: Number(row.held_since ?? now),
      reported: !!Number(row.held_reported ?? 0),
      count: Number(row.held_count ?? held.count),
      oldestHeight: row.held_height === null ? null : Number(row.held_height)
    };
  }

  /** The current hold has been reported (its WARN written). */
  async groupsHeldReported(): Promise<void> {
    await this.db.execute(
      `update ${WAVES_CHAIN_MIRROR_STATE_TABLE} set held_reported = true
        where name = :name`,
      { name: GROUPS_HELD_STATE_NAME }
    );
  }

  async groupRow(
    id: string,
    connection?: Conn
  ): Promise<UserGroupEntity | null> {
    return this.groups.getByIdWithoutVisibilityCheck(id, connection);
  }

  async waveRow(id: string, connection?: Conn): Promise<WaveEntity | null> {
    // A rebuild reads waves alone: wave_metrics is recomputed after it.
    return this.waves.findWaveHubById(
      id,
      !!connection,
      { connection },
      { withoutMetrics: this.mode === 'rebuild' }
    );
  }

  /** A drop's author and its parts' content and media, in order. */
  async dropParts(
    dropId: string,
    connection?: Conn
  ): Promise<{ authorId: string; parts: WaveDocumentPart[] } | null> {
    const drop = await this.db.oneOrNull<{ author_id: string }>(
      `select author_id from ${DROPS_TABLE} where id = :dropId`,
      { dropId },
      opts(connection)
    );
    if (!drop) return null;
    const parts = await this.db.execute<{
      drop_part_id: number;
      content: string | null;
    }>(
      `select drop_part_id, content from ${DROPS_PARTS_TABLE}
        where drop_id = :dropId order by drop_part_id`,
      { dropId },
      opts(connection)
    );
    const media = await this.db.execute<{
      drop_part_id: number;
      url: string;
      mime_type: string;
    }>(
      `select drop_part_id, url, mime_type from ${DROP_MEDIA_TABLE}
        where drop_id = :dropId order by drop_part_id, id`,
      { dropId },
      opts(connection)
    );
    return {
      authorId: drop.author_id,
      parts: parts.map((part) => ({
        content: part.content ?? null,
        media: media
          .filter((m) => Number(m.drop_part_id) === Number(part.drop_part_id))
          .map((m) => ({ url: m.url, mime_type: m.mime_type }))
      }))
    };
  }

  /** A wave's waves_metadatas by key. */
  async waveMetadata(
    waveId: string,
    connection?: Conn
  ): Promise<Map<string, string>> {
    const rows = await this.db.execute<{
      data_key: string;
      data_value: string;
    }>(
      `select data_key, data_value from ${WAVES_METADATA_TABLE}
        where wave_id = :waveId order by id`,
      { waveId },
      opts(connection)
    );
    return new Map(rows.map((row) => [row.data_key, row.data_value]));
  }

  // ------------------------------------------------------------ writes

  /**
   * A group's row and lists. The row is replaced in place (6529.io keeps
   * one row a group); its lists are written under the version's own ids,
   * and the lists it named before go once no group names them. Returns the
   * profiles whose membership may have moved.
   */
  async writeGroup(write: GroupWrite, connection: Conn): Promise<string[]> {
    const touched = new Set<string>();
    const lists: [string | null, readonly string[]][] = [
      [write.row.profile_group_id, write.includes],
      [write.row.excluded_profile_group_id, write.excludes]
    ];
    for (const [listId, profiles] of lists) {
      if (!listId) continue;
      await this.db.execute(
        `delete from ${PROFILE_GROUPS_TABLE} where profile_group_id = :listId`,
        { listId },
        opts(connection)
      );
      const distinct = Array.from(new Set(profiles));
      await this.insertListMembers(listId, distinct, connection);
      distinct.forEach((p) => touched.add(p));
    }
    if (write.replaces) await this.groups.deleteById(write.row.id, connection);
    await this.groups.save(write.row, connection);
    const keep = new Set(
      [write.row.profile_group_id, write.row.excluded_profile_group_id].filter(
        (id): id is string => !!id
      )
    );
    for (const listId of write.oldListIds) {
      if (keep.has(listId)) continue;
      const named = await this.db.oneOrNull<{ id: string }>(
        `select id from ${USER_GROUPS_TABLE}
          where profile_group_id = :listId or excluded_profile_group_id = :listId
          limit 1`,
        { listId },
        opts(connection)
      );
      if (named) continue;
      const members = await this.db.execute<{ profile_id: string }>(
        `select profile_id from ${PROFILE_GROUPS_TABLE}
          where profile_group_id = :listId`,
        { listId },
        opts(connection)
      );
      members.forEach((m) => touched.add(m.profile_id));
      await this.db.execute(
        `delete from ${PROFILE_GROUPS_TABLE} where profile_group_id = :listId`,
        { listId },
        opts(connection)
      );
    }
    return Array.from(touched);
  }

  /** The list ids of these community_groups rows; a missing row is absent. */
  async groupListIds(
    groupIds: readonly string[]
  ): Promise<Map<string, { include: string | null; exclude: string | null }>> {
    const out = new Map<
      string,
      { include: string | null; exclude: string | null }
    >();
    for (const chunk of statementChunks(
      Array.from(new Set(groupIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<{
        id: string;
        profile_group_id: string | null;
        excluded_profile_group_id: string | null;
      }>(
        `select id, profile_group_id, excluded_profile_group_id
           from ${USER_GROUPS_TABLE} where id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        out.set(row.id, {
          include: row.profile_group_id ?? null,
          exclude: row.excluded_profile_group_id ?? null
        });
      }
    }
    return out;
  }

  /** The profiles in each of these profile_groups lists (none: absent). */
  async groupListMembers(
    listIds: readonly string[]
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const chunk of statementChunks(
      Array.from(new Set(listIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<{
        profile_group_id: string;
        profile_id: string;
      }>(
        `select profile_group_id, profile_id from ${PROFILE_GROUPS_TABLE}
          where profile_group_id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        const members = out.get(row.profile_group_id) ?? new Set<string>();
        members.add(row.profile_id);
        out.set(row.profile_group_id, members);
      }
    }
    return out;
  }

  /**
   * A group's lists brought to their members' current profiles, in place
   * under their ids: each list's `removed` go and its `added` come. The
   * live mirror logs a group change of each of `profiles` (those that
   * gained or lost membership) on the same connection, so the log commits
   * with the lists; a rebuild writes no change log.
   */
  async rewriteGroupLists(
    lists: readonly {
      readonly listId: string;
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }[],
    profiles: readonly string[],
    connection: Conn
  ): Promise<void> {
    for (const { listId, added, removed } of lists) {
      for (const chunk of statementChunks(
        Array.from(new Set(removed)),
        () => ID_BYTES
      )) {
        await this.db.execute(
          `delete from ${PROFILE_GROUPS_TABLE}
            where profile_group_id = :listId and profile_id in (:profiles)`,
          { listId, profiles: chunk },
          opts(connection)
        );
      }
      await this.insertListMembers(
        listId,
        Array.from(new Set(added)),
        connection
      );
    }
    if (this.mode !== 'rebuild' && profiles.length) {
      await this.groups.insertGroupChanges(Array.from(profiles), connection);
    }
  }

  private async insertListMembers(
    listId: string,
    profiles: readonly string[],
    connection: Conn
  ): Promise<void> {
    for (const chunk of statementChunks(profiles, () => ID_BYTES * 2)) {
      await this.db.execute(
        `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
         values ${chunk.map((_, i) => `(:listId, :p${i})`).join(', ')}`,
        {
          listId,
          ...Object.fromEntries(chunk.map((p, i) => [`p${i}`, p]))
        },
        opts(connection)
      );
    }
  }

  /**
   * A wave made on the chain, as 6529.io's wave create writes it: the wave
   * (and its archive row), its description drop, its metadata, the
   * creator's follow (when its id fits) and default group notifications,
   * and the creator's WAVE_CREATED activity.
   */
  async createWave(write: WaveCreate, connection: Conn): Promise<void> {
    const ctx = { connection };
    const { entity, description } = write;
    await this.waves.insertWave(entity, ctx);
    await this.insertDescription(
      {
        dropId: description.dropId,
        waveId: entity.id,
        authorId: description.authorId,
        createdAt: description.createdAt,
        parts: description.parts
      },
      connection
    );
    for (const [key, value] of Object.entries(write.metadata)) {
      await this.db.execute(
        `insert into ${WAVES_METADATA_TABLE} (wave_id, data_key, data_value)
         values (:waveId, :key, :value)`,
        { waveId: entity.id, key, value },
        opts(connection)
      );
    }
    // A rebuild leaves the creator's follows and activity to their areas.
    if (this.mode === 'rebuild') return;
    if (write.follow) {
      await this.subscriptions.addIdentitySubscription(
        {
          subscriber_id: entity.created_by,
          target_id: entity.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: entity.id,
          subscribed_to_all_drops: false
        },
        connection
      );
    }
    await this.groupSubscriptions.addDefaultGroupsForWaveSubscription(
      entity.created_by,
      entity.id,
      connection
    );
    await this.activity.recordWaveCreated(
      {
        creator_id: entity.created_by,
        wave_id: entity.id,
        visibility_group_id: entity.visibility_group_id
      },
      ctx
    );
  }

  private async insertDescription(
    input: {
      readonly dropId: string;
      readonly waveId: string;
      readonly authorId: string;
      readonly createdAt: number;
      readonly parts: readonly WaveDocumentPart[];
    },
    connection: Conn
  ): Promise<void> {
    await this.drops.insertDrop(
      {
        id: input.dropId,
        author_id: input.authorId,
        drop_type: DropType.CHAT,
        wave_id: input.waveId,
        created_at: input.createdAt,
        updated_at: null,
        title: null,
        parts_count: input.parts.length,
        signature: null,
        is_additional_action_promised: null,
        hide_link_preview: false,
        collapse_replies: false,
        reply_to_drop_id: null,
        reply_to_part_id: null,
        serial_no: null
      },
      connection,
      // A rebuild writes no wave metrics: they are recomputed from drops
      // after it.
      { deferMetrics: this.mode === 'rebuild' }
    );
    await this.insertParts(input, connection);
  }

  private async insertParts(
    input: {
      readonly dropId: string;
      readonly waveId: string;
      readonly parts: readonly WaveDocumentPart[];
    },
    connection: Conn
  ): Promise<void> {
    await this.drops.insertDropParts(
      input.parts.map((part, index) => ({
        drop_id: input.dropId,
        drop_part_id: index + 1,
        content: part.content,
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: input.waveId
      })),
      connection
    );
    await this.drops.insertDropMedia(
      input.parts.flatMap((part, index) =>
        part.media.map((media) => ({
          drop_id: input.dropId,
          drop_part_id: index + 1,
          url: media.url,
          mime_type: media.mime_type,
          media_upload_id: null,
          wave_id: input.waveId
        }))
      ),
      connection
    );
  }

  /** A description drop's parts replaced in place, as a drop edit does. */
  async replaceDescription(
    input: {
      readonly dropId: string;
      readonly waveId: string;
      readonly parts: readonly WaveDocumentPart[];
      readonly at: number;
    },
    connection: Conn
  ): Promise<void> {
    const ctx = { connection };
    await this.drops.deleteDropParts(input.dropId, ctx);
    await this.drops.deleteDropMedia(input.dropId, ctx);
    await this.insertParts(input, connection);
    await this.db.execute(
      `update ${DROPS_TABLE} set parts_count = :count, updated_at = :at
        where id = :dropId`,
      { count: input.parts.length, at: input.at, dropId: input.dropId },
      opts(connection)
    );
  }

  /**
   * A wave's row edited as 6529.io's hub edit does it: the row locked,
   * patched (applyWaveHubPatch) and written again with its hub
   * configuration kept, and a new visibility group carried into its feed
   * items and notifications. Returns the row before, or null when gone.
   */
  async editWave(
    input: {
      readonly waveId: string;
      readonly patch: ApiUpdateWaveHubRequest;
      readonly createdBy: string | null;
    },
    connection: Conn
  ): Promise<{ before: WaveEntity; after: WaveEntity } | null> {
    const ctx = { connection };
    const before = await this.waves.findWaveHubById(input.waveId, true, ctx, {
      withoutMetrics: this.mode === 'rebuild'
    });
    if (!before) return null;
    const patched = applyWaveHubPatch(before, input.patch);
    const after: WaveEntity = {
      ...patched,
      created_by: input.createdBy ?? patched.created_by
    };
    const hubConfiguration = await this.waves.findWaveHubConfigurationForUpdate(
      input.waveId,
      ctx
    );
    await this.waves.deleteWave(input.waveId, ctx);
    await this.waves.insertWave(
      {
        ...after,
        is_direct_message: after.is_direct_message ?? false,
        voting_credit_nfts: []
      },
      ctx,
      { preserveHubConfigurationFrom: hubConfiguration }
    );
    if (after.visibility_group_id !== before.visibility_group_id) {
      await this.waves.updateVisibilityInFeedEntities(
        {
          waveId: input.waveId,
          newVisibilityGroupId: after.visibility_group_id
        },
        ctx
      );
      await this.waves.updateVisibilityInNotifications(
        {
          waveId: input.waveId,
          newVisibilityGroupId: after.visibility_group_id
        },
        ctx
      );
    }
    return { before, after };
  }

  /** waves_metadatas set and removed by key. */
  async writeMetadata(
    waveId: string,
    changes: {
      readonly upsert: readonly { key: string; value: string }[];
      readonly remove: readonly string[];
    },
    connection: Conn
  ): Promise<void> {
    for (const key of [
      ...changes.remove,
      ...changes.upsert.map((change) => change.key)
    ]) {
      await this.db.execute(
        `delete from ${WAVES_METADATA_TABLE}
          where wave_id = :waveId and data_key = :key`,
        { waveId, key },
        opts(connection)
      );
    }
    for (const { key, value } of changes.upsert) {
      await this.db.execute(
        `insert into ${WAVES_METADATA_TABLE} (wave_id, data_key, data_value)
         values (:waveId, :key, :value)`,
        { waveId, key, value },
        opts(connection)
      );
    }
  }

  /** A competitions row the mirror writes for a decision made on the chain. */
  async nativeCompetition(
    id: string,
    connection?: Conn
  ): Promise<NativeCompetitionRow | null> {
    const row = await this.db.oneOrNull<{
      id: string;
      config_version: number | string;
      created_at: number | string;
    }>(
      `select id, config_version, created_at from ${COMPETITIONS_TABLE}
        where id = :id${connection ? ' for update' : ''}`,
      { id },
      opts(connection)
    );
    return row
      ? {
          id: row.id,
          configVersion: Number(row.config_version),
          createdAt: Number(row.created_at)
        }
      : null;
  }

  /**
   * Writes a decision made on the chain as 6529.io's create and update
   * write a competition: the row, its config version, its outcome
   * definitions, a lifecycle event (on create) and the outbox event.
   */
  async writeNativeCompetition(
    write: NativeCompetitionWrite,
    connection: Conn
  ): Promise<void> {
    const { record, draft, now } = write;
    const options = { wrappedConnection: connection };
    const value = (key: string) => {
      const v = (record as unknown as Record<string, unknown>)[key];
      return COMPETITION_JSON_COLUMNS.has(key) && v !== null && v !== undefined
        ? JSON.stringify(v)
        : (v ?? null);
    };
    if (write.create) {
      const columns = Object.keys(record);
      await this.db.execute(
        `insert into ${COMPETITIONS_TABLE} (${columns.join(', ')})
         values (${columns.map((c) => `:${c}`).join(', ')})`,
        Object.fromEntries(columns.map((c) => [c, value(c)])),
        options
      );
      await this.db.execute(
        `insert into ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
           (id, competition_id, wave_id, previous_lifecycle, lifecycle,
            actor_id, created_at)
         values (:id, :competitionId, :waveId, null, :lifecycle, null, :now)`,
        {
          id: stableUuid(record.id, 'lifecycle:created'),
          competitionId: record.id,
          waveId: record.wave_id,
          lifecycle: record.lifecycle,
          now
        },
        options
      );
    } else {
      // A new policy version: its config, keeping the next result time the
      // decisions pass keeps (from the chain's schedule).
      await this.db.execute(
        `update ${COMPETITIONS_TABLE}
            set ${COMPETITION_CONFIG_COLUMNS.map((c) => `${c} = :${c}`).join(', ')},
                decision_config = json_set(:decision_config,
                  '$.next_decision_time',
                  json_extract(decision_config, '$.next_decision_time'))
          where id = :id`,
        {
          id: record.id,
          decision_config: value('decision_config'),
          ...Object.fromEntries(
            COMPETITION_CONFIG_COLUMNS.map((c) => [c, value(c)])
          )
        },
        options
      );
    }
    await this.db.execute(
      `insert ignore into ${COMPETITION_CONFIG_VERSIONS_TABLE}
         (competition_id, version, config, created_by, created_at)
       values (:id, :version, :config, null, :now)`,
      {
        id: record.id,
        version: record.config_version,
        config: JSON.stringify(draft),
        now
      },
      options
    );
    await competitionCommandRepository.replaceOutcomeDefinitions(
      record.id,
      draft.outcomes,
      now,
      { connection }
    );
    if (this.mode === 'rebuild') return;
    await nativeCompetitionRuntimeRepository.enqueueEvent(
      {
        key: write.create
          ? record.id
          : `${record.id}:config:${record.config_version}`,
        event_type: write.create
          ? 'COMPETITION_CREATED'
          : 'COMPETITION_UPDATED',
        wave_id: record.wave_id,
        competition_id: record.id,
        occurred_at: now,
        data: {
          config_version: record.config_version,
          lifecycle: record.lifecycle
        }
      },
      { connection }
    );
  }

  // ------------------------------------------------------------ imported rows

  /**
   * Imported decisions (a rebuild writes the rows 6529.io has none of):
   * their chain ids, legacy ids and data.
   */
  async chainImportedDecisions(): Promise<
    { decision_id: string; legacy_id: string | null; data: unknown }[]
  > {
    if (this.mode !== 'rebuild') return [];
    return this.db.execute(
      `select decision_id, legacy_id, data from ${CHAIN_DECISIONS_TABLE}
        where origin = 'legacy'
        order by decision_id`
    );
  }

  /** Whether 6529.io has a competitions row of this id. */
  async competitionExists(id: string): Promise<boolean> {
    const row = await this.db.oneOrNull<{ id: string }>(
      `select id from ${COMPETITIONS_TABLE} where id = :id`,
      { id }
    );
    return !!row;
  }

  /**
   * An imported wave's description drop id, as the drop archives' import
   * gave it (the import-files reader writes the description drops under
   * their original ids); null without it.
   */
  async importedDescriptionDropId(waveId: string): Promise<string | null> {
    return (
      this.dropArchives?.descriptionDropIds.get(waveId.toLowerCase()) ?? null
    );
  }

  /**
   * Whether a drop of this id is in the wave, once the drop archives'
   * import wrote them; null when none ran (nothing to check against).
   */
  async descriptionDropInWave(
    dropId: string,
    waveId: string
  ): Promise<boolean | null> {
    if (!this.dropArchives) return null;
    const row = await this.db.oneOrNull<{ id: string }>(
      `select id from ${DROPS_TABLE} where id = :dropId and wave_id = :waveId`,
      { dropId, waveId }
    );
    return !!row;
  }

  /**
   * A rebuild's imported groups the chain never replaced (version 1): the
   * rebuild matches each to 6529.io's row, as the live mirror matches the
   * groups it meets, and keeps the match in its records.
   */
  async chainImportedGroups(): Promise<ChainGroupRow[]> {
    if (this.mode !== 'rebuild') return [];
    return this.db.execute<ChainGroupRow>(
      `select group_id, legacy_id, version, origin, height, data
         from ${CHAIN_GROUPS_TABLE}
        where origin = 'legacy' and version <= 1
        order by group_id`
    );
  }

  /**
   * The imported groups the chain never replaced (version 1) whose
   * definition lists an address, live and in a rebuild: the member lists
   * that follow wallet bindings. The pass checks each again.
   */
  async chainImportedGroupsListingAddresses(): Promise<ChainGroupRow[]> {
    return this.db.execute<ChainGroupRow>(
      `select group_id, legacy_id, version, origin, height, data
         from ${CHAIN_GROUPS_TABLE}
        where origin = 'legacy' and version <= 1
          and (json_search(data, 'one', 'address', null,
                 '$.definition.includes[*].kind') is not null
            or json_search(data, 'one', 'address', null,
                 '$.definition.excludes[*].kind') is not null)
        order by group_id`
    );
  }

  /** A rebuild's row of an imported wave; the live mirror writes none. */
  async insertImportedWave(
    entity: InsertWaveEntity,
    connection: Conn
  ): Promise<void> {
    if (this.mode !== 'rebuild') return;
    await this.waves.insertWave(entity, { connection });
  }

  /**
   * A rebuild's rows of an imported decision: its competitions row, the
   * row of its current config version, its capabilities, and its outcomes
   * unless it is a wave's primary (written by 6529.io's retired
   * migration). The live mirror writes none.
   */
  async insertImportedCompetition(
    input: {
      readonly record: CompetitionEntity;
      readonly capabilities: readonly string[];
      readonly outcomes: readonly Record<string, unknown>[];
    },
    connection: Conn
  ): Promise<void> {
    if (this.mode !== 'rebuild') return;
    const { record } = input;
    const options = { wrappedConnection: connection };
    const row = record as unknown as Record<string, unknown>;
    const columns = Object.keys(row);
    await this.db.execute(
      `insert into ${COMPETITIONS_TABLE} (${columns.join(', ')})
       values (${columns.map((c) => `:${c}`).join(', ')})`,
      Object.fromEntries(
        columns.map((c) => [
          c,
          COMPETITION_JSON_COLUMNS.has(c) && row[c] !== null
            ? JSON.stringify(row[c])
            : (row[c] ?? null)
        ])
      ),
      options
    );
    await this.db.execute(
      `insert ignore into ${COMPETITION_CONFIG_VERSIONS_TABLE}
         (competition_id, version, config, created_by, created_at)
       values (:id, :version, :config, null, :createdAt)`,
      {
        id: record.id,
        version: record.config_version,
        config: JSON.stringify(record),
        createdAt: record.created_at
      },
      options
    );
    for (const capability of input.capabilities) {
      await this.db.execute(
        `insert ignore into ${COMPETITION_CAPABILITIES_TABLE}
           (capability, competition_id, wave_id, assigned_by,
            legacy_source_wave_id, assigned_at)
         values (:capability, :id, :waveId, null, null, :at)`,
        {
          capability,
          id: record.id,
          waveId: record.wave_id,
          at: record.created_at
        },
        options
      );
    }
    if (record.legacy_wave_id !== null) return;
    const outcomes = input.outcomes.flatMap((o) =>
      typeof o.type === 'string' && typeof o.description === 'string'
        ? [
            o as {
              type: string;
              description: string;
              distribution?: { amount?: number | null }[];
            }
          ]
        : []
    );
    await competitionCommandRepository.replaceOutcomeDefinitions(
      record.id,
      outcomes,
      record.created_at,
      { connection }
    );
  }

  /** One READ COMMITTED transaction, as the mirror's other writes. */
  async inTransaction<T>(fn: (connection: Conn) => Promise<T>): Promise<T> {
    return this.executeNativeQueriesInTransaction(fn, {
      isolationLevel: 'READ COMMITTED'
    });
  }
}

export const wavesChainObjectsDb = new WavesChainObjectsDb(
  () => writerPoolExecutor
);

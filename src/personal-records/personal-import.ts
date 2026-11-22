import {
  ARTIST_ARTWORK_ALERTS_TABLE,
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROPS_TABLE,
  EULA_CONSENT_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  MENTION_ALIAS_MEMBERS_TABLE,
  MENTION_ALIASES_TABLE,
  PINNED_WAVES_TABLE,
  PROFILE_PREFERENCES_TABLE,
  PROFILES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import {
  IngestOutcome,
  KEYS_LABEL,
  RecordChange,
  RecordIndexer
} from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import {
  compareOrderKeys,
  importOrderKey,
  RecordOrderKey
} from '@/signed-records/record-order';
import type { VerifiedRecord } from '@/signed-records/record-verify';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  PERSONAL_MODERATION_ACTIONS,
  PERSONAL_MODERATION_LOG_TYPE,
  PersonalRecordType
} from './personal-record-types';

/** The record log lane of the one-time import at the switch. */
export const PERSONAL_IMPORT_LANE = 'personal-import';

// One owner's items per entry, split so an entry stays far below 4 MiB.
const ITEMS_PER_ENTRY = 2_000;
// Owners read and resolved per page.
const OWNERS_PER_PAGE = 500;

/** Sorts strings by code unit: the same everywhere, unlike a locale. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : Number(a > b);

export interface PersonalImportItem {
  readonly t: string;
  readonly k: string;
  // null unsets: a follow of one's own wave or drop the person removed,
  // which a rebuild otherwise derives from the waves index.
  readonly b: Record<string, unknown> | null;
}

/**
 * One log entry of the import: one owner's state in one family, as it was
 * at the switch. Its changes take the import order key (anchor, at, 0x0).
 */
export interface PersonalImportBody {
  readonly v: 1;
  readonly anchor: number;
  readonly at: number;
  readonly owner: string;
  readonly family: 'ps' | 'pv';
  readonly items: readonly PersonalImportItem[];
}

/** The last entry of a complete import: a rebuild takes no partial one. */
export interface PersonalImportDone {
  readonly v: 1;
  readonly anchor: number;
  readonly at: number;
  readonly done: true;
  readonly entries: number;
}

export function isImportDone(
  body: PersonalImportBody | PersonalImportDone
): body is PersonalImportDone {
  return (body as PersonalImportDone).done === true;
}

const PUSH_FIELDS = [
  'identity_subscribed',
  'identity_mentioned',
  'identity_rep',
  'identity_nic',
  'drop_quoted',
  'drop_replied',
  'drop_voted',
  'drop_reacted',
  'drop_boosted',
  'wave_created',
  'subscription_coverage'
];

const NOTIFY_CATEGORIES = [
  'direct_messages',
  'mentions_replies_quotes',
  'reactions_votes_boosts',
  'new_followers',
  'rep_and_nic',
  'subscription_coverage'
];

const truthy = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

type Row = Record<string, unknown>;

/** One page of owners and every row of theirs, table by table. */
export interface PersonalExportPage {
  readonly follows: Row[];
  readonly waveGroups: Row[];
  readonly ownWavesUnfollowed: Row[];
  readonly ownDropsUnfollowed: Row[];
  readonly mutes: Row[];
  readonly blocks: Row[];
  readonly hidden: Row[];
  readonly bookmarks: Row[];
  readonly alerts: Row[];
  readonly pins: Row[];
  readonly preferences: Row[];
  readonly aliases: Row[];
  readonly aliasMembers: Row[];
  readonly push: Row[];
  readonly eula: Row[];
  // The person's own block and hide history (four audit actions).
  readonly moderationLog: Row[];
}

/**
 * Turns pages of today's rows into import entries. Owners and targets are
 * mapped to stream owners in one batch per page; an item that a type's
 * check refuses is left out and counted, never sent to fail a whole entry.
 */
export class PersonalImportBuilder {
  readonly skipped = new Map<string, number>();
  private entries = 0;

  constructor(
    private readonly deps: {
      readonly anchor: number;
      readonly at: number;
      // Profile ids to stream owners; missing ids have none.
      readonly ownersOf: (
        profileIds: readonly string[]
      ) => Promise<Map<string, string>>;
      // The type's own check, as a rebuild will run it; a reason or null.
      readonly check: (
        family: 'ps' | 'pv',
        item: PersonalImportItem
      ) => string | null;
      readonly emit: (entries: RecordLogEntry[]) => Promise<void>;
    }
  ) {}

  private skip(reason: string) {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + 1);
  }

  async addPage(page: PersonalExportPage): Promise<void> {
    const ids = new Set<string>();
    const collect = (rows: Row[], ...columns: string[]) => {
      for (const row of rows) {
        for (const column of columns) {
          if (typeof row[column] === 'string') ids.add(row[column] as string);
        }
      }
    };
    collect(page.follows, 'subscriber_id');
    collect(
      page.follows.filter((row) => row.target_type === 'IDENTITY'),
      'target_id'
    );
    collect(page.waveGroups, 'identity_id');
    collect(page.ownWavesUnfollowed, 'created_by');
    collect(page.ownDropsUnfollowed, 'author_id');
    collect(page.mutes, 'muter_id', 'muted_identity_id');
    collect(page.blocks, 'blocker_profile_id', 'blocked_profile_id');
    collect(page.hidden, 'profile_id');
    collect(page.bookmarks, 'identity_id');
    collect(page.alerts, 'subscriber_id', 'artist_id');
    collect(page.pins, 'profile_id');
    collect(page.preferences, 'profile_id');
    collect(page.aliases, 'owner_profile_id');
    collect(page.aliasMembers, 'member_profile_id');
    collect(page.push, 'profile_id');
    collect(page.eula, 'profile_id');
    collect(page.moderationLog, 'actor_profile_id', 'target_profile_id');
    const owners = await this.deps.ownersOf(Array.from(ids));

    const items = new Map<string, PersonalImportItem[]>();
    const add = (
      profileId: string,
      family: 'ps' | 'pv',
      item: PersonalImportItem
    ) => {
      const owner = owners.get(profileId);
      if (!owner) {
        this.skip('no owner');
        return;
      }
      const refusal = this.deps.check(family, item);
      if (refusal) {
        this.skip(`${item.t}: ${refusal}`);
        return;
      }
      const id = `${family}|${owner}`;
      const list = items.get(id);
      if (list) list.push(item);
      else items.set(id, [item]);
    };

    this.addFollows(page, owners, add);
    for (const row of page.ownWavesUnfollowed) {
      add(String(row.created_by), 'pv', {
        t: PersonalRecordType.FOLLOW,
        k: `wave:${row.id}`,
        b: null
      });
    }
    for (const row of page.ownDropsUnfollowed) {
      add(String(row.author_id), 'pv', {
        t: PersonalRecordType.FOLLOW,
        k: `drop:${row.id}`,
        b: null
      });
    }
    const profileFlag = (
      type: string,
      rows: Row[],
      ownerColumn: string,
      targetColumn: string,
      atColumn: string
    ) => {
      for (const row of rows) {
        const target = owners.get(String(row[targetColumn]));
        if (!target) {
          this.skip('no owner');
          continue;
        }
        add(String(row[ownerColumn]), 'pv', {
          t: type,
          k: target,
          b: { at: Number(row[atColumn]) }
        });
      }
    };
    profileFlag(
      PersonalRecordType.MUTE,
      page.mutes,
      'muter_id',
      'muted_identity_id',
      'created_at'
    );
    profileFlag(
      PersonalRecordType.BLOCK,
      page.blocks,
      'blocker_profile_id',
      'blocked_profile_id',
      'created_at'
    );
    profileFlag(
      PersonalRecordType.ART_ALERT,
      page.alerts,
      'subscriber_id',
      'artist_id',
      'enabled_at'
    );
    for (const row of page.hidden) {
      add(String(row.profile_id), 'pv', {
        t: PersonalRecordType.HIDE,
        k: String(row.drop_id),
        b: { at: Number(row.created_at) }
      });
    }
    for (const row of page.bookmarks) {
      add(String(row.identity_id), 'pv', {
        t: PersonalRecordType.BOOKMARK,
        k: String(row.drop_id),
        b: { at: Number(row.bookmarked_at) }
      });
    }
    this.addPins(page, add);
    this.addPreferences(page, add);
    this.addAliases(page, owners, add);
    for (const row of page.push) {
      add(String(row.profile_id), 'pv', {
        t: PersonalRecordType.PUSH,
        k: String(row.device_id),
        b: Object.fromEntries(
          PUSH_FIELDS.map((field) => [field, truthy(row[field])])
        )
      });
    }
    for (const row of page.eula) {
      if (!row.profile_id || !row.platform || !row.eula_version) {
        continue;
      }
      add(String(row.profile_id), 'pv', {
        t: PersonalRecordType.EULA,
        k: String(row.device_id),
        b: {
          version: String(row.eula_version),
          platform: String(row.platform),
          at: Number(row.accepted_at)
        }
      });
    }

    this.addModerationLog(page, owners, add);

    const entries: RecordLogEntry[] = [];
    // Public entries first; in pv a follow comes before its wave-notify.
    for (const family of ['ps', 'pv'] as const) {
      for (const [id, list] of Array.from(items.entries())) {
        if (!id.startsWith(`${family}|`)) continue;
        const owner = id.slice(family.length + 1);
        for (let i = 0; i < list.length; i += ITEMS_PER_ENTRY) {
          const body: PersonalImportBody = {
            v: 1,
            anchor: this.deps.anchor,
            at: this.deps.at,
            owner,
            family,
            items: list.slice(i, i + ITEMS_PER_ENTRY)
          };
          entries.push(importEntry(family, body));
        }
      }
    }
    this.entries += entries.length;
    if (entries.length) await this.deps.emit(entries);
  }

  /**
   * Today's audit rows of a person's own blocks and hides, oldest first,
   * each at its stored time, so the audit log's rebuild can write them
   * again (personalModerationAuditRows).
   */
  private addModerationLog(
    page: PersonalExportPage,
    owners: Map<string, string>,
    add: (profileId: string, family: 'pv', item: PersonalImportItem) => void
  ) {
    for (const row of page.moderationLog) {
      const action = String(row.action);
      const isProfile = action.startsWith('PROFILE_');
      const target = isProfile
        ? owners.get(String(row.target_profile_id))
        : String(row.target_drop_id ?? '');
      if (
        !Object.prototype.hasOwnProperty.call(
          PERSONAL_MODERATION_ACTIONS,
          action
        ) ||
        !target
      ) {
        this.skip(isProfile ? 'no owner' : 'moderation-log: no target');
        continue;
      }
      add(String(row.actor_profile_id), 'pv', {
        t: PERSONAL_MODERATION_LOG_TYPE,
        k: String(row.id),
        b: {
          action,
          target,
          previous: String(row.previous_state),
          next: String(row.new_state),
          at: Number(row.created_at)
        }
      });
    }
  }

  private addFollows(
    page: PersonalExportPage,
    owners: Map<string, string>,
    add: (
      profileId: string,
      family: 'ps' | 'pv',
      item: PersonalImportItem
    ) => void
  ) {
    const follows = new Map<
      string,
      { row: Row; actions: string[]; all: boolean }
    >();
    for (const row of page.follows) {
      // One's own drops and waves are derived from the waves index.
      if (truthy(row.own_target)) continue;
      const id = `${row.subscriber_id}|${row.target_type}|${row.target_id}`;
      const follow = follows.get(id);
      if (follow) {
        follow.actions.push(String(row.target_action));
        follow.all = follow.all || truthy(row.subscribed_to_all_drops);
      } else {
        follows.set(id, {
          row,
          actions: [String(row.target_action)],
          all: truthy(row.subscribed_to_all_drops)
        });
      }
    }
    const groups = new Map<string, string[]>();
    for (const row of page.waveGroups) {
      const id = `${row.identity_id}|${row.wave_id}`;
      const list = groups.get(id);
      if (list) list.push(String(row.mentioned_group));
      else groups.set(id, [String(row.mentioned_group)]);
    }
    for (const { row, actions } of Array.from(follows.values())) {
      const sub = String(row.subscriber_id);
      const type = String(row.target_type);
      if (type === 'IDENTITY') {
        const target = owners.get(String(row.target_id));
        if (!target) {
          this.skip('no owner');
          continue;
        }
        add(sub, 'ps', {
          t: PersonalRecordType.FOLLOW,
          k: `identity:${target}`,
          // In row order: the API lists a follow's actions so.
          b: { actions: [...actions] }
        });
      } else {
        add(sub, 'pv', {
          t: PersonalRecordType.FOLLOW,
          k: `${type.toLowerCase()}:${row.target_id}`,
          // In row order: the API lists a follow's actions so.
          b: { actions: [...actions] }
        });
      }
    }
    // wave-notify: every followed wave (own or not) whose state differs
    // from a follow's defaults (all drops off, the ALL group).
    const waveStates = new Map<
      string,
      { sub: string; wave: string; all: boolean }
    >();
    for (const row of page.follows) {
      if (row.target_type !== 'WAVE' || row.target_action !== 'DROP_CREATED') {
        continue;
      }
      waveStates.set(`${row.subscriber_id}|${row.target_id}`, {
        sub: String(row.subscriber_id),
        wave: String(row.target_id),
        all: truthy(row.subscribed_to_all_drops)
      });
    }
    for (const [id, state] of Array.from(waveStates.entries())) {
      const waveGroups = [...(groups.get(id) ?? [])].sort(byCodeUnit);
      const own = page.follows.some(
        (row) =>
          `${row.subscriber_id}|${row.target_id}` === id &&
          truthy(row.own_target)
      );
      // A creator's DM wave starts with all drops on.
      const defaultAll =
        own &&
        truthy(
          page.follows.find(
            (row) => `${row.subscriber_id}|${row.target_id}` === id
          )?.own_is_dm
        );
      if (state.all !== defaultAll || waveGroups.join(',') !== 'ALL') {
        add(state.sub, 'pv', {
          t: PersonalRecordType.WAVE_NOTIFY,
          k: state.wave,
          b: { all_drops: state.all, groups: waveGroups }
        });
      }
    }
  }

  private addPins(
    page: PersonalExportPage,
    add: (
      profileId: string,
      family: 'ps' | 'pv',
      item: PersonalImportItem
    ) => void
  ) {
    // A pin with no saved position takes the next one after its owner's.
    const last = new Map<string, number>();
    for (const row of page.pins) {
      if (row.position !== null) {
        const owner = String(row.profile_id);
        last.set(owner, Math.max(last.get(owner) ?? 0, Number(row.position)));
      }
    }
    const pins = [...page.pins].sort((a, b) =>
      String(a.wave_id) < String(b.wave_id)
        ? -1
        : Number(String(a.wave_id) > String(b.wave_id))
    );
    for (const row of pins) {
      const owner = String(row.profile_id);
      let pos = row.position === null ? null : Number(row.position);
      if (pos === null) {
        pos = (last.get(owner) ?? 0) + 1;
        last.set(owner, pos);
      }
      add(owner, 'pv', {
        t: PersonalRecordType.PIN,
        k: String(row.wave_id),
        b: { pos }
      });
    }
  }

  private addPreferences(
    page: PersonalExportPage,
    add: (
      profileId: string,
      family: 'ps' | 'pv',
      item: PersonalImportItem
    ) => void
  ) {
    // Only the keys that differ from the defaults.
    for (const row of page.preferences) {
      const profileId = String(row.profile_id);
      const policy = String(row.direct_message_policy);
      const groupId = (row.direct_message_group_id as string | null) ?? null;
      const allow = truthy(row.direct_message_allow_people_i_follow);
      if (policy !== 'EVERYONE' || groupId !== null || !allow) {
        add(profileId, 'pv', {
          t: PersonalRecordType.PREF,
          k: 'dm',
          b: { policy, group_id: groupId, allow_people_i_follow: allow }
        });
      }
      if (String(row.notification_level) !== 'ALL') {
        add(profileId, 'pv', {
          t: PersonalRecordType.PREF,
          k: 'level',
          b: { value: String(row.notification_level) }
        });
      }
      for (const category of NOTIFY_CATEGORIES) {
        if (!truthy(row[`notify_${category}`])) {
          add(profileId, 'pv', {
            t: PersonalRecordType.PREF,
            k: `notify.${category}`,
            b: { on: false }
          });
        }
      }
    }
  }

  private addAliases(
    page: PersonalExportPage,
    owners: Map<string, string>,
    add: (
      profileId: string,
      family: 'ps' | 'pv',
      item: PersonalImportItem
    ) => void
  ) {
    const members = new Map<string, Row[]>();
    for (const row of page.aliasMembers) {
      const id = String(row.alias_id);
      const list = members.get(id);
      if (list) list.push(row);
      else members.set(id, [row]);
    }
    for (const alias of page.aliases) {
      const memberOwners: string[] = [];
      for (const member of (members.get(String(alias.id)) ?? []).sort(
        (a, b) => Number(a.position) - Number(b.position)
      )) {
        const owner = owners.get(String(member.member_profile_id));
        if (owner) memberOwners.push(owner);
        else this.skip('no owner');
      }
      if (!memberOwners.length) {
        this.skip('alias without members');
        continue;
      }
      add(String(alias.owner_profile_id), 'pv', {
        t: PersonalRecordType.ALIAS,
        k: String(alias.alias),
        b: { members: memberOwners, id: String(alias.id) }
      });
    }
  }

  /** The closing entry: a rebuild takes an import only with it. */
  async finish(): Promise<{
    entries: number;
    skipped: Record<string, number>;
  }> {
    const done: PersonalImportDone = {
      v: 1,
      anchor: this.deps.anchor,
      at: this.deps.at,
      done: true,
      entries: this.entries
    };
    await this.deps.emit([
      {
        t: 'entry',
        lane: PERSONAL_IMPORT_LANE,
        chain: 'public',
        body: done as unknown as Record<string, unknown>
      }
    ]);
    return {
      entries: this.entries,
      skipped: Object.fromEntries(Array.from(this.skipped.entries()))
    };
  }
}

function importEntry(
  family: 'ps' | 'pv',
  body: PersonalImportBody
): RecordLogEntry {
  return {
    t: 'entry',
    lane: PERSONAL_IMPORT_LANE,
    chain: family === 'ps' ? 'public' : 'private',
    body: body as unknown as Record<string, unknown>
  };
}

/** An import entry's changes, at the import order key. */
export function importChangesOf(body: PersonalImportBody): RecordChange[] {
  const order = importOrderKey(body.anchor, body.at);
  return body.items.map((item) => ({
    owner: body.owner,
    family: body.family,
    type: item.t,
    key: item.k,
    body: item.b,
    order,
    eventId: null,
    sealedClass: body.family === 'pv' ? 1 : null,
    writer: 'author'
  }));
}

/**
 * A hide or block a person set while reporting a drop (POST
 * /drops/:id/reports with hide_drop or block_author). Today's route writes
 * the tables directly, so no personal record holds it; the reporter's
 * sealed md report record does (reporter, drop, author, the two flags),
 * and the reports' rebuild hands them over with the md record's order key.
 * Reports filed before the flags existed carry null: the import holds the
 * state they left.
 */
export interface ReportEffect {
  readonly reporter: string;
  readonly dropId: string;
  readonly author: string | null;
  readonly hideDrop: boolean | null;
  readonly blockAuthor: boolean | null;
  readonly order: RecordOrderKey;
}

/** A report's hide and block as personal changes (owners already mapped). */
export function reportEffectChanges(effect: ReportEffect): RecordChange[] {
  const changes: RecordChange[] = [];
  const base = {
    owner: effect.reporter,
    family: 'pv' as const,
    order: effect.order,
    eventId: null,
    sealedClass: 1,
    writer: 'author' as const,
    body: { at: effect.order.claimedTime }
  };
  if (effect.hideDrop === true) {
    changes.push({
      ...base,
      type: PersonalRecordType.HIDE,
      key: effect.dropId
    });
  }
  if (effect.blockAuthor === true && effect.author) {
    changes.push({
      ...base,
      type: PersonalRecordType.BLOCK,
      key: effect.author
    });
  }
  return changes;
}

export interface PersonalRebuildReport {
  readonly importOrder: RecordOrderKey | null;
  readonly importEntries: number;
  readonly records: number;
  // Records ordered at or before the import: the import holds their result.
  readonly beforeImport: number;
  readonly refused: readonly {
    readonly what: string;
    readonly detail: string;
  }[];
}

/**
 * The latest complete import (the one with its closing entry) and its
 * entries. Throws when entries are missing: a rebuild takes no partial one.
 */
export function latestImport(
  imports: readonly (PersonalImportBody | PersonalImportDone)[]
): {
  readonly done: PersonalImportDone | null;
  readonly imported: PersonalImportBody[];
} {
  const done =
    imports
      .filter(isImportDone)
      .sort((a, b) =>
        compareOrderKeys(
          importOrderKey(b.anchor, b.at),
          importOrderKey(a.anchor, a.at)
        )
      )[0] ?? null;
  const imported = done
    ? imports.filter(
        (body): body is PersonalImportBody =>
          !isImportDone(body) &&
          body.anchor === done.anchor &&
          body.at === done.at
      )
    : [];
  if (done && imported.length !== done.entries) {
    throw new Error(
      `The import at ${done.at} has ${imported.length} entries, not ${done.entries}`
    );
  }
  return { done, imported };
}

/**
 * Rebuilds the personal tables from empty:
 * 1. what the waves index implies (`derive`: one's own waves and drops);
 * 2. the latest complete import (the one with its closing entry);
 * 3. every signed record ordered after that import, in merge order (keys
 *    records first, so sealed items open).
 * Records ordered at or before the import are left out: the import holds
 * their outcome. Refusals are reported, never skipped silently.
 */
export async function rebuildPersonalState(args: {
  readonly indexer: RecordIndexer;
  readonly imports: readonly (PersonalImportBody | PersonalImportDone)[];
  readonly records: readonly VerifiedRecord[];
  readonly derive?: (ctx: RequestContext) => Promise<void>;
  // Hides and blocks set through drop reports, owners mapped (dm rebuild).
  readonly reportEffects?: readonly ReportEffect[];
  readonly ctx: RequestContext;
}): Promise<PersonalRebuildReport> {
  const refused: { what: string; detail: string }[] = [];
  const note = (what: string, outcome: IngestOutcome) => {
    if (outcome.kind === 'refused') {
      refused.push({ what, detail: `${outcome.reason}: ${outcome.detail}` });
    } else if (outcome.kind === 'applied' && outcome.unknown > 0) {
      refused.push({
        what,
        detail: `${outcome.unknown} items of unknown types`
      });
    }
  };
  if (args.derive) await args.derive(args.ctx);

  const { done, imported } = latestImport(args.imports);
  const importOrder = done ? importOrderKey(done.anchor, done.at) : null;

  const isKeys = (record: VerifiedRecord) =>
    record.parsed.kind === RecordKind.SEALED &&
    record.parsed.label === KEYS_LABEL;
  for (const record of args.records.filter(isKeys)) {
    note(
      `keys ${record.event.id}`,
      await args.indexer.ingest(record, 'rebuild', args.ctx)
    );
  }
  for (const body of imported) {
    // The block and hide history is the audit log's to rebuild
    // (personalModerationAuditRows); it changes no personal table.
    const changes = importChangesOf(body).filter(
      (change) => change.type !== PERSONAL_MODERATION_LOG_TYPE
    );
    if (!changes.length) continue;
    note(
      `import ${body.family} ${body.owner}`,
      // Live never puts the import through the indexer: no heads.
      await args.indexer.ingestImported(
        changes,
        body.family === 'pv',
        'rebuild',
        args.ctx,
        { heads: false }
      )
    );
  }
  const isAfterImport = (order: RecordOrderKey) =>
    !importOrder || compareOrderKeys(order, importOrder) > 0;
  const after = args.records
    .filter((record) => !isKeys(record))
    .filter((record) => isAfterImport(record.order));
  const steps: (
    | { order: RecordOrderKey; record: VerifiedRecord }
    | { order: RecordOrderKey; report: ReportEffect }
  )[] = [
    ...after.map((record) => ({ order: record.order, record })),
    ...(args.reportEffects ?? [])
      .filter((effect) => isAfterImport(effect.order))
      .map((report) => ({ order: report.order, report }))
  ].sort((a, b) => compareOrderKeys(a.order, b.order));
  for (const step of steps) {
    if ('record' in step) {
      note(
        `record ${step.record.event.id}`,
        await args.indexer.ingest(step.record, 'rebuild', args.ctx)
      );
    } else {
      note(
        `report ${step.report.dropId}`,
        await args.indexer.ingestImported(
          reportEffectChanges(step.report),
          true,
          'rebuild',
          args.ctx,
          { heads: false }
        )
      );
    }
  }
  return {
    importOrder,
    importEntries: imported.length,
    records: after.length,
    beforeImport:
      args.records.filter((record) => !isKeys(record)).length - after.length,
    refused
  };
}

/** Reads today's rows for the import, a page of owners at a time. */
export class PersonalExportDb extends LazyDbAccessCompatibleService {
  /**
   * Every profile id, in pages, ascending, along the profiles index. Each
   * page's rows are then read by owner, table by table. A row whose owner
   * has no profile has no stream owner either: the import would skip it.
   */
  async *ownerPages(): AsyncGenerator<string[]> {
    let after = '';
    for (;;) {
      const rows = await this.db.execute<{ id: string }>(
        `select external_id as id from ${PROFILES_TABLE}
         where external_id > :after order by external_id limit ${OWNERS_PER_PAGE}`,
        { after }
      );
      if (!rows.length) return;
      yield rows.map((row) => row.id);
      after = rows[rows.length - 1].id;
    }
  }

  /**
   * The personal rows whose owner id has no profile (an archived or merged
   * id), by table. The owner pages walk profiles, so the import never reads
   * these rows; it counts them, so a rebuild diff can explain them.
   */
  async countRowsWithoutProfile(): Promise<Record<string, number>> {
    const owners: readonly (readonly [string, string, string?])[] = [
      [IDENTITY_SUBSCRIPTIONS_TABLE, 'subscriber_id'],
      [WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE, 'identity_id'],
      [IDENTITY_MUTES_TABLE, 'muter_id'],
      [CONTENT_MODERATION_PROFILE_BLOCKS_TABLE, 'blocker_profile_id'],
      [CONTENT_MODERATION_HIDDEN_DROPS_TABLE, 'profile_id'],
      [DROP_BOOKMARKS_TABLE, 'identity_id'],
      [ARTIST_ARTWORK_ALERTS_TABLE, 'subscriber_id'],
      [PINNED_WAVES_TABLE, 'profile_id'],
      [PROFILE_PREFERENCES_TABLE, 'profile_id'],
      [MENTION_ALIASES_TABLE, 'owner_profile_id'],
      [PUSH_NOTIFICATION_SETTINGS_TABLE, 'profile_id'],
      [EULA_CONSENT_TABLE, 'profile_id', 'profile_id is not null'],
      [
        CONTENT_MODERATION_AUDIT_LOG_TABLE,
        'actor_profile_id',
        `action in (${Object.keys(PERSONAL_MODERATION_ACTIONS)
          .map((action) => `'${action}'`)
          .join(', ')})`
      ]
    ];
    const counts: Record<string, number> = {};
    for (const [table, column, where] of owners) {
      const [row] = await this.db.execute<{ n: number | string }>(
        `select count(*) as n from ${table} t
         where ${where ? `${where} and ` : ''}not exists (
           select 1 from ${PROFILES_TABLE} p where p.external_id = t.${column})`
      );
      const n = Number(row?.n ?? 0);
      if (n > 0) counts[table] = n;
    }
    return counts;
  }

  async readPage(ids: readonly string[]): Promise<PersonalExportPage> {
    const read = (sql: string) => this.db.execute<Row>(sql, { ids: [...ids] });
    return {
      follows: await read(
        `select s.subscriber_id, s.target_id, s.target_type, s.target_action,
                s.subscribed_to_all_drops,
                case when s.target_type = 'DROP' and d.author_id = s.subscriber_id then 1
                     when s.target_type = 'WAVE' and w.created_by = s.subscriber_id then 1
                     else 0 end as own_target,
                coalesce(w.is_direct_message, 0) as own_is_dm
         from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
         left join ${DROPS_TABLE} d on s.target_type = 'DROP' and d.id = s.target_id
         left join ${WAVES_TABLE} w on s.target_type = 'WAVE' and w.id = s.target_id
         where s.subscriber_id in (:ids)
         order by s.id`
      ),
      waveGroups: await read(
        `select identity_id, wave_id, mentioned_group
         from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE} where identity_id in (:ids)`
      ),
      ownWavesUnfollowed: await read(
        `select w.id, w.created_by from ${WAVES_TABLE} w
         where w.created_by in (:ids) and not exists (
           select 1 from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
           where s.subscriber_id = w.created_by and s.target_type = 'WAVE'
             and s.target_id = w.id and s.target_action = 'DROP_CREATED')`
      ),
      ownDropsUnfollowed: await read(
        `select d.id, d.author_id from ${DROPS_TABLE} d
         where d.author_id in (:ids) and not exists (
           select 1 from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
           where s.subscriber_id = d.author_id and s.target_type = 'DROP'
             and s.target_id = d.id and s.target_action = 'DROP_REPLIED')`
      ),
      mutes: await read(
        `select muter_id, muted_identity_id, created_at from ${IDENTITY_MUTES_TABLE}
         where muter_id in (:ids)`
      ),
      blocks: await read(
        `select blocker_profile_id, blocked_profile_id, created_at
         from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} where blocker_profile_id in (:ids)`
      ),
      hidden: await read(
        `select profile_id, drop_id, created_at from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
         where profile_id in (:ids)`
      ),
      bookmarks: await read(
        `select identity_id, drop_id, bookmarked_at from ${DROP_BOOKMARKS_TABLE}
         where identity_id in (:ids)`
      ),
      alerts: await read(
        `select subscriber_id, artist_id, enabled_at from ${ARTIST_ARTWORK_ALERTS_TABLE}
         where subscriber_id in (:ids)`
      ),
      pins: await read(
        `select profile_id, wave_id, position from ${PINNED_WAVES_TABLE}
         where profile_id in (:ids)`
      ),
      preferences: await read(
        `select * from ${PROFILE_PREFERENCES_TABLE} where profile_id in (:ids)`
      ),
      aliases: await read(
        `select id, owner_profile_id, alias from ${MENTION_ALIASES_TABLE}
         where owner_profile_id in (:ids)`
      ),
      aliasMembers: await read(
        `select m.alias_id, m.member_profile_id, m.position
         from ${MENTION_ALIAS_MEMBERS_TABLE} m
         join ${MENTION_ALIASES_TABLE} a on a.id = m.alias_id
         where a.owner_profile_id in (:ids)`
      ),
      push: await read(
        `select * from ${PUSH_NOTIFICATION_SETTINGS_TABLE} where profile_id in (:ids)`
      ),
      eula: await read(
        `select device_id, platform, accepted_at, eula_version, profile_id
         from ${EULA_CONSENT_TABLE} where profile_id in (:ids)`
      ),
      moderationLog: await read(
        `select id, actor_profile_id, action, target_profile_id, target_drop_id,
                previous_state, new_state, created_at
         from ${CONTENT_MODERATION_AUDIT_LOG_TABLE}
         where actor_profile_id in (:ids)
           and action in (${Object.keys(PERSONAL_MODERATION_ACTIONS)
             .map((action) => `'${action}'`)
             .join(', ')})
         order by created_at, id`
      )
    };
  }

  /**
   * What the waves index implies, written before the import in a rebuild:
   * each creator follows their wave (with the ALL group, and all drops for
   * a DM), and each author follows their drop. The import's unset items
   * remove the ones people had removed before the switch.
   */
  async deriveFromWavesIndex(ctx: RequestContext): Promise<void> {
    const options = ctx.connection
      ? { wrappedConnection: ctx.connection }
      : undefined;
    await this.db.execute(
      `insert ignore into ${IDENTITY_SUBSCRIPTIONS_TABLE}
         (subscriber_id, target_id, target_type, target_action, wave_id, subscribed_to_all_drops)
       select w.created_by, w.id, 'WAVE', 'DROP_CREATED', w.id, coalesce(w.is_direct_message, false)
       from ${WAVES_TABLE} w`,
      undefined,
      options
    );
    await this.db.execute(
      `insert ignore into ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}
         (identity_id, wave_id, mentioned_group)
       select w.created_by, w.id, 'ALL' from ${WAVES_TABLE} w`,
      undefined,
      options
    );
    await this.db.execute(
      `insert ignore into ${IDENTITY_SUBSCRIPTIONS_TABLE}
         (subscriber_id, target_id, target_type, target_action, wave_id, subscribed_to_all_drops)
       select d.author_id, d.id, 'DROP', 'DROP_REPLIED', d.wave_id, false
       from ${DROPS_TABLE} d`,
      undefined,
      options
    );
  }
}

export const personalExportDb = new PersonalExportDb(dbSupplier);

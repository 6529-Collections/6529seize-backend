import { createHash } from 'node:crypto';
import {
  MAX_MEMBERS_PER_MENTION_ALIAS,
  MAX_MENTION_ALIASES_PER_PROFILE,
  MENTION_ALIAS_MAX_LENGTH,
  MENTION_ALIAS_MIN_LENGTH,
  isReservedMentionAlias,
  normalizeMentionAlias
} from '@/mention-aliases/mention-aliases.constants';
import { CURRENT_EULA_VERSION } from '@/api/policies/eula-policy';
import { RequestContext } from '@/request.context';
import {
  isPrincipalId,
  isWalletAddress
} from '@/signed-records/record-families';
import {
  ApplyMode,
  RecordChange,
  RecordRegistry,
  RecordRuleError,
  RecordTypeHandler
} from '@/signed-records/record-index';
import { byCodeUnit } from '@/signed-records/record-order';
import type {
  FollowAction,
  FollowTargetType,
  PersonalLiveEffects,
  PersonalTables,
  PreferencesUpdate,
  PushSettings,
  WaveMentionGroup
} from './personal-records.ports';
import { ownersUnavailable } from './personal-records.ports';
import type { RecordOwnerDirectory } from './record-owner-directory';

/**
 * The personal settings as records (DESIGN.md 1.2). `follow` is a public
 * RECORD in `ps`; every other type is an item of a PROVIDER-class SEALED
 * record in `pv`. Owners and profile targets are principal ids, or bare
 * wallets bound to no principal. Bodies are checked here; today's rules
 * that need state are checked live only (RecordRuleError).
 */
export const PersonalRecordType = {
  FOLLOW: 'follow',
  MUTE: 'mute',
  BLOCK: 'block',
  HIDE: 'hide',
  BOOKMARK: 'bookmark',
  ART_ALERT: 'art-alert',
  PIN: 'pin',
  WAVE_NOTIFY: 'wave-notify',
  PREF: 'pref',
  ALIAS: 'alias',
  PUSH: 'push',
  EULA: 'eula'
} as const;

/**
 * Not a setting: a person's own block and hide history (today's audit rows
 * PROFILE_BLOCKED, PROFILE_UNBLOCKED, DROP_HIDDEN, DROP_UNHIDDEN), carried
 * by the import only. Key: the audit row id. A rebuild hands these to the
 * audit log's rebuild (personalModerationAuditRows) and changes no table.
 */
export const PERSONAL_MODERATION_LOG_TYPE = 'moderation-log';

export const PERSONAL_MODERATION_ACTIONS = {
  PROFILE_BLOCKED: { previous: ['UNBLOCKED'], next: 'BLOCKED' },
  PROFILE_UNBLOCKED: { previous: ['BLOCKED'], next: 'UNBLOCKED' },
  DROP_HIDDEN: { previous: ['HIDDEN', 'SHOWN'], next: 'HIDDEN' },
  DROP_UNHIDDEN: { previous: ['HIDDEN', 'SHOWN'], next: 'SHOWN' }
} as const;

export type PersonalModerationAction = keyof typeof PERSONAL_MODERATION_ACTIONS;

export interface PersonalModerationLogBody {
  readonly action: PersonalModerationAction;
  // A profile action's target owner, or a drop action's drop id.
  readonly target: string;
  readonly previous: string;
  readonly next: string;
  readonly at: number;
}

export interface PersonalHandlerDeps {
  readonly owners: RecordOwnerDirectory;
  readonly tables: PersonalTables;
  readonly live: PersonalLiveEffects;
}

const ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const PIN_POSITION_MAX = 1_000_000;
// Today's limits: device ids 100, a DM group id 200 (its column),
// an EULA platform and version 32.
const TEXT_MAX = 100;
const GROUP_ID_MAX = 200;
const EULA_FIELD_MAX = 32;

const FOLLOW_ACTIONS: Readonly<
  Record<FollowTargetType, readonly FollowAction[]>
> = {
  IDENTITY: ['WAVE_CREATED', 'DROP_CREATED', 'DROP_REPLIED'],
  WAVE: ['DROP_CREATED'],
  DROP: ['DROP_REPLIED']
};

const WAVE_GROUPS: readonly WaveMentionGroup[] = [
  'ALL',
  'CONTRIBUTORS',
  'ADMINS',
  'DEVS_6529'
];

const DM_POLICIES = ['EVERYONE', 'PEOPLE_I_FOLLOW', 'NOBODY', 'GROUP_MEMBERS'];
const NOTIFICATION_LEVELS = ['ALL', 'ESSENTIAL_ONLY'];
const NOTIFY_CATEGORIES = [
  'direct_messages',
  'mentions_replies_quotes',
  'reactions_votes_boosts',
  'new_followers',
  'rep_and_nic',
  'subscription_coverage'
];
const PUSH_FIELDS: readonly (keyof PushSettings)[] = [
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

class InvalidChange extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, InvalidChange.prototype);
  }
}

function invalid(message: string): never {
  throw new InvalidChange(message);
}

function rule(message: string, code: string): never {
  throw new RecordRuleError(message, code);
}

/** The body's members are exactly `keys` (every one present). */
function expectFields(
  body: Record<string, unknown>,
  keys: readonly string[],
  what: string
): void {
  const present = Object.keys(body).sort(byCodeUnit);
  const wanted = [...keys].sort(byCodeUnit);
  if (
    present.length !== wanted.length ||
    present.some((key, i) => key !== wanted[i])
  ) {
    invalid(`${what} has the fields ${wanted.join(', ') || 'none'}`);
  }
}

/**
 * Imported state (no event: the one-time import at the switch) may carry
 * the original row's time as `at`, so a rebuild writes the same times;
 * a signed record's time is its claimed time.
 */
function importedAt(change: RecordChange): readonly string[] {
  if (
    change.eventId !== null ||
    change.body === null ||
    !('at' in change.body)
  ) {
    return [];
  }
  const at = change.body.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    invalid('An imported time is a whole number of milliseconds');
  }
  return ['at'];
}

function timeOf(change: RecordChange): number {
  return change.eventId === null && typeof change.body?.at === 'number'
    ? change.body.at
    : change.order.claimedTime;
}

function expectFlag(change: RecordChange, what: string): void {
  if (change.body !== null) {
    expectFields(change.body, importedAt(change), what);
  }
}

function expectId(value: string, what: string): void {
  if (!ID_PATTERN.test(value)) {
    invalid(`${what} is not an id`);
  }
}

function expectOwnerKey(value: string, what: string): void {
  if (!isPrincipalId(value) && !isWalletAddress(value)) {
    invalid(`${what} is a principal id or a lowercase wallet`);
  }
}

function isText(value: unknown, max = TEXT_MAX): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value
  );
}

async function ownerProfileId(
  change: RecordChange,
  deps: PersonalHandlerDeps,
  mode: ApplyMode
): Promise<string | null> {
  const profileId = await deps.owners.profileIdOf(change.owner);
  if (!profileId && mode === 'live') {
    rule(
      'Create a 6529.io profile before saving settings.',
      'PROFILE_REQUIRED'
    );
  }
  return profileId;
}

/**
 * The profile a target owner names. Live, a wallet bound to a principal
 * must be named by the principal, so one person has one key.
 */
async function targetProfileId(
  target: string,
  change: RecordChange,
  deps: PersonalHandlerDeps,
  mode: ApplyMode
): Promise<string | null> {
  if (mode === 'live' && isWalletAddress(target)) {
    let principal: string | null;
    try {
      principal = await deps.owners.principalAt(target, change.order.anchor);
    } catch {
      throw ownersUnavailable();
    }
    if (principal) {
      rule('Name this profile by its principal id.', 'TARGET_NOT_CANONICAL');
    }
  }
  const profileId = await deps.owners.profileIdOf(target);
  if (!profileId && mode === 'live') {
    rule('That profile does not exist.', 'TARGET_NOT_FOUND');
  }
  return profileId;
}

/** Live: the profile can read the drop. Rebuild: the drop exists. */
async function dropAvailable(
  profileId: string,
  dropId: string,
  deps: PersonalHandlerDeps,
  mode: ApplyMode,
  ctx: RequestContext
): Promise<boolean> {
  if (mode === 'live') {
    if (!(await deps.live.canSeeDrop(profileId, dropId, ctx))) {
      rule('That drop does not exist.', 'DROP_NOT_FOUND');
    }
    return true;
  }
  return (await deps.tables.waveOfDrop(dropId, ctx)) !== null;
}

/** Live: the profile can see the wave. Rebuild: the wave exists. */
async function waveAvailable(
  profileId: string,
  waveId: string,
  deps: PersonalHandlerDeps,
  mode: ApplyMode,
  ctx: RequestContext
): Promise<boolean> {
  if (mode === 'live') {
    if (!(await deps.live.canSeeWave(profileId, waveId, ctx))) {
      rule('That wave does not exist.', 'WAVE_NOT_FOUND');
    }
    return true;
  }
  return deps.tables.waveExists(waveId, ctx);
}

// follow: ps RECORD, key identity:<owner> | wave:<id> | drop:<id>,
// body {actions: [...]}, no body unfollows.

/**
 * Only follows of people are public (a ps RECORD, as follower lists are
 * public today). Follows of waves and drops are sealed items in pv: a wave
 * can be private or a DM, and a drop follow tells what someone wrote.
 */
function parseFollowKey(
  key: string,
  family: 'ps' | 'pv'
): {
  type: FollowTargetType;
  id: string;
} {
  const colon = key.indexOf(':');
  const prefix = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (family === 'ps') {
    if (prefix !== 'identity') {
      invalid('A public follow key is identity: and an owner');
    }
    expectOwnerKey(id, 'A followed identity');
    return { type: 'IDENTITY', id };
  }
  if (prefix === 'wave' || prefix === 'drop') {
    expectId(id, `A followed ${prefix}`);
    return { type: prefix === 'wave' ? 'WAVE' : 'DROP', id };
  }
  return invalid('A sealed follow key is wave: or drop: and an id');
}

function followActionsOf(change: RecordChange): FollowAction[] {
  const target = parseFollowKey(change.key, change.family as 'ps' | 'pv');
  if (change.body === null) {
    return [];
  }
  expectFields(change.body, ['actions'], 'A follow');
  const actions = change.body.actions;
  const allowed = FOLLOW_ACTIONS[target.type];
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    new Set(actions).size !== actions.length ||
    actions.some((action) => !allowed.includes(action as FollowAction))
  ) {
    invalid(`A follow's actions are one or more of ${allowed.join(', ')}`);
  }
  return actions as FollowAction[];
}

function followHandler(
  deps: PersonalHandlerDeps,
  family: 'ps' | 'pv'
): RecordTypeHandler {
  return {
    family,
    type: PersonalRecordType.FOLLOW,
    sealed: family === 'pv',
    validate: (change) => {
      followActionsOf(change);
    },
    apply: async (change, mode, ctx) => {
      const subscriberId = await ownerProfileId(change, deps, mode);
      if (!subscriberId) return;
      const target = parseFollowKey(change.key, family);
      const desired = followActionsOf(change);
      let targetId = target.id;
      let waveId: string | null = null;
      if (target.type === 'IDENTITY') {
        const profileId = await targetProfileId(target.id, change, deps, mode);
        if (!profileId) return;
        targetId = profileId;
      } else if (target.type === 'WAVE') {
        if (
          desired.length &&
          !(await waveAvailable(subscriberId, target.id, deps, mode, ctx))
        ) {
          return;
        }
        waveId = target.id;
      } else {
        waveId = await deps.tables.waveOfDrop(target.id, ctx);
        if (
          desired.length &&
          (!waveId ||
            !(await dropAvailable(subscriberId, target.id, deps, mode, ctx)))
        ) {
          return;
        }
      }
      const current = await deps.tables.followActions(
        subscriberId,
        target.type,
        targetId,
        ctx
      );
      const toAdd = desired.filter((action) => !current.includes(action));
      const toRemove = current.filter((action) => !desired.includes(action));
      if (target.type === 'IDENTITY' && toAdd.length && mode === 'live') {
        if (await deps.tables.isBlocked(subscriberId, targetId, ctx)) {
          rule("You can't follow a profile you have blocked.", 'BLOCKED');
        }
        if (!current.length) {
          await deps.live.notifyNewFollower(subscriberId, targetId, ctx);
        }
      }
      for (const action of toAdd) {
        await deps.tables.addFollow(
          {
            subscriberId,
            targetType: target.type,
            targetId,
            action,
            waveId
          },
          ctx,
          mode === 'live'
        );
        if (target.type === 'WAVE' && action === 'DROP_CREATED') {
          await deps.tables.addWaveDefaultGroups(subscriberId, targetId, ctx);
        }
      }
      for (const action of toRemove) {
        await deps.tables.removeFollow(
          { subscriberId, targetType: target.type, targetId, action },
          ctx,
          mode === 'live'
        );
        if (target.type === 'WAVE' && action === 'DROP_CREATED') {
          await deps.tables.deleteWaveGroups(subscriberId, targetId, ctx);
        }
      }
      if (mode === 'live' && target.type !== 'IDENTITY') {
        await deps.live.recordActiveIdentity(subscriberId, ctx);
        if (target.type === 'WAVE') {
          if (toAdd.length || toRemove.length) {
            await deps.live.waveFollowChanged(targetId, ctx);
          }
          if (toAdd.includes('DROP_CREATED')) {
            await deps.live.wavesChanged(
              subscriberId,
              targetId,
              'FOLLOWED',
              ctx
            );
          } else if (toRemove.includes('DROP_CREATED')) {
            await deps.live.wavesChanged(
              subscriberId,
              targetId,
              'UNFOLLOWED',
              ctx
            );
          }
        }
      }
    }
  };
}

// Flags on another profile: mute, block, art-alert. Key: the target owner.

function profileFlagHandler(
  deps: PersonalHandlerDeps,
  type: string,
  write: (
    ownerId: string,
    targetId: string,
    on: boolean,
    change: RecordChange,
    mode: ApplyMode,
    ctx: RequestContext
  ) => Promise<void>,
  selfMessage: string
): RecordTypeHandler {
  return {
    family: 'pv',
    type,
    sealed: true,
    validate: (change) => {
      expectOwnerKey(change.key, `A ${type} key`);
      expectFlag(change, `A ${type}`);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const targetId = await targetProfileId(change.key, change, deps, mode);
      if (!targetId) return;
      if (ownerId === targetId) {
        if (mode === 'live') rule(selfMessage, 'SELF');
        return;
      }
      await write(ownerId, targetId, change.body !== null, change, mode, ctx);
    }
  };
}

// Flags on a drop: hide, bookmark. Key: the drop id.

function dropFlagHandler(
  deps: PersonalHandlerDeps,
  type: string,
  write: (
    ownerId: string,
    dropId: string,
    on: boolean,
    at: number,
    ctx: RequestContext,
    mode: ApplyMode
  ) => Promise<void>
): RecordTypeHandler {
  return {
    family: 'pv',
    type,
    sealed: true,
    validate: (change) => {
      expectId(change.key, `A ${type} key`);
      expectFlag(change, `A ${type}`);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const on = change.body !== null;
      if (on && !(await dropAvailable(ownerId, change.key, deps, mode, ctx))) {
        return;
      }
      await write(ownerId, change.key, on, timeOf(change), ctx, mode);
    }
  };
}

// pin: key wave id, body {pos}: the pin's position (pinned_waves.position).

function pinHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  const positionOf = (change: RecordChange): number | null => {
    expectId(change.key, 'A pinned wave');
    if (change.body === null) return null;
    expectFields(change.body, ['pos'], 'A pin');
    const pos = change.body.pos;
    if (
      typeof pos !== 'number' ||
      !Number.isSafeInteger(pos) ||
      pos < 0 ||
      pos > PIN_POSITION_MAX
    ) {
      invalid(`A pin's pos is a whole number from 0 to ${PIN_POSITION_MAX}`);
    }
    return pos;
  };
  return {
    family: 'pv',
    type: PersonalRecordType.PIN,
    sealed: true,
    validate: (change) => {
      positionOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const position = positionOf(change);
      if (
        position !== null &&
        !(await waveAvailable(ownerId, change.key, deps, mode, ctx))
      ) {
        return;
      }
      await deps.tables.setPin(ownerId, change.key, position, ctx);
      if (mode === 'live') {
        await deps.live.recordActiveIdentity(ownerId, ctx);
      }
    }
  };
}

// wave-notify: key wave id, body {all_drops, groups}. Takes effect, as
// today, only while the profile follows the wave.

function waveNotifyOf(change: RecordChange): {
  allDrops: boolean;
  groups: WaveMentionGroup[];
} {
  expectId(change.key, 'A wave-notify key');
  if (change.body === null) {
    return { allDrops: false, groups: [] };
  }
  expectFields(change.body, ['all_drops', 'groups'], 'A wave-notify');
  const { all_drops: allDrops, groups } = change.body;
  if (
    typeof allDrops !== 'boolean' ||
    !Array.isArray(groups) ||
    new Set(groups).size !== groups.length ||
    groups.some((group) => !WAVE_GROUPS.includes(group as WaveMentionGroup))
  ) {
    invalid(
      `A wave-notify is {all_drops: boolean, groups: [${WAVE_GROUPS.join(', ')}]}`
    );
  }
  return {
    allDrops,
    groups: [...(groups as WaveMentionGroup[])].sort(byCodeUnit)
  };
}

function waveNotifyHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  return {
    family: 'pv',
    type: PersonalRecordType.WAVE_NOTIFY,
    sealed: true,
    validate: (change) => {
      waveNotifyOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const wanted = waveNotifyOf(change);
      const state = await deps.tables.waveFollowState(ownerId, change.key, ctx);
      if (wanted.allDrops && state.isFollowing && !state.allDrops) {
        await deps.tables.setWaveAllDrops(ownerId, change.key, true, ctx);
      } else if (!wanted.allDrops && state.allDrops) {
        await deps.tables.setWaveAllDrops(ownerId, change.key, false, ctx);
      }
      if (state.isFollowing) {
        await deps.tables.replaceWaveGroups(
          ownerId,
          change.key,
          wanted.groups,
          ctx
        );
      }
    }
  };
}

// pref: keys `dm` {policy, group_id, allow_people_i_follow}, `level`
// {value}, `notify.<category>` {on}. No body sets the key's defaults.

function preferenceUpdateOf(change: RecordChange): PreferencesUpdate {
  const body = change.body;
  if (change.key === 'dm') {
    if (body === null) {
      return {
        direct_message_policy: 'EVERYONE',
        direct_message_group_id: null,
        direct_message_allow_people_i_follow: true
      };
    }
    expectFields(
      body,
      ['allow_people_i_follow', 'group_id', 'policy'],
      'A dm preference'
    );
    const { policy, group_id: groupId } = body;
    const allow = body.allow_people_i_follow;
    if (
      typeof policy !== 'string' ||
      !DM_POLICIES.includes(policy) ||
      typeof allow !== 'boolean' ||
      !(
        groupId === null ||
        (typeof groupId === 'string' && isText(groupId, GROUP_ID_MAX))
      )
    ) {
      invalid(
        `A dm preference is {policy: ${DM_POLICIES.join('|')}, group_id, allow_people_i_follow}`
      );
    }
    if (policy === 'GROUP_MEMBERS' && groupId === null) {
      invalid('GROUP_MEMBERS needs a group_id');
    }
    return {
      direct_message_policy: policy,
      direct_message_group_id: groupId as string | null,
      direct_message_allow_people_i_follow: allow
    };
  }
  if (change.key === 'level') {
    if (body === null) return { notification_level: 'ALL' };
    expectFields(body, ['value'], 'A level preference');
    if (
      typeof body.value !== 'string' ||
      !NOTIFICATION_LEVELS.includes(body.value)
    ) {
      invalid(`A level is ${NOTIFICATION_LEVELS.join(' or ')}`);
    }
    return { notification_level: body.value };
  }
  const category = change.key.startsWith('notify.')
    ? change.key.slice('notify.'.length)
    : '';
  if (!NOTIFY_CATEGORIES.includes(category)) {
    invalid('A pref key is dm, level or notify.<category>');
  }
  if (body === null) return { notifications: { [category]: true } };
  expectFields(body, ['on'], 'A notify preference');
  if (typeof body.on !== 'boolean') {
    invalid('A notify preference is {on: boolean}');
  }
  return { notifications: { [category]: body.on } };
}

function preferenceHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  return {
    family: 'pv',
    type: PersonalRecordType.PREF,
    sealed: true,
    validate: (change) => {
      preferenceUpdateOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const update = preferenceUpdateOf(change);
      const groupId = update.direct_message_group_id;
      if (
        mode === 'live' &&
        groupId &&
        !(await deps.live.isSelectableGroup(groupId, ctx))
      ) {
        rule(
          'Choose a group you can see to limit who can message you.',
          'GROUP_NOT_SELECTABLE'
        );
      }
      await deps.tables.updatePreferences(ownerId, update, ctx);
    }
  };
}

// alias: key the alias as typed after @ (lowercase), body {members}: the
// owners it mentions. The row id is derived, so a rebuild keeps it.

export function mentionAliasId(ownerId: string, alias: string): string {
  const hex = createHash('sha256')
    .update(`6529.MentionAlias.v1|${ownerId}|${alias}`)
    .digest('hex');
  // UUID-shaped, version nibble 8 (custom).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(
    (Number.parseInt(hex[16], 16) & 0x3) |
    0x8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isAliasName(alias: unknown): alias is string {
  return (
    typeof alias === 'string' &&
    normalizeMentionAlias(alias) === alias &&
    alias.length >= MENTION_ALIAS_MIN_LENGTH &&
    alias.length <= MENTION_ALIAS_MAX_LENGTH &&
    /^\w+$/.test(alias) &&
    !isReservedMentionAlias(alias)
  );
}

/**
 * An alias body: `members`, and optionally `new: true` (a create: refused
 * live when the name is taken, as today) or `from` (a rename: the alias
 * of that name takes this name and keeps its id). The record that renames
 * also unsets the old name, after this item.
 */
function aliasMembersOf(change: RecordChange): string[] | null {
  if (!isAliasName(change.key)) {
    invalid(
      `An alias is ${MENTION_ALIAS_MIN_LENGTH}-${MENTION_ALIAS_MAX_LENGTH} lowercase letters, numbers or underscores, not reserved`
    );
  }
  if (change.body === null) return null;
  const importedId =
    change.eventId === null && 'id' in change.body ? ['id'] : [];
  const optional = ['new', 'from'].filter((it) => it in (change.body ?? {}));
  expectFields(
    change.body,
    ['members', ...importedId, ...optional],
    'An alias'
  );
  if ('new' in change.body && change.body.new !== true) {
    invalid("An alias's new is true");
  }
  if (
    'from' in change.body &&
    (!isAliasName(change.body.from) || change.body.from === change.key)
  ) {
    invalid("An alias's from is another alias");
  }
  if (
    importedId.length &&
    !(
      typeof change.body.id === 'string' &&
      /^[0-9a-f-]{36}$/.test(change.body.id)
    )
  ) {
    invalid("An imported alias's id is a UUID");
  }
  const members = change.body.members;
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    members.length > MAX_MEMBERS_PER_MENTION_ALIAS ||
    new Set(members).size !== members.length ||
    members.some(
      (member) =>
        typeof member !== 'string' ||
        !(isPrincipalId(member) || isWalletAddress(member))
    )
  ) {
    invalid(
      `An alias has 1 to ${MAX_MEMBERS_PER_MENTION_ALIAS} distinct members, each a principal id or wallet`
    );
  }
  return members as string[];
}

function aliasHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  return {
    family: 'pv',
    type: PersonalRecordType.ALIAS,
    sealed: true,
    validate: (change) => {
      aliasMembersOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const members = aliasMembersOf(change);
      let existing = await deps.tables.findAlias(ownerId, change.key, ctx);
      if (members === null) {
        if (existing) await deps.tables.deleteAlias(existing.id, ctx);
        return;
      }
      if (mode === 'live' && existing && change.body?.new === true) {
        rule(
          `You already have a @${change.key} mention shortcut.`,
          'ALIAS_EXISTS'
        );
      }
      const from = change.body?.from;
      if (typeof from === 'string') {
        const renamed = await deps.tables.findAlias(ownerId, from, ctx);
        if (renamed && existing && mode === 'live') {
          // The new name belongs to another alias: today's PUT refuses.
          rule(
            `You already have a @${change.key} mention shortcut.`,
            'ALIAS_EXISTS'
          );
        }
        // Without the old alias (already renamed, as in shadow after
        // today's request), the item updates the alias of the new name.
        if (renamed && !existing) {
          await deps.tables.renameAlias(renamed.id, change.key, ctx);
          existing = renamed;
        }
      }
      const memberIds: string[] = [];
      for (const member of members) {
        const memberId = await targetProfileId(member, change, deps, mode);
        if (memberId && memberId !== ownerId && !memberIds.includes(memberId)) {
          memberIds.push(memberId);
        } else if (memberId === ownerId && mode === 'live') {
          rule("You can't add yourself to a Quick Tag.", 'SELF');
        }
      }
      const mentionable = await deps.tables.mentionableProfileIds(
        memberIds,
        ctx
      );
      if (mode === 'live') {
        if (mentionable.length !== memberIds.length) {
          rule(
            'One or more mention shortcut profiles no longer exist or do not have a handle.',
            'TARGET_NOT_FOUND'
          );
        }
        if (
          !existing &&
          (await deps.tables.countAliases(ownerId, ctx)) >=
            MAX_MENTION_ALIASES_PER_PROFILE
        ) {
          rule(
            `You can create up to ${MAX_MENTION_ALIASES_PER_PROFILE} mention shortcuts.`,
            'ALIAS_LIMIT'
          );
        }
      }
      // Live, every member must be mentionable (checked above). A rebuild
      // keeps the members as they were stored, as today's table does even
      // after a member loses their handle.
      const kept =
        mode === 'live'
          ? memberIds.filter((id) => mentionable.includes(id))
          : memberIds;
      if (!kept.length) {
        if (existing) await deps.tables.deleteAlias(existing.id, ctx);
        return;
      }
      await deps.tables.putAlias(
        {
          id:
            existing?.id ??
            (change.eventId === null && typeof change.body?.id === 'string'
              ? change.body.id
              : mentionAliasId(ownerId, change.key)),
          ownerId,
          alias: change.key,
          memberIds: kept,
          exists: existing !== null
        },
        ctx
      );
    }
  };
}

// push: key a push device id, body every setting. No body: the defaults.

function pushSettingsOf(change: RecordChange): PushSettings | null {
  if (!isText(change.key)) invalid('A push key is a device id');
  if (change.body === null) return null;
  expectFields(change.body, PUSH_FIELDS, 'Push settings');
  if (PUSH_FIELDS.some((field) => typeof change.body?.[field] !== 'boolean')) {
    invalid('Push settings are booleans');
  }
  return change.body as unknown as PushSettings;
}

function pushHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  return {
    family: 'pv',
    type: PersonalRecordType.PUSH,
    sealed: true,
    validate: (change) => {
      pushSettingsOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      await deps.tables.setPushSettings(
        ownerId,
        change.key,
        pushSettingsOf(change),
        ctx
      );
    }
  };
}

// eula: key a device id, body {version, platform}. No body withdraws it.

function eulaOf(
  change: RecordChange
): { version: string; platform: string } | null {
  if (!isText(change.key)) invalid('An eula key is a device id');
  if (change.body === null) return null;
  expectFields(
    change.body,
    ['platform', 'version', ...importedAt(change)],
    'An eula consent'
  );
  const { platform, version } = change.body;
  if (!isText(platform, EULA_FIELD_MAX) || !isText(version, EULA_FIELD_MAX)) {
    invalid('An eula consent is {version, platform}');
  }
  return { version, platform };
}

function eulaHandler(deps: PersonalHandlerDeps): RecordTypeHandler {
  return {
    family: 'pv',
    type: PersonalRecordType.EULA,
    sealed: true,
    validate: (change) => {
      eulaOf(change);
    },
    apply: async (change, mode, ctx) => {
      const ownerId = await ownerProfileId(change, deps, mode);
      if (!ownerId) return;
      const consent = eulaOf(change);
      if (
        mode === 'live' &&
        consent &&
        consent.version !== CURRENT_EULA_VERSION
      ) {
        rule(
          `Accept the current terms (${CURRENT_EULA_VERSION}).`,
          'EULA_VERSION'
        );
      }
      await deps.tables.setEulaConsent(
        ownerId,
        change.key,
        consent,
        timeOf(change),
        ctx
      );
    }
  };
}

export function moderationLogOf(
  change: RecordChange
): PersonalModerationLogBody {
  if (change.eventId !== null) {
    invalid('Moderation history comes only from the import');
  }
  if (!/^[1-9]\d{0,19}$/.test(change.key)) {
    invalid('A moderation-log key is an audit row id');
  }
  const body = change.body;
  if (body === null) invalid('A moderation-log item has a body');
  expectFields(
    body,
    ['action', 'target', 'previous', 'next', 'at'],
    'A moderation-log item'
  );
  const transition = Object.prototype.hasOwnProperty.call(
    PERSONAL_MODERATION_ACTIONS,
    String(body.action)
  )
    ? PERSONAL_MODERATION_ACTIONS[body.action as PersonalModerationAction]
    : null;
  if (
    !transition ||
    !(transition.previous as readonly unknown[]).includes(body.previous) ||
    body.next !== transition.next
  ) {
    invalid('A moderation-log item is a block or hide transition');
  }
  if (typeof body.target !== 'string') {
    invalid('A moderation-log target is a string');
  }
  if (String(body.action).startsWith('PROFILE_')) {
    expectOwnerKey(body.target, 'A moderation-log target');
  } else {
    expectId(body.target, 'A moderation-log target');
  }
  if (
    typeof body.at !== 'number' ||
    !Number.isSafeInteger(body.at) ||
    body.at < 0
  ) {
    invalid('A moderation-log time is a whole number of milliseconds');
  }
  return body as unknown as PersonalModerationLogBody;
}

function moderationLogHandler(): RecordTypeHandler {
  return {
    family: 'pv',
    type: PERSONAL_MODERATION_LOG_TYPE,
    sealed: true,
    validate: (change) => {
      moderationLogOf(change);
    },
    // The history changes no personal table.
    apply: async () => undefined
  };
}

/** Every personal type, as the indexer's handlers. */
export function personalRecordHandlers(
  deps: PersonalHandlerDeps
): RecordTypeHandler[] {
  const { tables } = deps;
  return [
    followHandler(deps, 'ps'),
    followHandler(deps, 'pv'),
    profileFlagHandler(
      deps,
      PersonalRecordType.MUTE,
      async (ownerId, targetId, on, change, mode, ctx) => {
        await tables.setMuted(ownerId, targetId, on, timeOf(change), ctx);
        if (mode === 'live') {
          await deps.live.muteChanged(ownerId, targetId, ctx);
        }
      },
      "You can't mute yourself."
    ),
    profileFlagHandler(
      deps,
      PersonalRecordType.BLOCK,
      (ownerId, targetId, on, change, mode, ctx) =>
        tables.setBlocked(
          ownerId,
          targetId,
          on,
          timeOf(change),
          ctx,
          mode === 'live'
        ),
      "You can't block your own profile."
    ),
    profileFlagHandler(
      deps,
      PersonalRecordType.ART_ALERT,
      async (ownerId, targetId, on, change, mode, ctx) => {
        if (
          on &&
          mode === 'live' &&
          (await tables.isBlocked(ownerId, targetId, ctx))
        ) {
          rule(
            "You can't get artwork alerts from a profile you have blocked.",
            'BLOCKED'
          );
        }
        await tables.setArtworkAlert(
          ownerId,
          targetId,
          on,
          timeOf(change),
          ctx
        );
      },
      "You can't get artwork alerts for yourself."
    ),
    dropFlagHandler(
      deps,
      PersonalRecordType.HIDE,
      (owner, drop, on, at, ctx, mode) =>
        tables.setHidden(owner, drop, on, at, ctx, mode === 'live')
    ),
    dropFlagHandler(
      deps,
      PersonalRecordType.BOOKMARK,
      (owner, drop, on, at, ctx) =>
        tables.setBookmarked(owner, drop, on, at, ctx)
    ),
    pinHandler(deps),
    waveNotifyHandler(deps),
    preferenceHandler(deps),
    aliasHandler(deps),
    pushHandler(deps),
    eulaHandler(deps),
    moderationLogHandler()
  ];
}

/** Registers every personal type. */
export function registerPersonalRecordTypes(
  registry: RecordRegistry,
  deps: PersonalHandlerDeps
): RecordRegistry {
  for (const handler of personalRecordHandlers(deps)) {
    registry.register(handler);
  }
  return registry;
}

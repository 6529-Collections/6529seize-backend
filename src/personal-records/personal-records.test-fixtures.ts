import type { RequestContext } from '@/request.context';
import type {
  FollowAction,
  FollowTargetType,
  PersonalLiveEffects,
  PersonalTables,
  PreferencesUpdate,
  PushSettings,
  WaveMentionGroup
} from './personal-records.ports';
import type { RecordOwnerDirectory } from './record-owner-directory';

/** Sorts strings by code unit: the same everywhere, unlike a locale. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : Number(a > b);

const DEFAULT_PREFERENCES = {
  direct_message_policy: 'EVERYONE',
  direct_message_group_id: null as string | null,
  direct_message_allow_people_i_follow: true,
  notification_level: 'ALL',
  notifications: {
    direct_messages: true,
    mentions_replies_quotes: true,
    reactions_votes_boosts: true,
    new_followers: true,
    rep_and_nic: true,
    subscription_coverage: true
  } as Record<string, boolean>
};

/**
 * The personal tables in memory, with the same rules as the db classes
 * (a block removes the identity follow rows, a wave follow's default
 * groups), so tests and the rebuild comparison see the same answers.
 */
export class MemoryPersonalTables implements PersonalTables {
  readonly follows = new Map<
    string,
    { actions: Set<FollowAction>; waveId: string | null }
  >();
  readonly allDrops = new Set<string>();
  readonly waveGroups = new Map<string, WaveMentionGroup[]>();
  readonly mutes = new Map<string, number>();
  readonly blocks = new Map<string, number>();
  readonly hidden = new Map<string, number>();
  readonly bookmarks = new Map<string, number>();
  readonly alerts = new Map<string, number>();
  readonly pins = new Map<string, number>();
  readonly preferences = new Map<string, typeof DEFAULT_PREFERENCES>();
  readonly aliases = new Map<
    string,
    { ownerId: string; alias: string; memberIds: string[] }
  >();
  readonly push = new Map<string, PushSettings>();
  readonly eula = new Map<
    string,
    { profileId: string; version: string; platform: string; at: number }
  >();
  // Fixtures: drops by wave, waves, people with a handle.
  readonly dropWaves = new Map<string, string>();
  readonly waves = new Set<string>();
  readonly mentionable = new Set<string>();

  private static followKey(sub: string, type: string, target: string) {
    return `${sub}|${type}|${target}`;
  }

  async followActions(
    subscriberId: string,
    targetType: FollowTargetType,
    targetId: string
  ): Promise<FollowAction[]> {
    const row = this.follows.get(
      MemoryPersonalTables.followKey(subscriberId, targetType, targetId)
    );
    return row ? Array.from(row.actions).sort(byCodeUnit) : [];
  }

  async addFollow(row: {
    subscriberId: string;
    targetType: FollowTargetType;
    targetId: string;
    action: FollowAction;
    waveId: string | null;
  }): Promise<void> {
    const key = MemoryPersonalTables.followKey(
      row.subscriberId,
      row.targetType,
      row.targetId
    );
    const existing = this.follows.get(key) ?? {
      actions: new Set<FollowAction>(),
      waveId: row.waveId
    };
    if (existing.actions.has(row.action)) {
      throw new Error('duplicate follow row');
    }
    existing.actions.add(row.action);
    this.follows.set(key, existing);
  }

  async removeFollow(row: {
    subscriberId: string;
    targetType: FollowTargetType;
    targetId: string;
    action: FollowAction;
  }): Promise<void> {
    const key = MemoryPersonalTables.followKey(
      row.subscriberId,
      row.targetType,
      row.targetId
    );
    const existing = this.follows.get(key);
    existing?.actions.delete(row.action);
    if (existing && !existing.actions.size) {
      this.follows.delete(key);
    }
    if (row.targetType === 'WAVE' && row.action === 'DROP_CREATED') {
      this.allDrops.delete(`${row.subscriberId}|${row.targetId}`);
    }
  }

  async addWaveDefaultGroups(subscriberId: string, waveId: string) {
    this.waveGroups.set(`${subscriberId}|${waveId}`, ['ALL']);
  }

  async deleteWaveGroups(subscriberId: string, waveId: string) {
    this.waveGroups.delete(`${subscriberId}|${waveId}`);
  }

  async waveFollowState(subscriberId: string, waveId: string) {
    return {
      isFollowing: this.follows.has(
        MemoryPersonalTables.followKey(subscriberId, 'WAVE', waveId)
      ),
      allDrops: this.allDrops.has(`${subscriberId}|${waveId}`)
    };
  }

  async setWaveAllDrops(subscriberId: string, waveId: string, on: boolean) {
    const key = `${subscriberId}|${waveId}`;
    if (on) this.allDrops.add(key);
    else this.allDrops.delete(key);
  }

  async replaceWaveGroups(
    subscriberId: string,
    waveId: string,
    groups: readonly WaveMentionGroup[]
  ) {
    if (groups.length) {
      this.waveGroups.set(`${subscriberId}|${waveId}`, [...groups]);
    } else {
      this.waveGroups.delete(`${subscriberId}|${waveId}`);
    }
  }

  private static flag(
    map: Map<string, number>,
    key: string,
    on: boolean,
    at: number,
    keepFirst = false
  ) {
    if (!on) map.delete(key);
    else if (!(keepFirst && map.has(key))) map.set(key, at);
  }

  async setMuted(muterId: string, mutedId: string, muted: boolean, at: number) {
    MemoryPersonalTables.flag(this.mutes, `${muterId}|${mutedId}`, muted, at);
  }

  async setBlocked(
    blockerId: string,
    blockedId: string,
    blocked: boolean,
    at: number
  ) {
    MemoryPersonalTables.flag(
      this.blocks,
      `${blockerId}|${blockedId}`,
      blocked,
      at,
      true
    );
    if (blocked) {
      this.follows.delete(
        MemoryPersonalTables.followKey(blockerId, 'IDENTITY', blockedId)
      );
    }
  }

  async isBlocked(blockerId: string, blockedId: string) {
    return this.blocks.has(`${blockerId}|${blockedId}`);
  }

  async setHidden(profileId: string, dropId: string, on: boolean, at: number) {
    MemoryPersonalTables.flag(this.hidden, `${profileId}|${dropId}`, on, at);
  }

  async setBookmarked(
    profileId: string,
    dropId: string,
    on: boolean,
    at: number
  ) {
    MemoryPersonalTables.flag(
      this.bookmarks,
      `${profileId}|${dropId}`,
      on,
      at,
      true
    );
  }

  async setArtworkAlert(
    subscriberId: string,
    artistId: string,
    on: boolean,
    at: number
  ) {
    MemoryPersonalTables.flag(
      this.alerts,
      `${subscriberId}|${artistId}`,
      on,
      at,
      true
    );
  }

  async setPin(profileId: string, waveId: string, position: number | null) {
    const key = `${profileId}|${waveId}`;
    if (position === null) this.pins.delete(key);
    else this.pins.set(key, position);
  }

  async updatePreferences(profileId: string, update: PreferencesUpdate) {
    const current = this.preferences.get(profileId) ?? {
      ...DEFAULT_PREFERENCES,
      notifications: { ...DEFAULT_PREFERENCES.notifications }
    };
    const next = {
      ...current,
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([key, value]) => key !== 'notifications' && value !== undefined
        )
      ),
      notifications: { ...current.notifications, ...update.notifications }
    } as typeof DEFAULT_PREFERENCES;
    if (
      next.direct_message_policy === 'GROUP_MEMBERS' &&
      !next.direct_message_group_id
    ) {
      throw new Error('GROUP_MEMBERS needs a group');
    }
    this.preferences.set(profileId, next);
  }

  async findAlias(ownerId: string, normalizedAlias: string) {
    for (const [id, alias] of Array.from(this.aliases.entries())) {
      if (alias.ownerId === ownerId && alias.alias === normalizedAlias) {
        return { id };
      }
    }
    return null;
  }

  async countAliases(ownerId: string) {
    return Array.from(this.aliases.values()).filter(
      (alias) => alias.ownerId === ownerId
    ).length;
  }

  async putAlias(alias: {
    id: string;
    ownerId: string;
    alias: string;
    memberIds: readonly string[];
    exists: boolean;
  }) {
    this.aliases.set(alias.id, {
      ownerId: alias.ownerId,
      alias: alias.alias,
      memberIds: [...alias.memberIds]
    });
  }

  async deleteAlias(aliasId: string) {
    this.aliases.delete(aliasId);
  }

  async renameAlias(aliasId: string, alias: string) {
    const row = this.aliases.get(aliasId);
    if (row) this.aliases.set(aliasId, { ...row, alias });
  }

  async mentionableProfileIds(profileIds: readonly string[]) {
    return profileIds.filter((id) => this.mentionable.has(id));
  }

  async setPushSettings(
    profileId: string,
    deviceId: string,
    settings: PushSettings | null
  ) {
    const key = `${profileId}|${deviceId}`;
    if (settings) this.push.set(key, { ...settings });
    else this.push.delete(key);
  }

  async setEulaConsent(
    profileId: string,
    deviceId: string,
    consent: { version: string; platform: string } | null,
    at: number
  ) {
    if (consent) {
      this.eula.set(deviceId, { profileId, ...consent, at });
    } else if (this.eula.get(deviceId)?.profileId === profileId) {
      this.eula.delete(deviceId);
    }
  }

  async waveOfDrop(dropId: string) {
    return this.dropWaves.get(dropId) ?? null;
  }

  async waveExists(waveId: string) {
    return this.waves.has(waveId);
  }

  /** Every table, sorted, for comparing two states. */
  snapshot(): Record<string, unknown> {
    const sorted = <V>(map: Map<string, V>) =>
      Array.from(map.entries()).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      );
    return {
      follows: sorted(this.follows).map(([key, row]) => [
        key,
        Array.from(row.actions).sort(byCodeUnit),
        row.waveId
      ]),
      allDrops: Array.from(this.allDrops).sort(byCodeUnit),
      waveGroups: sorted(this.waveGroups),
      mutes: sorted(this.mutes),
      blocks: sorted(this.blocks),
      hidden: sorted(this.hidden),
      bookmarks: sorted(this.bookmarks),
      alerts: sorted(this.alerts),
      pins: sorted(this.pins),
      preferences: sorted(this.preferences),
      aliases: sorted(this.aliases),
      push: sorted(this.push),
      eula: sorted(this.eula)
    };
  }
}

/** Owners: principals and wallets to profiles; wallets bound from a height. */
export class FixtureOwnerDirectory implements RecordOwnerDirectory {
  constructor(
    readonly profiles: Map<string, string>,
    readonly bindings: {
      wallet: string;
      principal: string;
      from: number;
    }[] = []
  ) {}

  async principalAt(wallet: string, height: number) {
    return (
      this.bindings.find(
        (binding) =>
          binding.wallet === wallet.toLowerCase() && height >= binding.from
      )?.principal ?? null
    );
  }

  async ownerAt(wallet: string, height: number) {
    return (await this.principalAt(wallet, height)) ?? wallet.toLowerCase();
  }

  async profileIdOf(owner: string) {
    return this.profiles.get(owner.toLowerCase()) ?? null;
  }
}

/** Live effects that record what they were asked, with visibility fixtures. */
export class RecordingLiveEffects implements PersonalLiveEffects {
  readonly hiddenWaves = new Set<string>();
  readonly hiddenDrops = new Set<string>();
  readonly selectableGroups = new Set<string>();
  readonly calls: string[] = [];

  constructor(private readonly tables: MemoryPersonalTables) {}

  async canSeeWave(_profileId: string, waveId: string) {
    return this.tables.waves.has(waveId) && !this.hiddenWaves.has(waveId);
  }

  async canSeeDrop(_profileId: string, dropId: string) {
    return this.tables.dropWaves.has(dropId) && !this.hiddenDrops.has(dropId);
  }

  async isSelectableGroup(groupId: string) {
    return this.selectableGroups.has(groupId);
  }

  async notifyNewFollower(subscriberId: string, targetId: string) {
    this.calls.push(`new-follower ${subscriberId}->${targetId}`);
  }

  async wavesChanged(
    profileId: string,
    waveId: string,
    reason: 'FOLLOWED' | 'UNFOLLOWED',
    _ctx: RequestContext
  ) {
    this.calls.push(`${reason} ${profileId} ${waveId}`);
  }

  async recordActiveIdentity(profileId: string) {
    this.calls.push(`active ${profileId}`);
  }

  async waveFollowChanged(waveId: string) {
    this.calls.push(`score ${waveId}`);
  }

  async muteChanged(muterId: string, mutedId: string) {
    this.calls.push(`mute ${muterId}->${mutedId}`);
  }
}

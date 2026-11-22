import type { RequestContext } from '@/request.context';

import { CustomApiCompliantException } from '@/exceptions';

/**
 * The answer when the chain gateway can't say whose a wallet is (it is
 * down, or its binding history doesn't reach the height asked): 503, as
 * GET /signed-records/owners answers, so the client tries again later.
 */
export function ownersUnavailable(): CustomApiCompliantException {
  return new CustomApiCompliantException(
    503,
    "The chain gateway can't say who owns a wallet right now. Try again shortly.",
    'OWNERS_UNAVAILABLE'
  );
}

/** The follow actions a target type takes (today's API values). */
export type FollowTargetType = 'IDENTITY' | 'WAVE' | 'DROP';
export type FollowAction = 'DROP_CREATED' | 'WAVE_CREATED' | 'DROP_REPLIED';
export type WaveMentionGroup = 'ALL' | 'CONTRIBUTORS' | 'ADMINS' | 'DEVS_6529';

export interface PushSettings {
  readonly identity_subscribed: boolean;
  readonly identity_mentioned: boolean;
  readonly identity_rep: boolean;
  readonly identity_nic: boolean;
  readonly drop_quoted: boolean;
  readonly drop_replied: boolean;
  readonly drop_voted: boolean;
  readonly drop_reacted: boolean;
  readonly drop_boosted: boolean;
  readonly wave_created: boolean;
  readonly subscription_coverage: boolean;
}

export interface PreferencesUpdate {
  readonly direct_message_policy?: string;
  readonly direct_message_group_id?: string | null;
  readonly direct_message_allow_people_i_follow?: boolean;
  readonly notification_level?: string;
  readonly notifications?: Readonly<Record<string, boolean>>;
}

/**
 * The table writes and reads the personal appliers make, each in the
 * record's transaction (ctx.connection). They are today's db calls; the
 * wiring (personal-records.wiring.ts) binds them, tests use a memory fake.
 * Times are the record's claimed time, so a rebuild writes the same rows.
 */
export interface PersonalTables {
  // identity_subscriptions (+ wave_metrics and the wave's default groups)
  followActions(
    subscriberId: string,
    targetType: FollowTargetType,
    targetId: string,
    ctx: RequestContext
  ): Promise<FollowAction[]>;
  addFollow(
    row: {
      readonly subscriberId: string;
      readonly targetType: FollowTargetType;
      readonly targetId: string;
      readonly action: FollowAction;
      readonly waveId: string | null;
    },
    ctx: RequestContext,
    // false in a rebuild: wave_metrics is the waves rebuild's to count.
    countWaveSubscribers: boolean
  ): Promise<void>;
  removeFollow(
    row: {
      readonly subscriberId: string;
      readonly targetType: FollowTargetType;
      readonly targetId: string;
      readonly action: FollowAction;
    },
    ctx: RequestContext,
    countWaveSubscribers: boolean
  ): Promise<void>;
  addWaveDefaultGroups(
    subscriberId: string,
    waveId: string,
    ctx: RequestContext
  ): Promise<void>;
  deleteWaveGroups(
    subscriberId: string,
    waveId: string,
    ctx: RequestContext
  ): Promise<void>;
  waveFollowState(
    subscriberId: string,
    waveId: string,
    ctx: RequestContext
  ): Promise<{ isFollowing: boolean; allDrops: boolean }>;
  setWaveAllDrops(
    subscriberId: string,
    waveId: string,
    on: boolean,
    ctx: RequestContext
  ): Promise<void>;
  replaceWaveGroups(
    subscriberId: string,
    waveId: string,
    groups: readonly WaveMentionGroup[],
    ctx: RequestContext
  ): Promise<void>;

  // identity_mutes
  setMuted(
    muterId: string,
    mutedId: string,
    muted: boolean,
    at: number,
    ctx: RequestContext
  ): Promise<void>;
  // content_moderation_profile_blocks (a block also removes the follow rows)
  setBlocked(
    blockerId: string,
    blockedId: string,
    blocked: boolean,
    at: number,
    ctx: RequestContext,
    // false in a rebuild: personalModerationAuditRows supplies the audit
    // rows (PROFILE_BLOCKED and PROFILE_UNBLOCKED), which the audit log's
    // rebuild inserts. Live rows take the record's time (`at`).
    audit: boolean
  ): Promise<void>;
  isBlocked(
    blockerId: string,
    blockedId: string,
    ctx: RequestContext
  ): Promise<boolean>;
  // content_moderation_hidden_drops
  setHidden(
    profileId: string,
    dropId: string,
    hidden: boolean,
    at: number,
    ctx: RequestContext,
    // As setBlocked's (DROP_HIDDEN and DROP_UNHIDDEN).
    audit: boolean
  ): Promise<void>;
  // drop_bookmarks
  setBookmarked(
    profileId: string,
    dropId: string,
    bookmarked: boolean,
    at: number,
    ctx: RequestContext
  ): Promise<void>;
  // artist_artwork_alerts
  setArtworkAlert(
    subscriberId: string,
    artistId: string,
    enabled: boolean,
    at: number,
    ctx: RequestContext
  ): Promise<void>;
  // pinned_waves
  setPin(
    profileId: string,
    waveId: string,
    position: number | null,
    ctx: RequestContext
  ): Promise<void>;
  // profile_preferences
  updatePreferences(
    profileId: string,
    update: PreferencesUpdate,
    ctx: RequestContext
  ): Promise<void>;
  // mention_aliases, mention_alias_members
  findAlias(
    ownerId: string,
    normalizedAlias: string,
    ctx: RequestContext
  ): Promise<{ readonly id: string } | null>;
  /** Counts under the owner's profile lock, so two creates can't pass the limit. */
  countAliases(ownerId: string, ctx: RequestContext): Promise<number>;
  putAlias(
    alias: {
      readonly id: string;
      readonly ownerId: string;
      readonly alias: string;
      readonly memberIds: readonly string[];
      readonly exists: boolean;
    },
    ctx: RequestContext
  ): Promise<void>;
  deleteAlias(aliasId: string, ctx: RequestContext): Promise<void>;
  renameAlias(
    aliasId: string,
    alias: string,
    ctx: RequestContext
  ): Promise<void>;
  mentionableProfileIds(
    profileIds: readonly string[],
    ctx: RequestContext
  ): Promise<string[]>;
  // push_notification_settings
  setPushSettings(
    profileId: string,
    deviceId: string,
    settings: PushSettings | null,
    ctx: RequestContext
  ): Promise<void>;
  // eula_consent
  setEulaConsent(
    profileId: string,
    deviceId: string,
    consent: { readonly version: string; readonly platform: string } | null,
    at: number,
    ctx: RequestContext
  ): Promise<void>;

  // Lookups
  waveOfDrop(dropId: string, ctx: RequestContext): Promise<string | null>;
  waveExists(waveId: string, ctx: RequestContext): Promise<boolean>;
}

/**
 * Today's live-only rules and effects: visibility checks that need the
 * caller's groups, notifications and websocket events. A rebuild never
 * calls these.
 */
export interface PersonalLiveEffects {
  canSeeWave(
    profileId: string,
    waveId: string,
    ctx: RequestContext
  ): Promise<boolean>;
  canSeeDrop(
    profileId: string,
    dropId: string,
    ctx: RequestContext
  ): Promise<boolean>;
  /** The DM-policy group must be one the profile sees and not a DM group. */
  isSelectableGroup(groupId: string, ctx: RequestContext): Promise<boolean>;
  notifyNewFollower(
    subscriberId: string,
    targetId: string,
    ctx: RequestContext
  ): Promise<void>;
  /** After commit: FOLLOWED/UNFOLLOWED to the profile's open sockets. */
  wavesChanged(
    profileId: string,
    waveId: string,
    reason: 'FOLLOWED' | 'UNFOLLOWED',
    ctx: RequestContext
  ): Promise<void>;
  recordActiveIdentity(profileId: string, ctx: RequestContext): Promise<void>;
  /** After commit: the wave's score counts followers; mark it for a refresh. */
  waveFollowChanged(waveId: string, ctx: RequestContext): Promise<void>;
  /** After commit: DM unread counts and their socket notice, as a mute does today. */
  muteChanged(
    muterId: string,
    mutedId: string,
    ctx: RequestContext
  ): Promise<void>;
}

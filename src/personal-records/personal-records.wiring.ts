import { afterCommit } from '@/db/after-commit';
import { dropsDb } from '@/drops/drops.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import {
  ProfileDirectMessagePolicy,
  ProfileNotificationLevel,
  ProfilePreferencesUpdate
} from '@/entities/IProfilePreferences';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { mentionAliasesDb } from '@/mention-aliases/mention-aliases.db';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { userNotifier } from '@/notifications/user.notifier';
import { waveGroupNotificationSubscriptionsDb } from '@/notifications/wave-group-notification-subscriptions.db';
import { profilePreferencesDb } from '@/profile-preferences/profile-preferences.db';
import { NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper } from '@/sql-executor';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { dropBookmarksDb } from '@/api/drops/drop-bookmarks.db';
import { identityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  deleteOwnedEULAConsent,
  saveEULAConsent
} from '@/api/policies/policies.db';
import { pushNotificationSettingsDb } from '@/api/push-notifications/push-notification-settings.db';
import { assertWaveAndParentVisibleToProfileOrThrow } from '@/api/waves/wave-access.helpers';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { wavesChangedNotifier } from '@/api/waves/waves-changed.notifier';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { identityMutesApiService } from '@/api/identity-mutes/identity-mutes.api.service';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { checkNewRuleTerms } from '@/api/collect/collect-rules.service';
import type { CollectRuleDeps } from './collect-rule-records';
import type {
  PersonalLiveEffects,
  PersonalTables
} from './personal-records.ports';

function connectionOf(ctx: RequestContext): ConnectionWrapper<any> {
  if (!ctx.connection) {
    throw new Error('Personal records apply inside the record transaction');
  }
  return ctx.connection;
}

/** The personal tables through today's db classes. */
export const personalTables: PersonalTables = {
  followActions: (subscriberId, targetType, targetId, ctx) =>
    identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
      {
        subscriber_id: subscriberId,
        target_id: targetId,
        target_type: targetType as ActivityEventTargetType
      },
      connectionOf(ctx)
    ),
  addFollow: (row, ctx, countWaveSubscribers) =>
    identitySubscriptionsDb.addIdentitySubscription(
      {
        subscriber_id: row.subscriberId,
        target_id: row.targetId,
        target_type: row.targetType as ActivityEventTargetType,
        target_action: row.action as ActivityEventAction,
        wave_id: row.waveId,
        subscribed_to_all_drops: false
      },
      connectionOf(ctx),
      ctx.timer,
      { countWaveSubscribers }
    ),
  removeFollow: (row, ctx, countWaveSubscribers) =>
    identitySubscriptionsDb.deleteIdentitySubscription(
      {
        subscriber_id: row.subscriberId,
        target_id: row.targetId,
        target_type: row.targetType as ActivityEventTargetType,
        target_action: row.action as ActivityEventAction
      },
      connectionOf(ctx),
      { countWaveSubscribers }
    ),
  addWaveDefaultGroups: (subscriberId, waveId, ctx) =>
    waveGroupNotificationSubscriptionsDb.addDefaultGroupsForWaveSubscription(
      subscriberId,
      waveId,
      connectionOf(ctx)
    ),
  deleteWaveGroups: (subscriberId, waveId, ctx) =>
    waveGroupNotificationSubscriptionsDb.deleteForWave(
      subscriberId,
      waveId,
      connectionOf(ctx)
    ),
  waveFollowState: async (subscriberId, waveId, ctx) => {
    const state = await identitySubscriptionsDb.getWaveSubscriptionState(
      subscriberId,
      waveId,
      connectionOf(ctx)
    );
    return {
      isFollowing: state.is_following,
      allDrops: state.subscribed_to_all_drops
    };
  },
  setWaveAllDrops: (subscriberId, waveId, on, ctx) =>
    on
      ? identitySubscriptionsDb.subscribeToAllDrops(
          subscriberId,
          waveId,
          connectionOf(ctx)
        )
      : identitySubscriptionsDb.unsubscribeFromAllDrops(
          subscriberId,
          waveId,
          connectionOf(ctx)
        ),
  replaceWaveGroups: (subscriberId, waveId, groups, ctx) =>
    waveGroupNotificationSubscriptionsDb.replaceEnabledGroups(
      {
        identityId: subscriberId,
        waveId,
        mentionedGroups: groups.map((group) => group as DropGroupMention)
      },
      connectionOf(ctx)
    ),
  setMuted: (muterId, mutedId, muted, at, ctx) => {
    const pair = { muter_id: muterId, muted_identity_id: mutedId };
    return muted
      ? identityMutesDb.muteIdentity(pair, ctx, at)
      : identityMutesDb.unmuteIdentity(pair, ctx);
  },
  setBlocked: (blockerId, blockedId, blocked, at, ctx, audit) =>
    blocked
      ? contentModerationDb.blockProfile(blockerId, blockedId, ctx, at, audit)
      : contentModerationDb.unblockProfile(
          blockerId,
          blockedId,
          ctx,
          at,
          audit
        ),
  isBlocked: (blockerId, blockedId, ctx) =>
    contentModerationDb.isProfileBlocked(
      blockerId,
      blockedId,
      connectionOf(ctx)
    ),
  setHidden: (profileId, dropId, hidden, at, ctx, audit) =>
    hidden
      ? contentModerationDb.hideDrop(profileId, dropId, ctx, at, audit)
      : contentModerationDb.unhideDrop(profileId, dropId, ctx, at, audit),
  setBookmarked: (profileId, dropId, bookmarked, at, ctx) =>
    bookmarked
      ? dropBookmarksDb.insertBookmark(
          { identity_id: profileId, drop_id: dropId, bookmarked_at: at },
          connectionOf(ctx)
        )
      : dropBookmarksDb.deleteBookmark(
          { identity_id: profileId, drop_id: dropId },
          connectionOf(ctx)
        ),
  setArtworkAlert: (subscriberId, artistId, enabled, at, ctx) =>
    artistArtworkAlertsDb.setEnabled(
      { subscriberId, artistId },
      enabled,
      ctx,
      at
    ),
  setPin: async (profileId, waveId, position, ctx) => {
    if (position === null) {
      await wavesApiDb.deletePin({ waveId, profileId }, ctx);
      return;
    }
    await wavesApiDb.updatePinnedWavePositions(
      profileId,
      [{ wave_id: waveId, position }],
      ctx
    );
  },
  updatePreferences: async (profileId, update, ctx) => {
    await profilePreferencesDb.upsert(
      profileId,
      {
        ...update,
        direct_message_policy: update.direct_message_policy as
          | ProfileDirectMessagePolicy
          | undefined,
        notification_level: update.notification_level as
          | ProfileNotificationLevel
          | undefined
      } as ProfilePreferencesUpdate,
      connectionOf(ctx)
    );
  },
  findAlias: async (ownerId, normalizedAlias, ctx) => {
    const aliases = await mentionAliasesDb.findByOwner(
      ownerId,
      connectionOf(ctx)
    );
    const found = aliases.find((alias) => alias.alias === normalizedAlias);
    return found ? { id: found.id } : null;
  },
  countAliases: async (ownerId, ctx) => {
    await mentionAliasesDb.lockOwnerProfile(ownerId, connectionOf(ctx));
    return mentionAliasesDb.countByOwner(ownerId, connectionOf(ctx));
  },
  renameAlias: (aliasId, alias, ctx) =>
    mentionAliasesDb.updateAliasName(aliasId, alias, alias, connectionOf(ctx)),
  putAlias: async (alias, ctx) => {
    const connection = connectionOf(ctx);
    await mentionAliasesDb.lockOwnerProfile(alias.ownerId, connection);
    if (!alias.exists) {
      await mentionAliasesDb.insertAlias(
        {
          id: alias.id,
          ownerProfileId: alias.ownerId,
          alias: alias.alias,
          normalizedAlias: alias.alias
        },
        connection
      );
    }
    await mentionAliasesDb.replaceMembers(
      alias.id,
      [...alias.memberIds],
      connection
    );
  },
  deleteAlias: (aliasId, ctx) =>
    mentionAliasesDb.deleteAlias(aliasId, connectionOf(ctx)),
  mentionableProfileIds: (profileIds, ctx) =>
    mentionAliasesDb.findMentionableProfileIds(
      [...profileIds],
      connectionOf(ctx)
    ),
  setPushSettings: (profileId, deviceId, settings, ctx) =>
    settings
      ? pushNotificationSettingsDb.replacePushNotificationSettings(
          profileId,
          deviceId,
          settings,
          connectionOf(ctx)
        )
      : pushNotificationSettingsDb.deletePushNotificationSettings(
          profileId,
          deviceId,
          connectionOf(ctx)
        ),
  setEulaConsent: (profileId, deviceId, consent, at, ctx) =>
    consent
      ? saveEULAConsent(
          deviceId,
          consent.platform,
          consent.version,
          profileId,
          { acceptedAt: at, connection: connectionOf(ctx) }
        )
      : deleteOwnedEULAConsent(deviceId, profileId, connectionOf(ctx)),
  waveOfDrop: async (dropId, ctx) =>
    (await dropsDb.findDropById(dropId, connectionOf(ctx)))?.wave_id ?? null,
  waveExists: async (waveId, ctx) =>
    (await dropsDb.findWaveByIdOrNull(waveId, connectionOf(ctx))) !== null
};

/** Today's live rules and effects for the personal routes. */
export const personalLiveEffects: PersonalLiveEffects = {
  canSeeWave: async (profileId, waveId, ctx) => {
    try {
      await assertWaveAndParentVisibleToProfileOrThrow({
        wave: await wavesApiDb.findWaveById(waveId, ctx.connection),
        profileId,
        userGroupsService,
        message: `Wave ${waveId} not found`,
        wavesApiDb,
        ctx
      });
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  },
  canSeeDrop: async (profileId, dropId, ctx) => {
    const groups = await userGroupsService.getGroupsUserIsEligibleFor(
      profileId,
      ctx.timer
    );
    return (
      (await dropsDb.findDropByIdWithEligibilityCheck(
        dropId,
        groups,
        ctx.connection
      )) !== null
    );
  },
  isSelectableGroup: async (groupId, ctx) => {
    const [group] = await userGroupsService.getApiGroupsVisibleToRequesterByIds(
      [groupId],
      ctx
    );
    return !!group && !group.is_direct_message;
  },
  notifyNewFollower: (subscriberId, targetId, ctx) =>
    userNotifier.notifyOfIdentitySubscription(
      { subscriber_id: subscriberId, subscribed_to: targetId },
      connectionOf(ctx)
    ),
  wavesChanged: (profileId, waveId, reason, ctx) =>
    afterCommit(ctx.connection, () =>
      wavesChangedNotifier.notify([{ profileId, waveIds: [waveId], reason }])
    ),
  recordActiveIdentity: (profileId, ctx) =>
    metricsRecorder.recordActiveIdentity({ identityId: profileId }, ctx),
  waveFollowChanged: (waveId, ctx) =>
    afterCommit(ctx.connection, () =>
      waveScoreService.requestWaveScoreRefreshBestEffort(
        [waveId],
        WaveScoreDirtyRefreshReason.WAVE_SUBSCRIPTION_CHANGED,
        { authenticationContext: ctx.authenticationContext, timer: ctx.timer }
      )
    ),
  muteChanged: (muterId, mutedId, ctx) =>
    afterCommit(ctx.connection, () =>
      identityMutesApiService.synchronizeDmUnreadStatesBestEffort(
        { muter_id: muterId, muted_identity_id: mutedId },
        { timer: ctx.timer }
      )
    )
};

/** Collect rules through today's store, in the record's transaction. */
export const collectRuleDeps: CollectRuleDeps = {
  applyRule: (change, mode, ctx) =>
    collectingRulesService.applyRuleRecord(change, connectionOf(ctx), {
      log: true,
      ...(mode === 'live'
        ? {
            beforeCreate: () =>
              checkNewRuleTerms(change.profileId, change.definition)
          }
        : {})
    }),
  restoreRule: (state, ctx) =>
    collectingRulesService.restoreRule(state, connectionOf(ctx)),
  restoreOperation: (binding, ctx) =>
    collectingRulesService.restoreOperation(binding, connectionOf(ctx))
};

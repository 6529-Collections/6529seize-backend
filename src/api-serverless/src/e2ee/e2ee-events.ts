import { ApiE2eeLogItem } from '@/api/generated/models/ApiE2eeLogItem';
import {
  E2eeWakeReason,
  enqueueE2eeWake
} from '@/api/push-notifications/push-notifications.service';
import { appWebSockets } from '@/api/ws/ws';
import { wsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { WsMessageType } from '@/api/ws/ws-message';
import { E2EE_WS_INLINE_ITEM_MAX_BYTES } from '@/e2ee/e2ee.constants';
import { E2eeDb, e2eeDb } from '@/e2ee/e2ee.db';
import { Logger } from '@/logging';

export interface E2eeGroupEventData {
  readonly group: string;
  readonly seq: number;
  readonly epoch: number;
  readonly type: 'entry' | 'message';
  readonly item?: ApiE2eeLogItem;
}

export interface E2eeWelcomeEventData {
  readonly profileId: string;
  readonly deviceKey: string;
  readonly welcomeId: string;
  readonly group: string;
}

export interface E2eeDeviceEventData {
  readonly profile_id: string;
  readonly device_key: string;
}

/**
 * Post-commit side effects of E2EE writes: WebSocket hints (section 5) and
 * content-free push wakes (section 7.3). Every method is best effort and
 * never throws, so a delivery failure cannot fail a sequenced request.
 */
export interface E2eeEventPublisher {
  groupEvent(profileIds: string[], data: E2eeGroupEventData): Promise<void>;
  welcomes(deliveries: E2eeWelcomeEventData[]): Promise<void>;
  deviceAdded(profileIds: string[], data: E2eeDeviceEventData): Promise<void>;
  deviceRevoked(profileIds: string[], data: E2eeDeviceEventData): Promise<void>;
  rosterChanged(
    profileIds: string[],
    data: { group: string; epoch: number }
  ): Promise<void>;
  wake(
    group: string,
    profileIds: string[],
    reason: E2eeWakeReason
  ): Promise<void>;
}

/** Inline the log item only if it serializes to at most 16 KiB. */
export function e2eeGroupEventPayload(data: E2eeGroupEventData) {
  const base = {
    group: data.group,
    seq: data.seq,
    epoch: data.epoch,
    type: data.type
  };
  if (!data.item) return base;
  const itemBytes = Buffer.byteLength(JSON.stringify(data.item), 'utf8');
  return itemBytes <= E2EE_WS_INLINE_ITEM_MAX_BYTES
    ? { ...base, item: data.item }
    : base;
}

export class WsE2eeEventPublisher implements E2eeEventPublisher {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly db: E2eeDb,
    private readonly findConnections: (
      profileIds: string[]
    ) => Promise<{ connectionId: string; identityId: string }[]>,
    private readonly sendToConnection: (
      connectionId: string,
      message: string
    ) => Promise<void>,
    /** Resolves false when nothing was queued (push delivery switched off). */
    private readonly enqueueWake: (
      profileIds: string[],
      reason: E2eeWakeReason
    ) => Promise<boolean | void>,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async sendToProfiles(
    profileIds: string[],
    messageForProfile: (profileId: string) => string | null
  ): Promise<void> {
    const unique = Array.from(new Set(profileIds.filter((id) => !!id)));
    if (!unique.length) return;
    try {
      const connections = await this.findConnections(unique);
      await Promise.all(
        connections.map(async ({ connectionId, identityId }) => {
          const message = messageForProfile(identityId);
          if (message === null) return;
          try {
            await this.sendToConnection(connectionId, message);
          } catch {
            // One failed socket must not stop the others.
          }
        })
      );
    } catch (error) {
      this.logger.warn(
        `E2EE websocket hint failed for ${unique.length} profiles: ${
          (error as Error)?.message ?? 'unknown'
        }`
      );
    }
  }

  private broadcast(profileIds: string[], type: WsMessageType, data: object) {
    const message = JSON.stringify({ type, data });
    return this.sendToProfiles(profileIds, () => message);
  }

  groupEvent(profileIds: string[], data: E2eeGroupEventData) {
    return this.broadcast(
      profileIds,
      WsMessageType.E2EE_GROUP_EVENT,
      e2eeGroupEventPayload(data)
    );
  }

  welcomes(deliveries: E2eeWelcomeEventData[]) {
    const byProfile = new Map<string, E2eeWelcomeEventData[]>();
    for (const delivery of deliveries) {
      const list = byProfile.get(delivery.profileId) ?? [];
      list.push(delivery);
      byProfile.set(delivery.profileId, list);
    }
    const messages = new Map(
      Array.from(byProfile.entries()).map(([profileId, list]) => [
        profileId,
        list.map((delivery) =>
          JSON.stringify({
            type: WsMessageType.E2EE_WELCOME,
            data: {
              device_key: delivery.deviceKey,
              welcome_id: delivery.welcomeId,
              group: delivery.group
            }
          })
        )
      ])
    );
    return this.sendToProfilesMany(messages);
  }

  private async sendToProfilesMany(messages: Map<string, string[]>) {
    if (!messages.size) return;
    try {
      const connections = await this.findConnections(
        Array.from(messages.keys())
      );
      await Promise.all(
        connections.flatMap(({ connectionId, identityId }) =>
          (messages.get(identityId) ?? []).map((message) =>
            this.sendToConnection(connectionId, message).catch(() => undefined)
          )
        )
      );
    } catch (error) {
      this.logger.warn(
        `E2EE welcome hints failed: ${(error as Error)?.message ?? 'unknown'}`
      );
    }
  }

  deviceAdded(profileIds: string[], data: E2eeDeviceEventData) {
    return this.broadcast(profileIds, WsMessageType.E2EE_DEVICE_ADDED, data);
  }

  deviceRevoked(profileIds: string[], data: E2eeDeviceEventData) {
    return this.broadcast(profileIds, WsMessageType.E2EE_DEVICE_REVOKED, data);
  }

  rosterChanged(profileIds: string[], data: { group: string; epoch: number }) {
    return this.broadcast(profileIds, WsMessageType.E2EE_ROSTER_CHANGED, data);
  }

  async wake(group: string, profileIds: string[], reason: E2eeWakeReason) {
    const unique = Array.from(new Set(profileIds.filter((id) => !!id)));
    if (!unique.length) return;
    const claimedAt = this.now();
    let eligible: string[] = [];
    try {
      eligible = await this.db.claimPushWakes(group, unique, claimedAt);
      if (!eligible.length) return;
      if ((await this.enqueueWake(eligible, reason)) === false) {
        await this.releaseWakes(group, eligible, claimedAt);
      }
    } catch (error) {
      // A wake that never reached the queue must not hold the 60 s slot.
      await this.releaseWakes(group, eligible, claimedAt);
      this.logger.warn(
        `E2EE push wake failed for ${unique.length} profiles: ${
          (error as Error)?.message ?? 'unknown'
        }`
      );
    }
  }

  private async releaseWakes(
    group: string,
    profileIds: string[],
    claimedAt: number
  ): Promise<void> {
    if (!profileIds.length) return;
    try {
      await this.db.releasePushWakes(group, profileIds, claimedAt);
    } catch {
      this.logger.warn('E2EE push wake release failed');
    }
  }
}

export const e2eeEventPublisher: E2eeEventPublisher = new WsE2eeEventPublisher(
  e2eeDb,
  (profileIds) =>
    wsConnectionRepository.findPrimaryConnectionIdsByIdentityIds(profileIds),
  (connectionId, message) => appWebSockets.send({ connectionId, message }),
  enqueueE2eeWake
);

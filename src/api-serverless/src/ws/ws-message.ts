import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiDmUnreadConversationState } from '@/api/generated/models/ApiDmUnreadConversationState';

export const WS_RECOVERY_CAPABILITY = 'resync_v1';

export enum WsMessageType {
  RESYNC_REQUIRED = 'RESYNC_REQUIRED',
  DROP_UPDATE = 'DROP_UPDATE',
  COMPETITION_UPDATE = 'COMPETITION_UPDATE',
  DROP_UPDATE_REF = 'DROP_UPDATE_REF',
  DROP_DELETE = 'DROP_DELETE',
  DROP_RATING_UPDATE = 'DROP_RATING_UPDATE',
  DROP_REACTION_UPDATE = 'DROP_REACTION_UPDATE',
  USER_IS_TYPING = 'USER_IS_TYPING',
  SUBSCRIBE_TO_WAVE = 'SUBSCRIBE_TO_WAVE',
  /** App socket: which wave the tab has open, or null (waves 1.3). */
  SET_OPEN_WAVE = 'SET_OPEN_WAVE',
  AUTHENTICATE = 'AUTHENTICATE',
  AUTHENTICATED = 'AUTHENTICATED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  SYNC_NOTIFICATION_IDENTITIES = 'SYNC_NOTIFICATION_IDENTITIES',
  NOTIFICATION_IDENTITIES_SYNCED = 'NOTIFICATION_IDENTITIES_SYNCED',
  IDENTITY_NOTIFICATIONS_CHANGED = 'IDENTITY_NOTIFICATIONS_CHANGED',
  DM_UNREAD_STATE_CHANGED = 'DM_UNREAD_STATE_CHANGED',
  // A reader's read watermark in one wave changed (waves plan 1.7).
  READ_STATE = 'READ_STATE',
  /** A profile's followed or added waves changed (waves 1.3). */
  WAVES_CHANGED = 'WAVES_CHANGED',
  MEDIA_LINK_UPDATED = 'MEDIA_LINK_UPDATED',
  ATTACHMENT_STATUS_UPDATE = 'ATTACHMENT_STATUS_UPDATE',
  // End-to-end encrypted messaging (D109). Hints only: clients re-sync over
  // REST. Payloads carry handles, sequence numbers and device keys, never
  // plaintext.
  E2EE_GROUP_EVENT = 'E2EE_GROUP_EVENT',
  E2EE_WELCOME = 'E2EE_WELCOME',
  E2EE_DEVICE_ADDED = 'E2EE_DEVICE_ADDED',
  E2EE_DEVICE_REVOKED = 'E2EE_DEVICE_REVOKED',
  E2EE_ROSTER_CHANGED = 'E2EE_ROSTER_CHANGED'
}

export interface WsMessage<MESSAGE_DATA> {
  type: WsMessageType;
  data: MESSAGE_DATA;
  reason?: string;
  /**
   * Gap marker (waves 1.5) on new-drop DROP_UPDATE frames: the serial of the
   * previous surviving drop in the wave, read after commit, or null for the
   * wave's first drop. Absent on edits and other updates.
   */
  prev_serial_no?: number | null;
}

export const DROP_UPDATE_REASON_POLL_RESPONSE = 'POLL_RESPONSE';
export const DROP_UPDATE_REASON_REPLY_COLLAPSE = 'REPLY_COLLAPSE';
export const DROP_UPDATE_REASON_MEDIA_STATUS = 'MEDIA_STATUS';

/**
 * Application ceiling for serialized drop updates. API Gateway permits a
 * 32 KiB WebSocket frame; keeping full updates below 28 KiB leaves room for
 * transport/protocol evolution. The decision is made after recipient-specific
 * mutation and UTF-8 serialization. Oversized updates use DROP_UPDATE_REF so
 * clients can refetch the canonical drop instead of receiving a truncated or
 * rejected frame.
 */
export const DROP_UPDATE_MAX_UTF8_BYTES = 28 * 1024;

/**
 * Delivery timing on a serialized frame (additive top-level fields; clients
 * that do not know them ignore them):
 * - `server_received_at`: epoch ms when the API received the request that
 *   produced this frame. Omitted for background producers.
 * - `sent_at`: epoch ms when the server handed this frame to the gateway.
 *
 * Appending to the serialized text keeps the payload serialized once.
 */
/**
 * Bytes reserved for the timing fields when a frame's size is checked against
 * DROP_UPDATE_MAX_UTF8_BYTES, so a stamped frame stays within the ceiling.
 * The longest form is `,"server_received_at":<13 digits>,"sent_at":<13 digits>`.
 */
export const DELIVERY_TIMESTAMPS_RESERVED_BYTES = 64;

export function withDeliveryTimestamps(
  message: string,
  {
    serverReceivedAt,
    sentAt
  }: { serverReceivedAt: number | null; sentAt: number }
): string {
  if (
    !message.startsWith('{') ||
    !message.endsWith('}') ||
    message === '{}' ||
    !Number.isFinite(sentAt)
  ) {
    return message;
  }
  const received =
    serverReceivedAt === null || !Number.isFinite(serverReceivedAt)
      ? ''
      : `,"server_received_at":${Math.round(serverReceivedAt)}`;
  return `${message.slice(0, -1)}${received},"sent_at":${Math.round(sentAt)}}`;
}

export type DropUpdateRefType =
  | WsMessageType.DROP_UPDATE
  | WsMessageType.DROP_RATING_UPDATE
  | WsMessageType.DROP_REACTION_UPDATE;

export function dropUpdateMessage(
  data: ApiDrop,
  reason?: string,
  prevSerialNo?: number | null
): WsMessage<ApiDrop> {
  const message: WsMessage<ApiDrop> = {
    type: WsMessageType.DROP_UPDATE,
    data
  };
  if (reason !== undefined) {
    message.reason = reason;
  }
  if (prevSerialNo !== undefined) {
    message.prev_serial_no = prevSerialNo;
  }
  return message;
}

export interface DropUpdateRefMessageData {
  readonly drop_id: string;
  readonly wave_id: string;
  readonly author_id: string;
  readonly serial_no: number;
  readonly update_type: DropUpdateRefType;
  readonly collapsed_reply_thread_id?: string;
  readonly reason?: string;
}

export function dropUpdateRefMessage(
  data: DropUpdateRefMessageData
): WsMessage<DropUpdateRefMessageData> {
  return {
    type: WsMessageType.DROP_UPDATE_REF,
    data
  };
}

export function dropRatingUpdateMessage(data: ApiDrop): WsMessage<ApiDrop> {
  return {
    type: WsMessageType.DROP_RATING_UPDATE,
    data
  };
}

export function dropReactionUpdateMessage(data: ApiDrop): WsMessage<ApiDrop> {
  return {
    type: WsMessageType.DROP_REACTION_UPDATE,
    data
  };
}

export function dropDeleteMessage(
  data: DropDeleteMessageData
): WsMessage<DropDeleteMessageData> {
  return {
    type: WsMessageType.DROP_DELETE,
    data
  };
}

export function userIsTypingMessage(
  data: UserIsTypingMessageData
): WsMessage<UserIsTypingMessageData> {
  return {
    type: WsMessageType.USER_IS_TYPING,
    data
  };
}

export function nftLinkUpdatedMessage(
  data: ApiNftLinkData
): WsMessage<ApiNftLinkData> {
  return {
    type: WsMessageType.MEDIA_LINK_UPDATED,
    data
  };
}

export function attachmentStatusUpdateMessage(
  data: ApiAttachment
): WsMessage<ApiAttachment> {
  return {
    type: WsMessageType.ATTACHMENT_STATUS_UPDATE,
    data
  };
}

export function notificationIdentitiesSyncedMessage(
  profileIds: string[]
): WsMessage<{ profile_ids: string[] }> {
  return {
    type: WsMessageType.NOTIFICATION_IDENTITIES_SYNCED,
    data: { profile_ids: profileIds }
  };
}

export function identityNotificationsChangedMessage(
  profileId: string
): WsMessage<{ profile_id: string }> {
  return {
    type: WsMessageType.IDENTITY_NOTIFICATIONS_CHANGED,
    data: { profile_id: profileId }
  };
}

export function dmUnreadStateChangedMessage(
  state: ApiDmUnreadConversationState
): WsMessage<ApiDmUnreadConversationState> {
  return {
    type: WsMessageType.DM_UNREAD_STATE_CHANGED,
    data: state
  };
}

export type WavesChangedReason = 'FOLLOWED' | 'UNFOLLOWED' | 'ADDED';

export interface WavesChangedMessageData {
  readonly profile_id: string;
  readonly wave_ids: string[];
  readonly reason: WavesChangedReason;
}

/** Tells a profile's sockets to refetch its wave list (FRAME-CONTRACTS 5). */
export function wavesChangedMessage(
  data: WavesChangedMessageData
): WsMessage<WavesChangedMessageData> {
  return { type: WsMessageType.WAVES_CHANGED, data };
}

export interface DropDeleteMessageData {
  readonly drop_id: string;
  readonly wave_id: string;
  readonly drop_serial: number;
}

export interface UserIsTypingMessageData {
  readonly wave_id: string;
  readonly profile: Omit<ApiProfileMin, 'subscribed_actions'>;
  readonly timestamp: number;
}

export interface UserIsTypingMessageRequest {
  readonly wave_id: string;
  readonly timestamp: number;
}

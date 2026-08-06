import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';

export enum WsMessageType {
  DROP_UPDATE = 'DROP_UPDATE',
  DROP_UPDATE_REF = 'DROP_UPDATE_REF',
  DROP_DELETE = 'DROP_DELETE',
  DROP_RATING_UPDATE = 'DROP_RATING_UPDATE',
  DROP_REACTION_UPDATE = 'DROP_REACTION_UPDATE',
  USER_IS_TYPING = 'USER_IS_TYPING',
  SUBSCRIBE_TO_WAVE = 'SUBSCRIBE_TO_WAVE',
  AUTHENTICATE = 'AUTHENTICATE',
  AUTHENTICATED = 'AUTHENTICATED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  SYNC_NOTIFICATION_IDENTITIES = 'SYNC_NOTIFICATION_IDENTITIES',
  NOTIFICATION_IDENTITIES_SYNCED = 'NOTIFICATION_IDENTITIES_SYNCED',
  IDENTITY_NOTIFICATIONS_CHANGED = 'IDENTITY_NOTIFICATIONS_CHANGED',
  MEDIA_LINK_UPDATED = 'MEDIA_LINK_UPDATED',
  ATTACHMENT_STATUS_UPDATE = 'ATTACHMENT_STATUS_UPDATE'
}

export interface WsMessage<MESSAGE_DATA> {
  type: WsMessageType;
  data: MESSAGE_DATA;
  reason?: string;
}

export const DROP_UPDATE_REASON_POLL_RESPONSE = 'POLL_RESPONSE';
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

export type DropUpdateRefType =
  | WsMessageType.DROP_UPDATE
  | WsMessageType.DROP_RATING_UPDATE
  | WsMessageType.DROP_REACTION_UPDATE;

export function dropUpdateMessage(
  data: ApiDrop,
  reason?: string
): WsMessage<ApiDrop> {
  const message: WsMessage<ApiDrop> = {
    type: WsMessageType.DROP_UPDATE,
    data
  };
  if (reason !== undefined) {
    message.reason = reason;
  }
  return message;
}

export interface DropUpdateRefMessageData {
  readonly drop_id: string;
  readonly wave_id: string;
  readonly author_id: string;
  readonly serial_no: number;
  readonly update_type: DropUpdateRefType;
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

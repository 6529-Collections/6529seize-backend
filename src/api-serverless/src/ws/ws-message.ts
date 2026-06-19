import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';

export enum WsMessageType {
  DROP_UPDATE = 'DROP_UPDATE',
  DROP_DELETE = 'DROP_DELETE',
  DROP_RATING_UPDATE = 'DROP_RATING_UPDATE',
  DROP_REACTION_UPDATE = 'DROP_REACTION_UPDATE',
  USER_IS_TYPING = 'USER_IS_TYPING',
  SUBSCRIBE_TO_WAVE = 'SUBSCRIBE_TO_WAVE',
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

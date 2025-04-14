import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';

export enum WsMessageType {
  DROP_UPDATE = 'DROP_UPDATE',
  DROP_DELETE = 'DROP_DELETE',
  DROP_RATING_UPDATE = 'DROP_RATING_UPDATE',
  USER_IS_TYPING = 'USER_IS_TYPING',
  SUBSCRIBE_TO_WAVE = 'SUBSCRIBE_TO_WAVE'
}

export interface WsMessage<MESSAGE_DATA> {
  type: WsMessageType;
  data: MESSAGE_DATA;
}

export function dropUpdateMessage(data: ApiDrop): WsMessage<ApiDrop> {
  return {
    type: WsMessageType.DROP_UPDATE,
    data
  };
}

export function dropRatingUpdateMessage(data: ApiDrop): WsMessage<ApiDrop> {
  return {
    type: WsMessageType.DROP_RATING_UPDATE,
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

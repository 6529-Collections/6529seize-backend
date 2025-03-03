import { ApiDrop } from '../generated/models/ApiDrop';

export enum WsMessageType {
  DROP_UPDATE = 'DROP_UPDATE',
  DROP_DELETE = 'DROP_DELETE'
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

export function dropDeleteMessage(
  data: DropDeleteMessageData
): WsMessage<DropDeleteMessageData> {
  return {
    type: WsMessageType.DROP_DELETE,
    data
  };
}

export interface DropDeleteMessageData {
  readonly drop_id: string;
  readonly wave_id: string;
  readonly drop_serial: number;
}

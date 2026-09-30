/** Resource references are resolved after commit; deleted resources retain only routing metadata. */
export type WebSocketOutboxEvent =
  | {
      type: 'drop';
      dropId: string;
      updateType: 'DROP_UPDATE' | 'DROP_RATING_UPDATE' | 'DROP_REACTION_UPDATE';
      reason?: string;
    }
  | { type: 'drop-delete'; dropId: string; waveId: string; serialNo: number }
  | { type: 'identity'; profileId: string }
  | { type: 'dm'; profileIds: string[]; waveId: string }
  | { type: 'delivery'; connectionId: string; message: string }
  | { type: 'media'; uploadId: string }
  | { type: 'attachment'; attachmentId: string }
  | { type: 'nft'; canonicalId: string };

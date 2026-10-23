import { createHash } from 'node:crypto';
import { WebSocketOutboxEvent } from './events';

/** A connection's older recipient job must be accepted before its next one. */
export function webSocketOutboxPartition(event: WebSocketOutboxEvent): string {
  let key: string;
  switch (event.type) {
    case 'delivery':
      key = `connection:${event.connectionId}`;
      break;
    case 'drop':
    case 'drop-delete':
      key = `drop:${event.dropId}`;
      break;
    case 'identity':
      key = `identity:${event.profileId}`;
      break;
    case 'dm':
      key = `dm:${event.waveId}`;
      break;
    case 'attachment':
      key = `attachment:${event.attachmentId}`;
      break;
    case 'nft':
      key = `nft:${event.canonicalId}`;
      break;
    case 'media':
      key = `media:${event.uploadId}`;
      break;
  }
  // Ordering keys must remain stable across days and deployments; never use diagnostic hash rotation here.
  return createHash('sha256').update(key).digest('hex');
}

import { Logger } from '@/logging';
import { appWebSockets, AppWebSockets } from '@/api/ws/ws';
import { WsMessage, WsMessageType } from '@/api/ws/ws-message';
import {
  NotificationConnectionRecipient,
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';

/**
 * Read-state sync (waves plan 1.7). Off unless `WS_READ_STATE_SYNC=true`:
 * staging turns it on, production waits for the owner. When off, marking a
 * wave read behaves exactly as before.
 */
export const READ_STATE_SYNC_ENV = 'WS_READ_STATE_SYNC';

export function isReadStateSyncEnabled(): boolean {
  return process.env[READ_STATE_SYNC_ENV] === 'true';
}

/**
 * `READ_STATE` frame payload.
 *
 * - Sent to every notification connection of `profile_id`, including the tab
 *   that made the change, and only when the stored watermark changed.
 * - Drops with `serial_no > latest_read_serial_no` are unread.
 * - `version` strictly increases per (profile, wave). Frames can arrive out
 *   of order, so clients apply one only when its version is newer than the
 *   last they applied. Mark-unread moves the watermark backwards with a newer
 *   version.
 * - Clients ignore frames whose `profile_id` is not the active profile.
 */
export interface ReadStateFrameData {
  readonly profile_id: string;
  readonly wave_id: string;
  readonly latest_read_serial_no: number;
  readonly latest_read_timestamp: number;
  readonly version: number;
}

export function readStateMessage(
  data: ReadStateFrameData
): WsMessage<ReadStateFrameData> {
  return { type: WsMessageType.READ_STATE, data };
}

export class ReadStateNotifier {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly listeners: Pick<
      WsListenersNotifier,
      'findConnectedNotificationRecipients'
    >,
    private readonly sockets: Pick<AppWebSockets, 'send'>
  ) {}

  /** Best effort: the read is already stored, so a failed frame is logged. */
  async notify(
    data: ReadStateFrameData,
    resolvedRecipients?: readonly NotificationConnectionRecipient[]
  ): Promise<void> {
    try {
      const recipients = (
        resolvedRecipients ??
        (await this.listeners.findConnectedNotificationRecipients([
          data.profile_id
        ]))
      ).filter((recipient) => recipient.identityId === data.profile_id);
      if (!recipients.length) return;
      const message = JSON.stringify(readStateMessage(data));
      await Promise.all(
        recipients.map(({ connectionId }) =>
          this.sockets.send({ connectionId, message })
        )
      );
    } catch (error) {
      this.logger.error(
        `Sending READ_STATE failed for wave ${data.wave_id}`,
        error
      );
    }
  }
}

export const readStateNotifier = new ReadStateNotifier(
  wsListenersNotifier,
  appWebSockets
);

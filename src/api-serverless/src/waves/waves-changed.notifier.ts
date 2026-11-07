import { Logger } from '@/logging';
import { forEachConcurrent } from '@/for-each-concurrent';
import { appWebSockets, AppWebSockets } from '@/api/ws/ws';
import {
  wsConnectionRepository,
  WsConnectionRepository
} from '@/api/ws/ws-connection.repository';
import { wsFanoutConcurrency } from '@/api/ws/ws-fanout-settings';
import { wavesChangedMessage, WavesChangedReason } from '@/api/ws/ws-message';

export interface WavesChange {
  readonly profileId: string;
  readonly waveIds: readonly string[];
  readonly reason: WavesChangedReason;
}

/**
 * Sends `WAVES_CHANGED` (FRAME-CONTRACTS §5, waves 1.3) to every connection
 * of each changed profile, including connections that sync it as a
 * notification identity, so the client refetches that profile's wave list.
 * With the narrower audience, this is how a newly followed or added wave
 * reaches the sidebar. Not flagged. Best effort: it never fails the change.
 */
export class WavesChangedNotifier {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly connections: Pick<
      WsConnectionRepository,
      'findNotificationConnectionIdsByIdentityIds'
    > = wsConnectionRepository,
    private readonly sockets: Pick<AppWebSockets, 'send'> = appWebSockets
  ) {}

  async notify(changes: readonly WavesChange[]): Promise<void> {
    const byProfile = new Map<string, WavesChange[]>();
    for (const change of changes) {
      if (!change.profileId || !change.waveIds.length) continue;
      byProfile.set(change.profileId, [
        ...(byProfile.get(change.profileId) ?? []),
        change
      ]);
    }
    if (!byProfile.size) return;
    try {
      const recipients =
        await this.connections.findNotificationConnectionIdsByIdentityIds(
          Array.from(byProfile.keys())
        );
      await forEachConcurrent(
        recipients.flatMap((recipient) =>
          (byProfile.get(recipient.identityId) ?? []).map((change) => ({
            connectionId: recipient.connectionId,
            // The stored JWT expiry, when this lookup returns it, saves a
            // fence read on send; versions without it still send.
            jwtExpiry: (recipient as { jwtExpiry?: number }).jwtExpiry,
            change
          }))
        ),
        async ({ connectionId, jwtExpiry, change }) => {
          await this.sockets.send({
            connectionId,
            ...(jwtExpiry === undefined ? {} : { jwtExpiry }),
            message: JSON.stringify(
              wavesChangedMessage({
                profile_id: change.profileId,
                wave_ids: [...change.waveIds],
                reason: change.reason
              })
            )
          });
        },
        { concurrency: wsFanoutConcurrency() }
      );
    } catch (error) {
      this.logger.error(
        `Sending WAVES_CHANGED failed for ${byProfile.size} profile(s)`,
        error
      );
    }
  }
}

export const wavesChangedNotifier = new WavesChangedNotifier();

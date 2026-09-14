import { AuthenticationContext } from '@/auth-context';
import { dropsService } from '@/api/drops/drops.api.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { Logger } from '@/logging';
import { Timer } from '@/time';

export async function broadcastDropModerationChange(
  dropId: string,
  timer: Timer
): Promise<void> {
  try {
    const authenticationContext = AuthenticationContext.notAuthenticated();
    const drop = await dropsService.findDropByIdOrThrow(
      { dropId, skipEligibilityCheck: true },
      { timer, authenticationContext }
    );
    await wsListenersNotifier.notifyAboutDropUpdate(
      drop,
      { timer, authenticationContext },
      { reason: 'CONTENT_MODERATION', useSystemBroadcastAudience: true }
    );
  } catch {
    Logger.get('ContentModerationBroadcast').error(
      'Failed to broadcast a moderation state change'
    );
  }
}

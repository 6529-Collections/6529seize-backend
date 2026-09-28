import { CompetitionEntryService } from './competition-entry.service';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { sendIdentityPushNotificationsStrict } from '@/api/push-notifications/push-notifications.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { dropsService } from '@/api/drops/drops.api.service';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { competitionDeliveryErrorCode } from '@/competitions/competition-delivery-diagnostics';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn()
}));
jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotificationsStrict: jest.fn(),
  sendIdentityPushNotifications: jest.fn(),
  sendIdentityPushNotification: jest.fn()
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: { notifyAboutDropUpdate: jest.fn() }
}));
jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: { findDropByIdOrThrow: jest.fn() }
}));

describe('committed native entry delivery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('attempts push and socket refresh after cache failure without leaking provider payloads', async () => {
    const service = new CompetitionEntryService() as unknown as {
      afterCreate(
        dropId: string,
        waveId: string,
        ids: number[],
        ctx: RequestContext
      ): Promise<void>;
    };
    const warn = jest
      .spyOn(Logger.get('CompetitionEntryService'), 'warn')
      .mockImplementation(() => undefined);
    jest
      .mocked(invalidateWaveUnreadCacheForWave)
      .mockRejectedValue(
        Object.assign(new Error('private cache payload'), { code: 'ETIMEDOUT' })
      );
    jest.mocked(sendIdentityPushNotificationsStrict).mockRejectedValue(
      Object.assign(new Error('private signed request'), {
        code: 'PUSH_QUEUE_PARTIAL_FAILURE'
      })
    );
    jest
      .mocked(dropsService.findDropByIdOrThrow)
      .mockResolvedValue({ id: 'drop' } as Awaited<
        ReturnType<typeof dropsService.findDropByIdOrThrow>
      >);
    jest
      .mocked(wsListenersNotifier.notifyAboutDropUpdate)
      .mockResolvedValue(undefined);
    await expect(
      service.afterCreate('drop', 'wave', [17], {})
    ).resolves.toBeUndefined();
    expect(sendIdentityPushNotificationsStrict).toHaveBeenCalledWith([17]);
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      { id: 'drop' },
      {}
    );
    expect(warn.mock.calls).toEqual([
      [
        'Native entry committed; shared chat notification delivery failed',
        { drop_id: 'drop', stage: 'unread_cache', error_code: 'ETIMEDOUT' }
      ],
      [
        'Native entry committed; shared chat notification delivery failed',
        {
          drop_id: 'drop',
          stage: 'push_handoff',
          error_code: 'PUSH_QUEUE_PARTIAL_FAILURE'
        }
      ]
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('does not log arbitrary provider codes, names, messages or throwing accessors', () => {
    expect(
      competitionDeliveryErrorCode({
        code: 'private signed payload',
        name: 'private bearer token'
      })
    ).toBe('UNKNOWN');
    expect(
      competitionDeliveryErrorCode({
        get code() {
          throw new Error('private payload');
        }
      })
    ).toBe('UNKNOWN');
    expect(competitionDeliveryErrorCode('private payload')).toBe('UNKNOWN');
  });
});

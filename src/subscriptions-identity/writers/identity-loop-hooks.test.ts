import { Logger } from '@/logging';
import { subscriptionsIdentitySwitch } from '../identity/identity-switch';
import { runLegacySubscriptionStep } from './identity-loop-hooks';

describe('runLegacySubscriptionStep', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const failing = () => Promise.reject(new Error('legacy step failed'));

  it('alerts and goes on when the legacy step fails after the switch', async () => {
    jest
      .spyOn(subscriptionsIdentitySwitch, 'writeModeForLegacy')
      .mockResolvedValue('TRUTH');
    const alert = jest
      .spyOn(Logger.prototype, 'errorWithCode')
      .mockImplementation(() => undefined);

    await expect(
      runLegacySubscriptionStep('REDEMPTIONS', failing)
    ).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledWith(
      'SUBSCRIPTIONS_LEGACY_DUAL_WRITE_FAILED',
      expect.stringContaining('[LEGACY REDEMPTIONS FAILED]'),
      expect.any(Error)
    );
  });

  it.each(['SHADOW', 'OFF'] as const)(
    'fails the run when the legacy step fails in %s, as before',
    async (mode) => {
      jest
        .spyOn(subscriptionsIdentitySwitch, 'writeModeForLegacy')
        .mockResolvedValue(mode);

      await expect(
        runLegacySubscriptionStep('TOP-UPS', failing)
      ).rejects.toThrow('legacy step failed');
    }
  );

  it('runs the step once in every mode', async () => {
    for (const mode of ['TRUTH', 'SHADOW', 'OFF'] as const) {
      jest
        .spyOn(subscriptionsIdentitySwitch, 'writeModeForLegacy')
        .mockResolvedValue(mode);
      const step = jest.fn().mockResolvedValue(undefined);
      await runLegacySubscriptionStep('TOP-UPS', step);
      expect(step).toHaveBeenCalledTimes(1);
    }
  });
});

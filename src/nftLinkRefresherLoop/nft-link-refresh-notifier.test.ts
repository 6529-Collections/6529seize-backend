import { NftLinkRefreshNotifier } from '@/nftLinkRefresherLoop/nft-link-refresh-notifier';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { withNftLinkResolutionBudget } from '@/nft-links/resolution-budget';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

const data = { canonical_id: 'test-link' } as ApiNftLinkData;
const recipient = (index: number) => ({
  connection_id: `connection-${index}`,
  jwt_expiry: Math.floor(Date.now() / 1000) + 60
});

describe('NFT link refresh notifications', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts stalled sends and stops dequeuing recipients after 15 seconds', async () => {
    const signals: AbortSignal[] = [];
    const send = jest.fn(
      (_id: string, _message: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          });
        });
      }
    );
    const notifier = new NftLinkRefreshNotifier(
      async () => Array.from({ length: 35 }, (_, i) => recipient(i)),
      send
    );
    const operation = notifier.notifyAboutNftLinkUpdate(data);
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(10);
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(operation).resolves.toBeUndefined();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(send).toHaveBeenCalledTimes(10);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('honors the earlier resolution deadline and sends nothing after a late recipient read', async () => {
    let resolveRecipients:
      | ((value: ReturnType<typeof recipient>[]) => void)
      | undefined;
    const send = jest.fn();
    const notifier = new NftLinkRefreshNotifier(
      () =>
        new Promise((resolve) => {
          resolveRecipients = resolve;
        }),
      send
    );
    const operation = withNftLinkResolutionBudget(200, () =>
      notifier.notifyAboutNftLinkUpdate(data)
    );
    await jest.advanceTimersByTimeAsync(200);
    await operation;
    resolveRecipients!([recipient(1)]);
    await jest.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('continues past disconnected clients, respects JWT expiry, and clears timers on success', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('GoneException'))
      .mockResolvedValue(undefined);
    const expired = {
      ...recipient(3),
      jwt_expiry: Math.floor(Date.now() / 1000) - 1
    };
    const notifier = new NftLinkRefreshNotifier(
      async () => [recipient(1), recipient(2), expired],
      send
    );
    await notifier.notifyAboutNftLinkUpdate(data);
    expect(send.mock.calls.map(([id]) => id)).toEqual([
      'connection-1',
      'connection-2'
    ]);
    expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({
      type: 'MEDIA_LINK_UPDATED',
      data
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});

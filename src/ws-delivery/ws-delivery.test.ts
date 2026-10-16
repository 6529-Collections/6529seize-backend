const mockWarn = jest.fn();
const mockError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      warn: mockWarn,
      error: mockError,
      errorWithDiagnostic: mockError
    })
  }
}));

import { WebSocketDelivery } from './ws-delivery';
import { DeliveryClaim, DeliverySnapshot } from './ws-delivery-store';

const acquired: DeliveryClaim = {
  acquired: true,
  revision: 0,
  failures: 0,
  firstFailureAt: 0,
  canReconnect: true
};
const error429 = {
  name: 'LimitExceededException',
  $metadata: { httpStatusCode: 429, attempts: 3 }
};

describe('shared WebSocket delivery', () => {
  const store = {
    claim: jest.fn(),
    finish: jest.fn(),
    snapshot: jest.fn(),
    forget: jest.fn(),
    enableReconnect: jest.fn()
  };
  const delivery = new WebSocketDelivery(store);
  const send = jest.fn();
  const close = jest.fn();
  const input = {
    connectionId: 'private-connection',
    message: '{"type":"COMPETITION_UPDATE","data":{"private":"never-log"}}',
    send,
    close
  };

  beforeEach(() => {
    jest.resetAllMocks();
    store.claim.mockResolvedValue(acquired);
    store.finish.mockResolvedValue(true);
    store.forget.mockResolvedValue(undefined);
    send.mockResolvedValue({});
    close.mockResolvedValue(undefined);
  });
  it('returns an explicit successful outcome', async () => {
    await expect(delivery.deliver(input)).resolves.toEqual({ status: 'sent' });
    expect(store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'sent' })
    );
  });
  it('queues exhausted 429s with one warning and no error alert', async () => {
    send.mockRejectedValue(error429);
    await expect(delivery.deliver(input)).resolves.toEqual({
      status: 'resync_pending'
    });
    expect(mockError).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        frame_type: 'COMPETITION_UPDATE',
        http_status: 429
      })
    );
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(
      /private-connection|never-log/
    );
    expect(close).not.toHaveBeenCalled();
    store.finish.mockResolvedValue(false);
    await delivery.deliver(input);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
  it('does not contact AWS for a connection in cooldown', async () => {
    store.claim.mockResolvedValue({ ...acquired, acquired: false });
    await expect(delivery.deliver(input)).resolves.toEqual({
      status: 'resync_pending'
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('does not promise a scheduled retry if saving the pending work failed', async () => {
    send.mockRejectedValue(error429);
    store.finish.mockRejectedValue(new Error('store down'));
    await expect(delivery.deliver(input)).resolves.toEqual({
      status: 'failed'
    });
  });
  it('can still send while the recovery store is unavailable', async () => {
    store.claim.mockRejectedValue(new Error('Redis down'));
    await expect(delivery.deliver(input)).resolves.toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves alerts for AWS permission failures without deleting a live listener', async () => {
    send.mockRejectedValue({ $metadata: { httpStatusCode: 403 } });
    await expect(delivery.deliver(input)).resolves.toEqual({
      status: 'failed'
    });
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ http_status: 403 })
    );
    expect(close).not.toHaveBeenCalled();
  });
  it('marks an already-disconnected listener as gone', async () => {
    send.mockRejectedValue({
      name: 'GoneException',
      $metadata: { httpStatusCode: 410 }
    });
    await expect(delivery.deliver(input)).resolves.toEqual({ status: 'gone' });
    expect(mockError).not.toHaveBeenCalled();
  });
  it('closes an isolated blocked listener only after AWS confirms closure', async () => {
    store.claim.mockResolvedValue({
      ...acquired,
      failures: 3,
      firstFailureAt: Date.now() - 180_000
    });
    store.snapshot.mockResolvedValue({
      healthyConnections: 10,
      recentlyHealthyConnections: 10,
      throttledConnections: 1,
      pending: 1
    } satisfies Partial<DeliverySnapshot>);
    await expect(
      delivery.deliver({ ...input, recovery: true })
    ).resolves.toEqual({ status: 'gone' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it('never closes legacy listeners during recovery or a failed authentication acknowledgement', async () => {
    store.claim.mockResolvedValue({
      ...acquired,
      canReconnect: false,
      failures: 3,
      firstFailureAt: Date.now() - 180_000
    });
    await expect(
      delivery.deliver({ ...input, recovery: true })
    ).resolves.toEqual({ status: 'sent' });
    send.mockRejectedValue(error429);
    await expect(
      delivery.deliver({ ...input, message: '{"type":"AUTHENTICATED"}' })
    ).resolves.toEqual({ status: 'resync_pending' });
    expect(close).not.toHaveBeenCalled();
    expect(store.forget).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });
  it('keeps the subscription and tries recovery if closing a listener fails', async () => {
    store.claim.mockResolvedValue({
      ...acquired,
      failures: 3,
      firstFailureAt: Date.now() - 180_000
    });
    store.snapshot.mockResolvedValue({
      healthyConnections: 10,
      recentlyHealthyConnections: 10,
      throttledConnections: 1,
      pending: 1
    });
    close.mockRejectedValue(new Error('AWS refused closure'));
    await expect(
      delivery.deliver({ ...input, recovery: true })
    ).resolves.toEqual({ status: 'sent' });
    expect(store.finish).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'gone' })
    );
  });
  it('prioritizes authentication acknowledgements and closes only an unacknowledged transport', async () => {
    send.mockRejectedValue(error429);
    const authInput = {
      ...input,
      message: '{"type":"AUTHENTICATED","data":{}}'
    };
    await expect(delivery.deliver(authInput)).resolves.toEqual({
      status: 'gone'
    });
    expect(store.claim).toHaveBeenCalledWith(
      input.connectionId,
      expect.any(String),
      false,
      expect.any(Number),
      true
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(store.forget).toHaveBeenCalledWith(input.connectionId);
    expect(mockError).not.toHaveBeenCalled();
  });
  it('does not report an intentional deadline cancellation as an application error', async () => {
    const controller = new AbortController();
    send.mockImplementation(async () => {
      controller.abort();
      throw new Error('deadline');
    });
    await expect(
      delivery.deliver({ ...input, signal: controller.signal })
    ).resolves.toEqual({ status: 'failed' });
    expect(mockError).not.toHaveBeenCalled();
  });
});

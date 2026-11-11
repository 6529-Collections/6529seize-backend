import { WsConnectionPurpose } from '@/entities/IWSConnection';
import {
  recordSocketLifecycle,
  socketPurposeLabel
} from './ws-socket-lifecycle';

describe('socket lifecycle telemetry', () => {
  const originalFunction = process.env.AWS_LAMBDA_FUNCTION_NAME;
  let write: jest.SpyInstance;

  beforeEach(() => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    write.mockRestore();
    if (originalFunction === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = originalFunction;
    }
  });

  const emitted = () => JSON.parse(String(write.mock.calls[0][0]));

  it('labels sockets without a declared purpose as app sockets', () => {
    expect(socketPurposeLabel(null)).toBe('app');
    expect(socketPurposeLabel(undefined)).toBe('app');
    expect(socketPurposeLabel(WsConnectionPurpose.TYPING)).toBe('typing');
  });

  it('counts a registration by purpose and authentication', () => {
    recordSocketLifecycle({
      event: 'Registered',
      purpose: 'typing',
      authenticated: false
    });
    const record = emitted();
    expect(record._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: '6529/WebSocketConnections',
      Dimensions: [['Environment', 'Purpose', 'Authenticated']],
      Metrics: [{ Name: 'Registered', Unit: 'Count' }]
    });
    expect(record).toMatchObject({
      Purpose: 'typing',
      Authenticated: 'false',
      Registered: 1
    });
    expect(record).not.toHaveProperty('LifetimeMs');
  });

  it('records the lifetime of a deregistered socket', () => {
    recordSocketLifecycle({
      event: 'Deregistered',
      purpose: 'app',
      authenticated: true,
      lifetimeMs: 812.6
    });
    const record = emitted();
    expect(record._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: 'Deregistered', Unit: 'Count' },
      { Name: 'LifetimeMs', Unit: 'Milliseconds' }
    ]);
    expect(record).toMatchObject({
      Purpose: 'app',
      Authenticated: 'true',
      Deregistered: 1,
      LifetimeMs: 813
    });
  });

  it('emits nothing outside Lambda', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    recordSocketLifecycle({
      event: 'Registered',
      purpose: 'app',
      authenticated: true
    });
    expect(write).not.toHaveBeenCalled();
  });
});

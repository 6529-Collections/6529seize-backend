import { createClient } from 'redis';
import { Logger } from '@/logging';
import { initRedis } from '@/redis';

jest.mock('redis', () => ({ createClient: jest.fn() }));
jest.mock('@/logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      errorWithDiagnostic: jest.fn()
    }))
  }
}));

it('reports known reconnect failures as pending, escalates repeated failures, and resets on readiness', async () => {
  const original = { ...process.env };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const client = {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) =>
      listeners.set(event, listener)
    ),
    connect: jest.fn().mockResolvedValue(undefined)
  };
  jest
    .mocked(createClient)
    .mockReturnValue(client as unknown as ReturnType<typeof createClient>);
  process.env.REDIS_URL = 'localhost';
  process.env.REDIS_PORT = '6379';
  process.env.FORCE_AVOID_REDIS = 'false';
  try {
    await initRedis({ reportConnectionRecovery: true });
    const error = Object.assign(new Error('write ECONNRESET'), {
      code: 'ECONNRESET'
    });
    const emitError = listeners.get('error')!;
    emitError(error);
    emitError(error);
    emitError(error);
    listeners.get('ready')!();
    emitError(error);
    emitError(new Error('WRONGPASS'));
    const logger = jest.mocked(Logger.get).mock.results[0].value as Logger;
    const diagnostics = jest
      .mocked(logger.errorWithDiagnostic)
      .mock.calls.map(([diagnostic]) => diagnostic);
    expect(diagnostics.map((diagnostic) => diagnostic.recovery?.state)).toEqual(
      ['pending', 'pending', 'unknown', 'pending', 'unknown']
    );
    expect(diagnostics[0].category).toBe('NETWORK');
    expect(diagnostics[3].recovery?.attempt).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    process.env = original;
  }
});

const callOrder: string[] = [];
const mockPrepEnvironment = jest.fn(async () => {
  callOrder.push('secrets');
  process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY = 'private-key';
});
const mockConnect = jest.fn(async () => {
  callOrder.push('database');
});
const mockDisconnect = jest.fn(async () => undefined);
const mockListTrains = jest.fn(async () => {
  callOrder.push('repository');
  return [];
});
const mockListReleaseBusRefs = jest.fn(async () => {
  callOrder.push('github');
  expect(process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY).toBe('private-key');
  return [];
});
const mockListReleaseBusV2Refs = jest.fn(async () => {
  callOrder.push('github-v2');
  expect(process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY).toBe('private-key');
  return [];
});
const mockPruneTerminalHistory = jest.fn(async (cutoffAt: number) => {
  callOrder.push('history');
  expect(cutoffAt).toBeGreaterThan(0);
  expect(cutoffAt).toBeLessThan(Date.now());
  return { trains: 0, candidates: 0 };
});

jest.mock('@/env', () => ({ prepEnvironment: mockPrepEnvironment }));
jest.mock('@/db', () => ({
  connect: mockConnect,
  disconnect: mockDisconnect
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: jest.fn(() => ({ info: jest.fn() }))
  }
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));
jest.mock('@/entities/entities', () => ({}));
jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    listTrains: mockListTrains
  }
}));
jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    listReleaseBusRefs: mockListReleaseBusRefs,
    listReleaseBusV2Refs: mockListReleaseBusV2Refs
  }
}));
jest.mock('@/releaseBusV2/release-bus-v2.repository', () => ({
  releaseBusV2Repository: {
    listTrains: mockListTrains
  }
}));
jest.mock('@/releaseBusV2/release-bus-v2.reconciler', () => ({
  releaseBusV2Branch: jest.fn(),
  releaseBusV2Reconciler: { runOnce: jest.fn() }
}));
jest.mock('@/releaseBus/release-bus.service', () => ({
  releaseBusService: {
    pruneTerminalHistory: mockPruneTerminalHistory
  }
}));
jest.mock('@/releaseBus/release-bus.metrics', () => ({
  publishReleaseBusMetrics: jest.fn()
}));

import { cleanerHandler } from '@/releaseBus';

describe('Release Bus handler secret ordering', () => {
  const previousPrivateKey = process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY;

  beforeEach(() => {
    callOrder.length = 0;
    jest.clearAllMocks();
    delete process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY;
  });

  afterAll(() => {
    if (previousPrivateKey === undefined)
      delete process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY;
    else process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY = previousPrivateKey;
  });

  it('completes secret bootstrap before the first repository or GitHub call', async () => {
    await cleanerHandler({} as never, {} as never, jest.fn());

    expect(callOrder).toEqual([
      'secrets',
      'database',
      'repository',
      'repository',
      'github',
      'github-v2',
      'github',
      'github-v2',
      'history'
    ]);
  });
});

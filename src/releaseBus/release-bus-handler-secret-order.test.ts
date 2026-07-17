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
    listReleaseBusRefs: mockListReleaseBusRefs
  }
}));
jest.mock('@/releaseBus/release-bus.service', () => ({
  releaseBusService: {}
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
      'github',
      'github'
    ]);
  });
});

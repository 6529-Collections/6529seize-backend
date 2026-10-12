import { handleGetCollectCapabilities } from './collect.handlers';
import { ApiCollectCapabilityActionEnum as Action } from '@/api/generated/models/ApiCollectCapability';
jest.mock('@/collecting/collecting.service', () => ({ collectingService: {} }));

describe('ordinary RPC marketplace capability configuration', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.OPENSEA_API_KEY;
    delete process.env.MARKETPLACE_TRADING_ENABLED;
  });
  afterEach(() => {
    process.env = originalEnv;
  });
  function capabilities() {
    return handleGetCollectCapabilities(
      {} as Parameters<typeof handleGetCollectCapabilities>[0]
    ).actions;
  }
  it('enables cancellation with ordinary RPC alone, independently of the trading flag', () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    process.env.MARKETPLACE_TRADING_ENABLED = 'false';
    expect(capabilities()).toContainEqual(
      expect.objectContaining({ action: Action.Cancel, enabled: true })
    );
    expect(
      capabilities()
        .filter((value) => value.enabled)
        .map((value) => value.action)
    ).toEqual(expect.arrayContaining([Action.Cancel, Action.TdhScenario]));
  });
  it('enables manual trading with RPC and OpenSea, without an Alchemy key', () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    process.env.OPENSEA_API_KEY = 'test-opensea';
    expect(
      capabilities()
        .filter((value) => !value.enabled)
        .map((value) => value.action)
    ).toEqual([Action.RuleExecution]);
  });
  it('does not treat an Alchemy key as ordinary RPC configuration', () => {
    process.env.ALCHEMY_API_KEY = 'indexed-only';
    process.env.OPENSEA_API_KEY = 'test-opensea';
    expect(
      capabilities()
        .filter((value) => value.enabled)
        .map((value) => value.action)
    ).toEqual([Action.TdhScenario]);
  });
});

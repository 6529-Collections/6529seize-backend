import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import {
  FakeChain,
  FakeClock,
  FakeIndexDb
} from '@/tests/fixtures/waves-chain-index.fixture';
import { indexChainWavesBestEffort } from '@/waveDecisionExecutionLoop/waves-chain-index-step';
import { WavesChainIndex } from './waves-chain-index.service';

const BIG = 1_000_000;
const ENV = [
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'FEATURE_WAVES_CHAIN_INDEX'
];

const routeMissing = () =>
  new ChainGatewayError(
    '/v1/waves/import: not_held: no such route',
    404,
    'not_held',
    '/v1/waves/import'
  );

describe('the chain index on a gateway without /v1/waves/import', () => {
  const original = Object.fromEntries(
    ENV.map((name) => [name, process.env[name]])
  );
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let clock: FakeClock;
  let chain: FakeChain;
  let index: WavesChainIndex;
  let db: FakeIndexDb;
  let importState: jest.SpyInstance;

  /** The switch-on a minute from the fake clock's now, or a minute ago. */
  const switchOn = (fromNowMs: number) => {
    process.env.WAVES_SWITCH_ON_AT = new Date(
      clock.now() + fromNowMs
    ).toISOString();
  };
  const waits = () =>
    warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[WAVES CHAIN INDEX WAITS]'));

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    for (const name of ENV) delete process.env[name];
    clock = new FakeClock();
    chain = new FakeChain(clock);
    db = new FakeIndexDb();
    index = new WavesChainIndex(chain, db.asDb(), clock.now);
    // The gateway's answer to GET /v1/waves/import: a failure.
    importState = jest
      .spyOn(chain, 'importState')
      .mockRejectedValue(routeMissing());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('waits before the switch-on: one warning, no error, nothing else read', async () => {
    switchOn(60_000);
    for (let run = 0; run < 3; run++) {
      await expect(index.run({ budgetMs: BIG })).resolves.toMatchObject({
        mode: 'skipped',
        skipped: 'import_route_missing'
      });
    }
    expect(waits()).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    // Each run reads the head and the import, and nothing more.
    expect(importState).toHaveBeenCalledTimes(3);
    expect(chain.calls).toBe(3);
    expect(db.state.generation).toBe(0);
  });

  it('is an error from the switch-on, in the same process, every run', async () => {
    process.env.FEATURE_WAVES_CHAIN_INDEX = 'true';
    switchOn(60_000);
    await indexChainWavesBestEffort(undefined, index);
    expect(error).not.toHaveBeenCalled();
    clock.t += 60_000;
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow('no such route');
    for (let run = 0; run < 2; run++) {
      await indexChainWavesBestEffort(undefined, index);
    }
    const failed = error.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[WAVES CHAIN INDEX FAILED]'));
    expect(failed).toHaveLength(2);
    expect(failed[0]).toContain('/v1/waves/import: not_held: no such route');
    expect(waits()).toHaveLength(1);
  });

  it('is an error with FEATURE_WAVES_ON_CHAIN, and with no switch-on set it waits', async () => {
    await expect(index.run({ budgetMs: BIG })).resolves.toMatchObject({
      skipped: 'import_route_missing'
    });
    process.env.FEATURE_WAVES_ON_CHAIN = 'true';
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow('no such route');
  });

  it('still fails on any other gateway failure before the switch-on', async () => {
    switchOn(60_000);
    importState.mockRejectedValue(
      new ChainGatewayError(
        '/v1/waves/import: unavailable',
        503,
        'unavailable',
        '/v1/waves/import'
      )
    );
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow('unavailable');
    importState.mockRejectedValue(
      new ChainGatewayError(
        "/v1/waves/import: not_held: this node didn't save day 5",
        404,
        'not_held',
        '/v1/waves/import'
      )
    );
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow('day 5');
    expect(waits()).toEqual([]);
  });
});

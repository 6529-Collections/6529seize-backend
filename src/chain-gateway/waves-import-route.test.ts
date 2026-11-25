import { Logger } from '@/logging';
import { ChainGatewayError } from './chain-gateway.client';
import {
  isWavesImportRouteMissing,
  WavesImportRouteWait,
  wavesSwitchedOnAt
} from './waves-import-route';

const SWITCH_ON = '2026-11-28T00:00:00Z';
const SWITCH_ON_MS = Date.UTC(2026, 10, 28);

const routeMissing = (path = '/v1/waves/import') =>
  new ChainGatewayError(
    `${path}: not_held: no such route`,
    404,
    'not_held',
    path
  );

describe('isWavesImportRouteMissing', () => {
  it("is the gateway's no such route for /v1/waves/import, and nothing else", () => {
    expect(isWavesImportRouteMissing(routeMissing())).toBe(true);
    expect(
      isWavesImportRouteMissing(routeMissing('/v1/waves/import?at=head'))
    ).toBe(true);
    // Another route, another not_held, another failure.
    expect(isWavesImportRouteMissing(routeMissing('/v1/decisions/due'))).toBe(
      false
    );
    expect(
      isWavesImportRouteMissing(
        new ChainGatewayError(
          "/v1/waves/import: not_held: this node didn't save day 5",
          404,
          'not_held',
          '/v1/waves/import'
        )
      )
    ).toBe(false);
    expect(
      isWavesImportRouteMissing(
        new ChainGatewayError(
          '/v1/waves/import: unavailable',
          503,
          'unavailable',
          '/v1/waves/import'
        )
      )
    ).toBe(false);
    expect(isWavesImportRouteMissing(new Error('no such route'))).toBe(false);
  });
});

describe('wavesSwitchedOnAt', () => {
  it('reads WAVES_SWITCH_ON_AT at the time given, or FEATURE_WAVES_ON_CHAIN', () => {
    const env = { WAVES_SWITCH_ON_AT: SWITCH_ON };
    expect(wavesSwitchedOnAt(SWITCH_ON_MS - 1, env)).toBe(false);
    expect(wavesSwitchedOnAt(SWITCH_ON_MS, env)).toBe(true);
    expect(
      wavesSwitchedOnAt(SWITCH_ON_MS, { WAVES_SWITCH_ON_AT: `${SWITCH_ON_MS}` })
    ).toBe(true);
    expect(wavesSwitchedOnAt(0, { FEATURE_WAVES_ON_CHAIN: 'true' })).toBe(true);
    // Unset, or not a time: never.
    expect(wavesSwitchedOnAt(SWITCH_ON_MS, {})).toBe(false);
    expect(
      wavesSwitchedOnAt(SWITCH_ON_MS, { WAVES_SWITCH_ON_AT: 'Saturday' })
    ).toBe(false);
    expect(
      wavesSwitchedOnAt(SWITCH_ON_MS, {
        WAVES_SWITCH_ON_AT: '2026-11-31T00:00:00Z'
      })
    ).toBe(false);
  });
});

describe('WavesImportRouteWait', () => {
  it('waits with one warning before the switch-on, and not from it', () => {
    const logger = Logger.get('WAVES_IMPORT_ROUTE_TEST');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const wait = new WavesImportRouteWait(logger, 'SOME UNIT');
    const env = { WAVES_SWITCH_ON_AT: SWITCH_ON };
    expect(wait.waits(SWITCH_ON_MS - 2, env)).toBe(true);
    expect(wait.waits(SWITCH_ON_MS - 1, env)).toBe(true);
    expect(warn.mock.calls).toEqual([
      [
        '[SOME UNIT WAITS] [THE CHAIN GATEWAY HAS NO /v1/waves/import] [BEFORE THE SWITCH-ON] it needs a release with the waves routes; this is an error from the switch-on'
      ]
    ]);
    // Read on each call: from the switch-on time it no longer waits.
    expect(wait.waits(SWITCH_ON_MS, env)).toBe(false);
    expect(wait.waits(SWITCH_ON_MS + 1, env)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

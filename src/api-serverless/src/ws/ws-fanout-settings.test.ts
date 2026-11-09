const mockWarn = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: mockWarn }) }
}));

import {
  isKnownExpiryFenceEnabled,
  WS_FANOUT_CONCURRENCY_DEFAULT,
  WS_FANOUT_CONCURRENCY_MAX,
  WS_FANOUT_CONCURRENCY_MIN,
  WS_GATEWAY_AGENT_MIN_SOCKETS,
  wsFanoutConcurrency,
  wsGatewayAgentMaxSockets
} from './ws-fanout-settings';

describe('wsFanoutConcurrency', () => {
  beforeEach(() => mockWarn.mockClear());

  it('defaults to 16 when unset or blank, so a deploy sets nothing', () => {
    expect(WS_FANOUT_CONCURRENCY_DEFAULT).toBe(16);
    expect(wsFanoutConcurrency({})).toBe(16);
    expect(wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: '' })).toBe(16);
    expect(wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: '  ' })).toBe(16);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['1', 1],
    ['16', 16],
    [' 64 ', 64],
    ['+32', 32],
    ['128', 128]
  ])('accepts %j as %i', (value, expected) => {
    expect(wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: value })).toBe(
      expected
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 1],
    ['-5', 1],
    ['129', 128],
    ['100000', 128]
  ])('clamps %j to %i and warns', (value, expected) => {
    expect(wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: value })).toBe(
      expected
    );
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('WS_FANOUT_CONCURRENCY')
    );
  });

  it.each(['abc', '12.5', '1e3', '0x20', '64 sockets', 'NaN', 'Infinity'])(
    'uses the default for the invalid value %j and warns',
    (value) => {
      expect(wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: value })).toBe(16);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('using 16 instead')
      );
    }
  );

  it('warns once per invalid value, not once per fan-out', () => {
    for (let i = 0; i < 5; i++) {
      wsFanoutConcurrency({ WS_FANOUT_CONCURRENCY: 'many' });
    }
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('wsGatewayAgentMaxSockets', () => {
  it.each([
    [undefined, 50],
    ['16', 50],
    ['32', 50],
    ['50', 50],
    ['64', 64],
    ['128', 128],
    ['1000', 128]
  ])(
    'sizes the agent for WS_FANOUT_CONCURRENCY=%j at %i sockets',
    (value, expected) => {
      expect(wsGatewayAgentMaxSockets({ WS_FANOUT_CONCURRENCY: value })).toBe(
        expected
      );
    }
  );

  it('never has fewer sockets than the fan-out keeps sends in flight', () => {
    for (
      let width = WS_FANOUT_CONCURRENCY_MIN;
      width <= WS_FANOUT_CONCURRENCY_MAX;
      width++
    ) {
      const env = { WS_FANOUT_CONCURRENCY: String(width) };
      expect(wsGatewayAgentMaxSockets(env)).toBe(
        Math.max(WS_GATEWAY_AGENT_MIN_SOCKETS, wsFanoutConcurrency(env))
      );
      expect(wsGatewayAgentMaxSockets(env)).toBeGreaterThanOrEqual(width);
    }
  });
});

describe('isKnownExpiryFenceEnabled', () => {
  beforeEach(() => mockWarn.mockClear());

  it.each([undefined, '', 'on', 'ON', ' true ', '1'])(
    'is on for %j',
    (value) => {
      expect(isKnownExpiryFenceEnabled({ WS_KNOWN_EXPIRY_FENCE: value })).toBe(
        true
      );
      expect(mockWarn).not.toHaveBeenCalled();
    }
  );

  it.each(['off', 'OFF', ' Off ', 'false', '0'])('is off for %j', (value) => {
    expect(isKnownExpiryFenceEnabled({ WS_KNOWN_EXPIRY_FENCE: value })).toBe(
      false
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'no', 'of'])(
    'stays on for the invalid value %j and warns',
    (value) => {
      expect(isKnownExpiryFenceEnabled({ WS_KNOWN_EXPIRY_FENCE: value })).toBe(
        true
      );
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('using on instead')
      );
    }
  );
});

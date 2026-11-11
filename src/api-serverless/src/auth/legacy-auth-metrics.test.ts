import { EventEmitter } from 'node:events';
import {
  recordLegacyAuthUse,
  recordLegacyAuthUseOnFinish,
  setLegacyLoginFormat,
  setLegacyLoginFormClosed
} from './legacy-auth-metrics';

function fakeResponse(statusCode: number) {
  return Object.assign(new EventEmitter(), { statusCode, locals: {} });
}

describe('legacy auth usage metrics', () => {
  let stdoutWrite: jest.SpyInstance;

  beforeEach(() => {
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  function emitted(): Record<string, unknown>[] {
    return stdoutWrite.mock.calls.map(([line]) => JSON.parse(String(line)));
  }

  it('writes one EMF line with the client family, not the user agent', () => {
    recordLegacyAuthUse({
      route: 'login',
      format: 'text',
      userAgent: 'curl/8.4.0 secret-marker',
      outcome: 'ok'
    });

    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    expect(String(stdoutWrite.mock.calls[0][0])).not.toContain('secret-marker');
    expect(emitted()).toEqual([
      expect.objectContaining({
        _type: '6529.legacy_auth_use.v1',
        Route: 'login',
        Format: 'text',
        Client: 'curl',
        Outcome: 'ok',
        Refusal: 'none',
        LegacyAuthCalls: 1
      })
    ]);
  });

  it('keeps the existing dimension sets and adds Route+Refusal', () => {
    recordLegacyAuthUse({
      route: 'login',
      format: 'text_previous_form',
      userAgent: null,
      outcome: 'refused',
      refusal: 'form_closed'
    });

    const [line] = emitted();
    expect((line._aws as any).CloudWatchMetrics[0].Dimensions).toEqual([
      ['Route', 'Format', 'Outcome'],
      ['Route', 'Client', 'Outcome'],
      ['Route', 'Refusal']
    ]);
    expect(line).toEqual(
      expect.objectContaining({ Outcome: 'refused', Refusal: 'form_closed' })
    );
  });

  it('reports a closed old form only on a refusal', () => {
    const closed = fakeResponse(401);
    const accepted = fakeResponse(201);
    const other = fakeResponse(401);
    const middleware = recordLegacyAuthUseOnFinish('login');
    for (const res of [closed, accepted, other]) {
      middleware({ headers: {} } as any, res as any, jest.fn());
    }

    setLegacyLoginFormClosed(closed as any);
    setLegacyLoginFormClosed(accepted as any);
    closed.emit('finish');
    accepted.emit('finish');
    other.emit('finish');

    expect(
      emitted().map(({ Outcome, Refusal }) => ({ Outcome, Refusal }))
    ).toEqual([
      { Outcome: 'refused', Refusal: 'form_closed' },
      { Outcome: 'ok', Refusal: 'none' },
      { Outcome: 'refused', Refusal: 'other' }
    ]);
  });

  it('never fails the request when the metric cannot be written', () => {
    stdoutWrite.mockImplementation(() => {
      throw new Error('closed');
    });
    expect(() =>
      recordLegacyAuthUse({
        route: 'login',
        format: 'text',
        userAgent: null,
        outcome: 'refused'
      })
    ).not.toThrow();
  });

  it.each([
    [201, 'ok'],
    [400, 'refused'],
    [401, 'refused'],
    [410, 'refused']
  ])(
    'records one use when a response with status %p finishes',
    (status, outcome) => {
      const next = jest.fn();
      const res = fakeResponse(status);
      recordLegacyAuthUseOnFinish('redeem_refresh_token')(
        { headers: { 'user-agent': 'node' } } as any,
        res as any,
        next
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(stdoutWrite).not.toHaveBeenCalled();
      res.emit('finish');
      res.emit('finish');
      expect(emitted()).toEqual([
        expect.objectContaining({
          Route: 'redeem_refresh_token',
          Format: 'refresh_token',
          Client: 'node',
          Outcome: outcome
        })
      ]);
    }
  );

  it('reports the login format the handler found, or unverified', () => {
    const verified = fakeResponse(201);
    const unverified = fakeResponse(401);
    const middleware = recordLegacyAuthUseOnFinish('login');
    middleware({ headers: {} } as any, verified as any, jest.fn());
    middleware({ headers: {} } as any, unverified as any, jest.fn());

    setLegacyLoginFormat(verified as any, 'text_previous_form');
    verified.emit('finish');
    unverified.emit('finish');

    expect(
      emitted().map(({ Format, Client, Outcome }) => ({
        Format,
        Client,
        Outcome
      }))
    ).toEqual([
      { Format: 'text_previous_form', Client: 'none', Outcome: 'ok' },
      { Format: 'unverified', Client: 'none', Outcome: 'refused' }
    ]);
  });
});

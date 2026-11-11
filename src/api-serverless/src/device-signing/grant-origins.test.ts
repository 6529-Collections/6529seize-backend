import * as fc from 'fast-check';
import {
  checkGrantOrigin,
  classifyRequestOrigin,
  evaluateGrantOrigin,
  getGrantOriginPolicy,
  getRecognizedGrantOrigins,
  grantRegistrationRequestOf,
  GrantRegistrationRequest,
  toGrantRegistrationRecord
} from './grant-origins';

const ORIGIN_ENV = [
  'DEVICE_GRANT_ORIGIN_POLICY',
  'WEB_APP_ORIGIN',
  'WEB_APP_ADDITIONAL_ORIGINS',
  'AUTH_WEB_CREDENTIAL_ORIGINS'
] as const;

function request(
  overrides: Partial<GrantRegistrationRequest> = {}
): GrantRegistrationRequest {
  return {
    apiHost: 'api.6529.io',
    requestOrigin: 'https://6529.io',
    session: { clientType: 'native', binding: 'structured', sessionId: null },
    ...overrides
  };
}

function emittedLines(write: jest.SpyInstance): Record<string, unknown>[] {
  return write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.includes('6529.device_grant_origin.v1'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('grant origins', () => {
  const saved: Partial<Record<(typeof ORIGIN_ENV)[number], string>> = {};
  let write: jest.SpyInstance;

  beforeEach(() => {
    for (const name of ORIGIN_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
    for (const name of ORIGIN_ENV) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  describe('recognised origins per API host', () => {
    it('production recognises 6529.io and 6529 Desktop only', () => {
      expect(new Set(getRecognizedGrantOrigins('api.6529.io'))).toEqual(
        new Set(['6529.io', '6529 Desktop'])
      );
    });

    it('staging recognises staging.6529.io and 6529 Desktop only', () => {
      expect(new Set(getRecognizedGrantOrigins('api.staging.6529.io'))).toEqual(
        new Set(['staging.6529.io', '6529 Desktop'])
      );
    });

    it('a local API recognises the local web hosts', () => {
      expect(getRecognizedGrantOrigins('localhost:3000')).toEqual(
        expect.arrayContaining([
          'localhost:3000',
          'localhost:3001',
          '127.0.0.1:3000',
          '6529 Desktop'
        ])
      );
    });

    it('adds configured web origins', () => {
      process.env.WEB_APP_ADDITIONAL_ORIGINS = 'https://preview.6529.io';
      expect(getRecognizedGrantOrigins('api.6529.io')).toContain(
        'preview.6529.io'
      );
    });
  });

  describe('evaluateGrantOrigin', () => {
    it.each([
      ['6529.io', 'api.6529.io', true, 'web_origin'],
      ['6529 Desktop', 'api.6529.io', true, 'app_origin'],
      ['6529 Desktop', 'api.staging.6529.io', true, 'app_origin'],
      ['staging.6529.io', 'api.staging.6529.io', true, 'web_origin'],
      ['staging.6529.io', 'api.6529.io', false, 'other_environment'],
      ['6529.io', 'api.staging.6529.io', false, 'other_environment'],
      ['localhost:3001', 'api.6529.io', false, 'loopback'],
      ['127.0.0.1:43123', 'api.6529.io', false, 'loopback'],
      ['[::1]:3000', 'api.6529.io', false, 'loopback'],
      ['localhost:3001', 'localhost:3000', true, 'web_origin'],
      ['unlisted.example', 'api.6529.io', false, 'unrecognized'],
      ['6529.io.unlisted.example', 'api.6529.io', false, 'unrecognized'],
      ['6529 Mobile', 'api.6529.io', false, 'unrecognized'],
      ['6529.IO', 'api.6529.io', false, 'unrecognized'],
      ['6529.io', undefined, false, 'other_environment']
    ])(
      'origin %p on API host %p: recognized %p (%p)',
      (origin, apiHost, recognized, reason) => {
        expect(evaluateGrantOrigin(origin, apiHost)).toEqual({
          recognized,
          reason
        });
      }
    );

    it('recognises an origin only when it is a recognised origin', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[ -~]{1,64}$/),
          fc.constantFrom('api.6529.io', 'api.staging.6529.io'),
          (origin, apiHost) => {
            expect(evaluateGrantOrigin(origin, apiHost).recognized).toBe(
              getRecognizedGrantOrigins(apiHost).includes(origin)
            );
          }
        )
      );
    });
  });

  describe('classifyRequestOrigin', () => {
    it.each([
      [null, 'none'],
      ['https://6529.io', 'web_origin'],
      ['https://staging.6529.io', 'other_environment'],
      ['http://localhost:43123', 'loopback'],
      ['capacitor://localhost', 'other'],
      ['null', 'other'],
      ['https://unlisted.example', 'other']
    ])('%p on the production API is %p', (requestOrigin, kind) => {
      expect(classifyRequestOrigin(requestOrigin, 'api.6529.io')).toBe(kind);
    });
  });

  describe('getGrantOriginPolicy', () => {
    it('is log only by default', () => {
      expect(getGrantOriginPolicy()).toBe('log');
    });

    it.each([
      ['enforce', 'enforce'],
      [' ENFORCE ', 'enforce'],
      ['log', 'log'],
      ['enforced', 'log'],
      ['true', 'log'],
      ['', 'log']
    ])('reads %p as %p', (value, policy) => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = value;
      expect(getGrantOriginPolicy()).toBe(policy);
    });
  });

  describe('checkGrantOrigin', () => {
    it('in log mode accepts an unrecognised origin and records why', () => {
      const check = checkGrantOrigin({
        route: 'device_grants',
        origin: 'localhost:43123',
        grantId: '0xgrant',
        request: request({ requestOrigin: 'http://localhost:43123' })
      });

      expect(check).toEqual({
        recognized: false,
        reason: 'loopback',
        policy: 'log',
        refused: false
      });
      const [line] = emittedLines(write);
      expect(line).toMatchObject({
        Route: 'device_grants',
        Verdict: 'unrecognized',
        Reason: 'loopback',
        Policy: 'log',
        Decision: 'accepted',
        ClientType: 'native',
        Binding: 'structured',
        RequestOrigin: 'http://localhost:43123',
        RequestOriginKind: 'loopback',
        Origin: 'localhost:43123',
        GrantId: '0xgrant',
        ApiHost: 'api.6529.io',
        GrantOriginChecks: 1
      });
      expect(line._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: '6529/DeviceGrants',
            Dimensions: [
              ['Route', 'Verdict'],
              ['Route', 'Reason'],
              ['Route', 'ClientType', 'Binding']
            ],
            Metrics: [{ Name: 'GrantOriginChecks', Unit: 'Count' }]
          }
        ]
      });
    });

    it('in enforce mode refuses an unrecognised origin', () => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = 'enforce';

      const check = checkGrantOrigin({
        route: 'e2ee_devices',
        origin: 'staging.6529.io',
        grantId: '0xgrant',
        request: request()
      });

      expect(check).toMatchObject({
        recognized: false,
        reason: 'other_environment',
        policy: 'enforce',
        refused: true
      });
      expect(emittedLines(write)[0]).toMatchObject({
        Route: 'e2ee_devices',
        Decision: 'refused'
      });
    });

    it('in enforce mode accepts the origins honest clients sign', () => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = 'enforce';
      for (const origin of ['6529.io', '6529 Desktop']) {
        expect(
          checkGrantOrigin({
            route: 'device_grants',
            origin,
            grantId: '0xgrant',
            request: request()
          }).refused
        ).toBe(false);
      }
    });

    it('records unknown client type and binding for a token without session claims', () => {
      checkGrantOrigin({
        route: 'device_grants',
        origin: '6529.io',
        grantId: '0xgrant',
        request: request({ session: null, requestOrigin: null })
      });
      expect(emittedLines(write)[0]).toMatchObject({
        Verdict: 'recognized',
        Reason: 'web_origin',
        ClientType: 'unknown',
        Binding: 'unknown',
        RequestOrigin: null,
        RequestOriginKind: 'none'
      });
    });

    it('never fails the request when telemetry cannot be written', () => {
      write.mockImplementation(() => {
        throw new Error('stdout closed');
      });
      expect(
        checkGrantOrigin({
          route: 'device_grants',
          origin: 'unlisted.example',
          grantId: '0xgrant',
          request: request()
        }).refused
      ).toBe(false);
    });
  });

  describe('registration records', () => {
    it('reads the API host, Origin and session of a request', () => {
      const session = {
        clientType: 'desktop' as const,
        binding: 'structured' as const,
        sessionId: '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e'
      };
      const registration = grantRegistrationRequestOf(
        {
          headers: { host: 'api.6529.io', origin: 'HTTP://LOCALHOST:43123' }
        },
        session
      );

      expect(registration).toEqual({
        apiHost: 'api.6529.io',
        requestOrigin: 'http://localhost:43123',
        session
      });
      expect(toGrantRegistrationRecord(registration)).toEqual({
        registered_client_type: 'desktop',
        registered_binding: 'structured',
        registered_request_origin: 'http://localhost:43123',
        registered_session_id: session.sessionId
      });
    });

    it('stores nulls when nothing is known', () => {
      expect(toGrantRegistrationRecord(null)).toEqual({
        registered_client_type: null,
        registered_binding: null,
        registered_request_origin: null,
        registered_session_id: null
      });
    });
  });
});

const getRedisClientMock = jest.fn();

jest.mock('@/redis', () => ({
  getRedisClient: () => getRedisClientMock()
}));

import * as fc from 'fast-check';
import * as jwt from 'jsonwebtoken';
import { getAccessTokenClaimsOrNull } from '@/api/auth/access-token-wallet';
import {
  isLegacyTextLoginDisabled,
  isStringFormChallengeAccepted,
  LEGACY_TEXT_CHALLENGE_TTL_SECONDS,
  LEGACY_TEXT_CHALLENGE_TYPE,
  legacyLoginFormatOf,
  resetStringFormTransitionForTests,
  signLegacyTextChallenge,
  startStringFormTransition,
  STRING_FORM_LAST_ACCEPTED_AT_MS,
  STRING_FORM_TRANSITION_MS,
  verifyLegacyLoginChallengeToken
} from './legacy-text-challenge';

const SECRET = 'legacy-text-challenge-test-secret';
const BEFORE_LAST_DAY_MS = STRING_FORM_LAST_ACCEPTED_AT_MS - 24 * 3600_000;

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    set: jest.fn(
      async (key: string, value: string, options: { NX?: boolean }) => {
        if (options.NX && store.has(key)) {
          return null;
        }
        store.set(key, value);
        return 'OK';
      }
    ),
    get: jest.fn(async (key: string) => store.get(key) ?? null)
  };
}

describe('legacy text challenge tokens', () => {
  it('signs an object payload that expires after five minutes', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signLegacyTextChallenge('text to sign', SECRET);
    const payload = jwt.verify(token, SECRET) as jwt.JwtPayload;

    expect(payload.challenge_type).toBe(LEGACY_TEXT_CHALLENGE_TYPE);
    expect(payload.nonce).toBe('text to sign');
    expect(payload.exp! - payload.iat!).toBe(LEGACY_TEXT_CHALLENGE_TTL_SECONDS);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
  });

  it('round-trips any message', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 400 }), (message) => {
        const challenge = verifyLegacyLoginChallengeToken(
          signLegacyTextChallenge(message, SECRET),
          SECRET
        );
        expect(challenge.message).toBe(message);
        expect(challenge.form).toBe('expiring');
      })
    );
  });

  it('is never accepted as an access token', () => {
    const token = signLegacyTextChallenge('text to sign', SECRET);
    expect(getAccessTokenClaimsOrNull(jwt.verify(token, SECRET))).toBeNull();
  });

  it('refuses an expired challenge', () => {
    const token = jwt.sign(
      {
        challenge_type: LEGACY_TEXT_CHALLENGE_TYPE,
        nonce: 'text to sign',
        iat: Math.floor(Date.now() / 1000) - 600
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: LEGACY_TEXT_CHALLENGE_TTL_SECONDS }
    );
    expect(() => verifyLegacyLoginChallengeToken(token, SECRET)).toThrow(
      'jwt expired'
    );
  });

  it('refuses a token signed with another secret', () => {
    const token = signLegacyTextChallenge('text to sign', 'other-secret');
    expect(() => verifyLegacyLoginChallengeToken(token, SECRET)).toThrow();
  });

  it.each([
    ['an access token', { id: 'x', sub: `0x${'a'.repeat(40)}` }],
    ['a SIWE envelope', { challenge_type: 'wallet_auth', message: 'm' }],
    ['a challenge without text', { challenge_type: LEGACY_TEXT_CHALLENGE_TYPE }]
  ])('refuses %s', (_name, payload) => {
    const token = jwt.sign(payload, SECRET, {
      algorithm: 'HS256',
      expiresIn: 60
    });
    expect(() => verifyLegacyLoginChallengeToken(token, SECRET)).toThrow(
      'Invalid server signature'
    );
  });

  it('refuses an object challenge without an expiry', () => {
    const token = jwt.sign(
      { challenge_type: LEGACY_TEXT_CHALLENGE_TYPE, nonce: 'text to sign' },
      SECRET,
      { algorithm: 'HS256' }
    );
    expect(() => verifyLegacyLoginChallengeToken(token, SECRET)).toThrow(
      'Invalid server signature'
    );
  });

  it('reads the old string form and names its format', () => {
    const challenge = verifyLegacyLoginChallengeToken(
      jwt.sign('old text challenge', SECRET),
      SECRET
    );
    expect(challenge).toEqual({
      message: 'old text challenge',
      form: 'string',
      expiresAtMs: STRING_FORM_LAST_ACCEPTED_AT_MS
    });
    expect(legacyLoginFormatOf(challenge)).toBe('text_previous_form');
    expect(
      legacyLoginFormatOf(
        verifyLegacyLoginChallengeToken(
          signLegacyTextChallenge('new text challenge', SECRET),
          SECRET
        )
      )
    ).toBe('text');
    expect(
      legacyLoginFormatOf({
        message: '6529 Authentication\nVersion: 2',
        form: 'string',
        expiresAtMs: 0
      })
    ).toBe('structured');
  });

  it('keeps plain-text sign-in enabled unless explicitly disabled', () => {
    const original = process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED;
    try {
      delete process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED;
      expect(isLegacyTextLoginDisabled()).toBe(false);
      process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED = 'false';
      expect(isLegacyTextLoginDisabled()).toBe(false);
      process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED = 'true';
      expect(isLegacyTextLoginDisabled()).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED;
      } else {
        process.env.AUTH_LEGACY_TEXT_LOGIN_DISABLED = original;
      }
    }
  });
});

describe('old string-form challenge transition', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    resetStringFormTransitionForTests();
    getRedisClientMock.mockReset();
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts the old form for the transition after the build first runs, then refuses it', async () => {
    const redis = fakeRedis();
    getRedisClientMock.mockReturnValue(redis);
    const startMs = BEFORE_LAST_DAY_MS - STRING_FORM_TRANSITION_MS * 4;

    await startStringFormTransition(startMs);

    await expect(
      isStringFormChallengeAccepted(startMs + STRING_FORM_TRANSITION_MS - 1)
    ).resolves.toBe(true);
    await expect(
      isStringFormChallengeAccepted(startMs + STRING_FORM_TRANSITION_MS)
    ).resolves.toBe(false);
    await expect(
      isStringFormChallengeAccepted(startMs + STRING_FORM_TRANSITION_MS * 3)
    ).resolves.toBe(false);
  });

  it('does not restart a transition another instance started', async () => {
    const startMs = BEFORE_LAST_DAY_MS - STRING_FORM_TRANSITION_MS * 4;
    const redis = fakeRedis();
    getRedisClientMock.mockReturnValue(redis);
    await startStringFormTransition(startMs);
    await startStringFormTransition(startMs + STRING_FORM_TRANSITION_MS * 2);

    await expect(
      isStringFormChallengeAccepted(startMs + STRING_FORM_TRANSITION_MS * 2)
    ).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      String(startMs + STRING_FORM_TRANSITION_MS),
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
  });

  it('starts the transition on the first old challenge when start-up could not', async () => {
    getRedisClientMock.mockReturnValue(fakeRedis());
    const nowMs = BEFORE_LAST_DAY_MS - STRING_FORM_TRANSITION_MS * 2;

    await expect(isStringFormChallengeAccepted(nowMs)).resolves.toBe(true);
    await expect(
      isStringFormChallengeAccepted(nowMs + STRING_FORM_TRANSITION_MS)
    ).resolves.toBe(false);
  });

  it('refuses the old form from the last accepted day on, whatever Redis holds', async () => {
    const redis = fakeRedis();
    getRedisClientMock.mockReturnValue(redis);

    await expect(
      isStringFormChallengeAccepted(STRING_FORM_LAST_ACCEPTED_AT_MS)
    ).resolves.toBe(false);
    await startStringFormTransition(STRING_FORM_LAST_ACCEPTED_AT_MS + 1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('never extends the transition past the last accepted day', async () => {
    getRedisClientMock.mockReturnValue(fakeRedis());
    const nowMs = STRING_FORM_LAST_ACCEPTED_AT_MS - 1000;

    await expect(isStringFormChallengeAccepted(nowMs)).resolves.toBe(true);
    await expect(
      isStringFormChallengeAccepted(STRING_FORM_LAST_ACCEPTED_AT_MS)
    ).resolves.toBe(false);
  });

  it('refuses the old form in production when Redis is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    getRedisClientMock.mockReturnValue(null);

    await expect(
      isStringFormChallengeAccepted(BEFORE_LAST_DAY_MS)
    ).resolves.toBe(false);
  });

  it('refuses the old form in production when Redis fails', async () => {
    process.env.NODE_ENV = 'production';
    const redis = fakeRedis();
    redis.set.mockRejectedValue(new Error('connection closed'));
    getRedisClientMock.mockReturnValue(redis);

    await expect(
      isStringFormChallengeAccepted(BEFORE_LAST_DAY_MS)
    ).resolves.toBe(false);
    await expect(
      startStringFormTransition(BEFORE_LAST_DAY_MS)
    ).resolves.toBeUndefined();
  });

  it('refuses the old form when the stored transition is unreadable', async () => {
    getRedisClientMock.mockReturnValue(
      fakeRedis({ auth_legacy_text_challenge_string_form_until: 'garbage' })
    );

    await expect(
      isStringFormChallengeAccepted(BEFORE_LAST_DAY_MS)
    ).resolves.toBe(false);
  });
});

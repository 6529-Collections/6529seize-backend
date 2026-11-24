import { createHash, randomBytes } from 'node:crypto';
import {
  getCommunityApp,
  validateRedirectUri,
  validateCodeVerifier,
  validateCodeChallenge,
  computeCodeChallenge,
  verifyCodeChallenge,
  createAuthCode,
  exchangeAuthCode,
  CommunityApp
} from './community-app-auth.service';
import { BadRequestException } from '@/exceptions';

// Mock the redis module so we can control getRedisClient / getDel / redisGet /
// redisSetJson without a live Redis instance.
const mockGetDel = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetJson = jest.fn();

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn(),
  redisGet: (key: string) => mockRedisGet(key),
  redisSetJson: (key: string, value: unknown, ttl?: unknown) =>
    mockRedisSetJson(key, value, ttl),
  evictKeyFromRedisCache: jest.fn()
}));

import { getRedisClient } from '@/redis';

describe('community-app-auth.service', () => {
  const APP_ID = 'ar-community-platform';
  const ADDRESS = '0x' + 'a'.repeat(40);
  const VALID_REDIRECT_URI = 'https://6529-ar.arweave.dev/auth/callback';
  const DEV_REDIRECT_URI = 'http://localhost:3000/6529-ar/auth/callback';

  // A valid code_verifier (43 chars, base64url).
  const VALID_CODE_VERIFIER = randomBytes(32).toString('base64url');
  const VALID_CODE_CHALLENGE = computeCodeChallenge(VALID_CODE_VERIFIER);

  // In-memory store simulating Redis for createAuthCode + exchangeAuthCode.
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    jest.mocked(getRedisClient).mockReturnValue({
      getDel: mockGetDel
    } as unknown as ReturnType<typeof getRedisClient>);

    mockGetDel.mockImplementation(async (key: string) => {
      const val = store.get(key);
      if (val !== undefined) {
        store.delete(key); // GETDEL removes the key
      }
      return val ?? null;
    });

    mockRedisSetJson.mockImplementation(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    });

    mockRedisGet.mockImplementation(async (key: string) => {
      const val = store.get(key);
      return val ? JSON.parse(val) : null;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getCommunityApp', () => {
    it('returns the app for a known id', () => {
      const app = getCommunityApp(APP_ID);
      expect(app).not.toBeNull();
      expect(app!.id).toBe(APP_ID);
      expect(app!.isDev).toBe(false);
    });

    it('returns null for an unknown id', () => {
      expect(getCommunityApp('does-not-exist')).toBeNull();
    });
  });

  describe('CommunityApp registry', () => {
    it('the ar-community-platform app has a production redirect URI', () => {
      const app = getCommunityApp(APP_ID) as CommunityApp;
      expect(app.allowedRedirectUris).toContain(VALID_REDIRECT_URI);
    });

    it('the localhost redirect URI is present for development', () => {
      const app = getCommunityApp(APP_ID) as CommunityApp;
      expect(app.allowedRedirectUris).toContain(DEV_REDIRECT_URI);
    });
  });

  describe('validateRedirectUri', () => {
    it('accepts an allowed redirect URI', () => {
      const app = getCommunityApp(APP_ID) as CommunityApp;
      expect(() => validateRedirectUri(app, VALID_REDIRECT_URI)).not.toThrow();
    });

    it('rejects a disallowed redirect URI', () => {
      const app = getCommunityApp(APP_ID) as CommunityApp;
      expect(() =>
        validateRedirectUri(app, 'https://evil.com/callback')
      ).toThrow(BadRequestException);
    });
  });

  describe('validateCodeVerifier', () => {
    it('accepts a 43-char base64url string', () => {
      expect(() => validateCodeVerifier(VALID_CODE_VERIFIER)).not.toThrow();
    });

    it('accepts a 128-char base64url string', () => {
      const verifier = 'A'.repeat(128);
      expect(() => validateCodeVerifier(verifier)).not.toThrow();
    });

    it('rejects a string shorter than 43 chars', () => {
      expect(() => validateCodeVerifier('short')).toThrow(BadRequestException);
    });

    it('rejects a string longer than 128 chars', () => {
      expect(() => validateCodeVerifier('A'.repeat(129))).toThrow(
        BadRequestException
      );
    });

    it('rejects non-base64url characters', () => {
      // Contains '+' and '=' which are not base64url
      const bad = 'A'.repeat(42) + '+';
      expect(() => validateCodeVerifier(bad)).toThrow(BadRequestException);
    });
  });

  describe('validateCodeChallenge', () => {
    it('accepts a valid 43-char base64url challenge', () => {
      expect(() => validateCodeChallenge(VALID_CODE_CHALLENGE)).not.toThrow();
    });

    it('rejects a challenge that is too short', () => {
      expect(() => validateCodeChallenge('short')).toThrow(BadRequestException);
    });

    it('rejects a challenge with invalid characters', () => {
      const bad = 'A'.repeat(42) + '+';
      expect(() => validateCodeChallenge(bad)).toThrow(BadRequestException);
    });
  });

  describe('computeCodeChallenge / verifyCodeChallenge', () => {
    it('computes base64url(sha256(code_verifier))', () => {
      const expected = createHash('sha256')
        .update(VALID_CODE_VERIFIER)
        .digest('base64url');
      expect(computeCodeChallenge(VALID_CODE_VERIFIER)).toBe(expected);
      expect(computeCodeChallenge(VALID_CODE_VERIFIER)).toHaveLength(43);
    });

    it('verifies a correct code_verifier against the stored challenge', () => {
      expect(
        verifyCodeChallenge(VALID_CODE_VERIFIER, VALID_CODE_CHALLENGE)
      ).toBe(true);
    });

    it('rejects an incorrect code_verifier', () => {
      const wrong = randomBytes(32).toString('base64url');
      expect(verifyCodeChallenge(wrong, VALID_CODE_CHALLENGE)).toBe(false);
    });

    it('rejects a challenge of different length without throwing', () => {
      expect(verifyCodeChallenge(VALID_CODE_VERIFIER, 'too-short')).toBe(false);
    });
  });

  describe('createAuthCode', () => {
    it('stores a code in Redis and returns it', async () => {
      const code = await createAuthCode({
        address: ADDRESS,
        appId: APP_ID,
        codeChallenge: VALID_CODE_CHALLENGE,
        state: 'test-state'
      });
      expect(code).toHaveLength(64);
      expect(mockRedisSetJson).toHaveBeenCalledTimes(1);
      expect(mockRedisGet).toHaveBeenCalledTimes(1); // read-back verification
    });

    it('throws 503 when Redis is unavailable', async () => {
      jest.mocked(getRedisClient).mockReturnValue(null);
      await expect(
        createAuthCode({
          address: ADDRESS,
          appId: APP_ID,
          codeChallenge: VALID_CODE_CHALLENGE,
          state: 'test-state'
        })
      ).rejects.toMatchObject({ name: 'CustomApiCompliantException' });
    });

    it('throws 503 when the read-back verification fails', async () => {
      // Simulate Redis accepting the SET but the GET returning null
      mockRedisGet.mockResolvedValue(null);
      await expect(
        createAuthCode({
          address: ADDRESS,
          appId: APP_ID,
          codeChallenge: VALID_CODE_CHALLENGE,
          state: 'test-state'
        })
      ).rejects.toMatchObject({ name: 'CustomApiCompliantException' });
    });
  });

  describe('exchangeAuthCode', () => {
    async function setupCode(params?: {
      readonly state?: string;
      readonly appId?: string;
      readonly codeChallenge?: string;
    }): Promise<string> {
      return createAuthCode({
        address: ADDRESS,
        appId: params?.appId ?? APP_ID,
        codeChallenge: params?.codeChallenge ?? VALID_CODE_CHALLENGE,
        state: params?.state ?? 'test-state'
      });
    }

    it('successfully exchanges a valid code with correct PKCE and state', async () => {
      const code = await setupCode();
      const result = await exchangeAuthCode({
        code,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: APP_ID
      });
      expect(result).not.toBeNull();
      expect(result!.address).toBe(ADDRESS.toLowerCase());
      expect(result!.app).toBe(APP_ID);
    });

    it('returns null for an already-consumed code (atomic GETDEL)', async () => {
      const code = await setupCode();
      // First exchange consumes the code
      const first = await exchangeAuthCode({
        code,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: APP_ID
      });
      expect(first).not.toBeNull();
      // Second exchange must fail
      const second = await exchangeAuthCode({
        code,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: APP_ID
      });
      expect(second).toBeNull();
    });

    it('returns null when code_verifier does not match code_challenge', async () => {
      const code = await setupCode();
      const wrongVerifier = randomBytes(32).toString('base64url');
      const result = await exchangeAuthCode({
        code,
        codeVerifier: wrongVerifier,
        state: 'test-state',
        app: APP_ID
      });
      expect(result).toBeNull();
    });

    it('returns null when state does not match', async () => {
      const code = await setupCode({ state: 'original-state' });
      const result = await exchangeAuthCode({
        code,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'wrong-state',
        app: APP_ID
      });
      expect(result).toBeNull();
    });

    it('returns null when app does not match', async () => {
      const code = await setupCode();
      const result = await exchangeAuthCode({
        code,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: 'different-app'
      });
      expect(result).toBeNull();
    });

    it('returns null for a non-existent code', async () => {
      const fakeCode = randomBytes(32).toString('hex');
      const result = await exchangeAuthCode({
        code: fakeCode,
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: APP_ID
      });
      expect(result).toBeNull();
    });

    it('returns null when Redis is unavailable', async () => {
      jest.mocked(getRedisClient).mockReturnValue(null);
      const result = await exchangeAuthCode({
        code: 'a'.repeat(64),
        codeVerifier: VALID_CODE_VERIFIER,
        state: 'test-state',
        app: APP_ID
      });
      expect(result).toBeNull();
    });
  });
});

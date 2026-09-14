jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

import { ethers } from 'ethers';
import * as jwt from 'jsonwebtoken';
import { SiweMessage } from 'siwe';
import { getRedisClient } from '@/redis';
import {
  buildStructuredWalletSignatureMessage,
  parseStructuredWalletSignatureMessage
} from './structured-wallet-signatures';
import {
  clearSiweWalletAuthReplayCacheForTests,
  consumeSiweWalletAuthNonce,
  createSiweWebAuthChallenge,
  generateSiweWalletAuthNonce,
  parseSiweWebAuthMessage,
  resolveSiweWalletAuthApiAudience,
  signSiweWebAuthChallenge,
  SIWE_WALLET_AUTH_ISSUER,
  SIWE_WALLET_AUTH_STATEMENT,
  SIWE_WALLET_AUTH_SUBJECT,
  SIWE_WALLET_AUTH_TTL_SECONDS,
  verifySessionChallengeToken,
  verifySiweWebAuthSignature
} from './siwe-wallet-auth';

const getRedisClientMock = jest.mocked(getRedisClient);
const JWT_SECRET = 'siwe-wallet-auth-test-secret';
const API_AUDIENCE = 'api.6529.io';
const NOW = new Date('2026-07-26T12:00:00.000Z');
const EIP1271_MAGIC_VALUE = '0x1626ba7e';

describe('SIWE wallet auth', () => {
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const otherWallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f094538e9d874d2fe3df31d0f01e3be7f0ca0a84'
  );
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS =
      '6529.io,staging.6529.io,example.com:8443';
    process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES = 'api.example.com:8443';
    process.env.ALCHEMY_API_KEY = 'test-key';
    getRedisClientMock.mockReturnValue(null);
    clearSiweWalletAuthReplayCacheForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES;
    delete process.env.ALCHEMY_API_KEY;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('message construction', () => {
    it.each([
      {
        origin: 'https://6529.io',
        expectedDomain: '6529.io',
        expectedScheme: 'https'
      },
      {
        origin: 'https://staging.6529.io',
        expectedDomain: 'staging.6529.io',
        expectedScheme: 'https'
      },
      {
        origin: 'https://example.com:8443',
        expectedDomain: 'example.com:8443',
        expectedScheme: 'https'
      }
    ])(
      'constructs canonical SIWE for $origin',
      ({ origin, expectedDomain, expectedScheme }) => {
        const challenge = createChallenge(origin);
        const standardsParsed = new SiweMessage(challenge.message);
        const parsed = parseSiweWebAuthMessage(challenge.message);

        expect(standardsParsed.prepareMessage()).toBe(challenge.message);
        expect(parsed).toMatchObject({
          scheme: expectedScheme,
          domain: expectedDomain,
          address: wallet.address,
          uri: origin,
          chainId: 1,
          nonce: '32f7c245a8804dd895dc76df4dff137b'
        });
        expect(
          challenge.message.startsWith(
            `${expectedScheme}://${expectedDomain} wants you to sign in with your Ethereum account:\n${wallet.address}`
          )
        ).toBe(true);
        expect(challenge.expirationTime.getTime()).toBe(
          challenge.issuedAt.getTime() + SIWE_WALLET_AUTH_TTL_SECONDS * 1000
        );
        expect(standardsParsed.statement).toBe(SIWE_WALLET_AUTH_STATEMENT);
        expect(standardsParsed.statement).not.toContain('\n');
        expect(challenge.message).not.toMatch(
          /^(Audience|Client Origin|Session Type|Action|Purpose):/m
        );
        expect(challenge.message).toContain('\nVersion: 1\n');
      }
    );

    it('checksums the address and rounds timestamps to whole seconds', () => {
      const challenge = createSiweWebAuthChallenge({
        address: wallet.address.toLowerCase(),
        clientOrigin: 'https://6529.io',
        chainId: 1,
        nonce: '12345678abcdef00',
        issuedAt: new Date('2026-07-26T12:00:00.987Z')
      });

      expect(challenge.message).toContain(`\n${wallet.address}\n`);
      expect(challenge.issuedAt.toISOString()).toBe('2026-07-26T12:00:00.000Z');
      expect(challenge.expirationTime.toISOString()).toBe(
        '2026-07-26T12:05:00.000Z'
      );
    });

    it('generates 128-bit alphanumeric nonces without UUID punctuation', () => {
      const nonces = Array.from({ length: 64 }, generateSiweWalletAuthNonce);

      expect(new Set(nonces).size).toBe(nonces.length);
      nonces.forEach((nonce) => {
        expect(nonce).toMatch(/^[a-f0-9]{32}$/);
      });
    });

    it('rejects malformed or noncanonical challenge construction inputs', () => {
      expect(() =>
        createSiweWebAuthChallenge({
          address: wallet.address,
          clientOrigin: 'https://user:pass@6529.io/path?query=1#fragment',
          chainId: 1,
          issuedAt: NOW
        })
      ).toThrow('Invalid SIWE wallet auth challenge');
      expect(() =>
        createSiweWebAuthChallenge({
          address: wallet.address,
          clientOrigin: 'https://6529.io',
          chainId: 1,
          nonce: 'uuid-like-nonce-with-hyphens',
          issuedAt: NOW
        })
      ).toThrow('Invalid SIWE wallet auth challenge');
    });
  });

  describe('strict Host resolution', () => {
    it.each([
      ['api.6529.io', 'api.6529.io'],
      ['api.6529.io:443', 'api.6529.io'],
      ['api.example.com:8443', 'api.example.com:8443']
    ])('accepts allowed bare Host %s', (rawHost, expected) => {
      expect(resolveSiweWalletAuthApiAudience(rawHost)).toBe(expected);
    });

    it.each([
      null,
      '',
      'evil.example',
      'https://api.6529.io',
      'user@api.6529.io',
      'api.6529.io/path',
      'api.6529.io?query=1',
      'api.6529.io#fragment',
      'api.6529.io\\path',
      'api.6529.io value'
    ])('rejects malformed or untrusted Host %s', (rawHost) => {
      expect(resolveSiweWalletAuthApiAudience(rawHost)).toBeNull();
    });
  });

  describe('semantic validation and signatures', () => {
    it('accepts a valid EOA signature', async () => {
      const challenge = createChallenge();
      const signature = await wallet.signMessage(challenge.message);

      await expect(
        verifyChallengeSignature(challenge.message, signature)
      ).resolves.toMatchObject({
        address: wallet.address.toLowerCase(),
        domain: '6529.io',
        nonce: challenge.nonce
      });
    });

    it('rejects a signature from another EOA', async () => {
      mockContract({
        isValidSignature: jest.fn().mockResolvedValue('0xffffffff')
      });
      const challenge = createChallenge();
      const signature = await otherWallet.signMessage(challenge.message);

      await expect(
        verifyChallengeSignature(challenge.message, signature)
      ).resolves.toBeNull();
    });

    it('preserves EIP-1271 contract signature verification', async () => {
      const contract = {
        isValidSignature: jest.fn().mockResolvedValue(EIP1271_MAGIC_VALUE)
      };
      mockContract(contract);
      const challenge = createChallenge();
      const signature = await otherWallet.signMessage(challenge.message);

      await expect(
        verifyChallengeSignature(challenge.message, signature)
      ).resolves.toMatchObject({
        address: wallet.address.toLowerCase()
      });
      expect(contract.isValidSignature).toHaveBeenCalledWith(
        ethers.hashMessage(challenge.message),
        signature
      );
    });

    it('rejects an invalid EIP-1271 response', async () => {
      mockContract({
        isValidSignature: jest.fn().mockResolvedValue('0xffffffff')
      });
      const challenge = createChallenge();
      const signature = await otherWallet.signMessage(challenge.message);

      await expect(
        verifyChallengeSignature(challenge.message, signature)
      ).resolves.toBeNull();
    });

    it.each([
      {
        name: 'wrong expected address',
        expectedAddress: otherWallet.address
      },
      {
        name: 'wrong expected chain',
        expectedChainId: 11155111
      },
      {
        name: 'wrong request Origin',
        expectedClientOrigin: 'https://staging.6529.io'
      }
    ])('rejects $name', async (overrides) => {
      const challenge = createChallenge();
      const signature = await wallet.signMessage(challenge.message);

      await expect(
        verifyChallengeSignature(challenge.message, signature, overrides)
      ).resolves.toBeNull();
    });

    it.each([
      {
        name: 'lookalike domain',
        overrides: {
          domain: 'fake-staging.6529.io',
          uri: 'https://fake-staging.6529.io'
        }
      },
      {
        name: 'URI and domain mismatch',
        overrides: {
          domain: '6529.io',
          uri: 'https://staging.6529.io'
        }
      },
      {
        name: 'URI path',
        overrides: {
          uri: 'https://6529.io/login'
        }
      },
      {
        name: 'URI credentials',
        overrides: {
          uri: 'https://user:pass@6529.io'
        }
      },
      {
        name: 'scheme mismatch',
        overrides: {
          scheme: 'http'
        }
      },
      {
        name: 'port mismatch',
        overrides: {
          domain: '6529.io:8443'
        }
      },
      {
        name: 'wrong statement',
        overrides: {
          statement: 'Sign something else.'
        }
      },
      {
        name: 'resources',
        overrides: {
          resources: ['https://6529.io/resource']
        }
      }
    ])(
      'rejects a canonical-looking message with $name',
      async ({ overrides }) => {
        const message = prepareMessage(overrides);
        const signature = await wallet.signMessage(message);

        await expect(
          verifyChallengeSignature(message, signature)
        ).resolves.toBeNull();
      }
    );

    it('rejects malformed SIWE and header lookalikes', () => {
      expect(parseSiweWebAuthMessage('not SIWE')).toBeNull();
      expect(
        parseSiweWebAuthMessage(
          '6529.io wants you to sign in with your Ethereum account:\nnot-an-address'
        )
      ).toBeNull();
    });

    it('rejects missing expiration, invalid nonce, reversed timing, and excessive TTL', () => {
      expect(
        parseSiweWebAuthMessage(prepareMessage({ expirationTime: undefined }))
      ).toBeNull();
      expect(
        parseSiweWebAuthMessage(prepareMessage({ nonce: '1234-5678' }, false))
      ).toBeNull();
      expect(
        parseSiweWebAuthMessage(
          prepareMessage({
            expirationTime: '2026-07-26T11:59:59.000Z'
          })
        )
      ).toBeNull();
      expect(
        parseSiweWebAuthMessage(
          prepareMessage({
            expirationTime: '2026-07-26T12:05:01.000Z'
          })
        )
      ).toBeNull();
    });

    it('rejects expired messages and excessive future Issued At skew', async () => {
      const expired = prepareMessage({
        issuedAt: '2026-07-26T11:54:59.000Z',
        expirationTime: '2026-07-26T11:59:59.000Z'
      });
      const future = prepareMessage({
        issuedAt: '2026-07-26T12:01:01.000Z',
        expirationTime: '2026-07-26T12:06:01.000Z'
      });

      await expect(
        verifyChallengeSignature(expired, await wallet.signMessage(expired))
      ).resolves.toBeNull();
      await expect(
        verifyChallengeSignature(future, await wallet.signMessage(future))
      ).resolves.toBeNull();
    });
  });

  describe('server challenge envelope', () => {
    it('signs and verifies an exact versioned web envelope', () => {
      const { challenge, token } = createSignedChallenge();
      const decoded = jwt.decode(token);

      expect(decoded).toMatchObject({
        challenge_type: 'wallet_auth',
        challenge_version: 1,
        challenge_format: 'siwe',
        message: challenge.message,
        client_type: 'web',
        client_origin: 'https://6529.io',
        iss: SIWE_WALLET_AUTH_ISSUER,
        sub: SIWE_WALLET_AUTH_SUBJECT,
        aud: API_AUDIENCE,
        iat: Math.floor(challenge.issuedAt.getTime() / 1000),
        exp: Math.floor(challenge.expirationTime.getTime() / 1000)
      });
      expect(
        verifySessionChallengeToken({
          token,
          expectedApiAudience: API_AUDIENCE,
          jwtSecret: JWT_SECRET,
          now: NOW
        })
      ).toEqual({
        format: 'siwe',
        message: challenge.message,
        clientOrigin: 'https://6529.io',
        apiAudience: API_AUDIENCE
      });
    });

    it.each([
      ['wrong issuer', { iss: 'wrong-issuer' }],
      ['wrong subject', { sub: 'wrong-subject' }],
      ['wrong audience', { aud: 'api.staging.6529.io' }],
      ['audience array', { aud: [API_AUDIENCE] }],
      ['extra claim', { unexpected: true }],
      ['wrong format', { challenge_format: 'structured' }],
      ['wrong version', { challenge_version: 2 }],
      ['wrong client type', { client_type: 'native' }]
    ])('rejects an envelope with %s', (_name, overrides) => {
      const { token } = createSignedChallenge();
      const modified = resignEnvelope(token, overrides);

      expect(() =>
        verifySessionChallengeToken({
          token: modified,
          expectedApiAudience: API_AUDIENCE,
          jwtSecret: JWT_SECRET,
          now: NOW
        })
      ).toThrow('Invalid wallet auth challenge');
    });

    it('rejects tampering, alternate algorithms, and access-token-shaped JWTs', () => {
      const { token } = createSignedChallenge();
      const tampered = `${token.slice(0, -1)}${
        token.endsWith('a') ? 'b' : 'a'
      }`;
      const alternateAlgorithm = resignEnvelope(token, {}, 'HS384');
      const accessToken = jwt.sign(
        { address: wallet.address, role: null },
        JWT_SECRET,
        { algorithm: 'HS256' }
      );

      [tampered, alternateAlgorithm, accessToken].forEach((candidate) => {
        expect(() =>
          verifySessionChallengeToken({
            token: candidate,
            expectedApiAudience: API_AUDIENCE,
            jwtSecret: JWT_SECRET,
            now: NOW
          })
        ).toThrow('Invalid wallet auth challenge');
      });
    });

    it('rejects at the exact JWT expiration without applying SIWE skew', () => {
      const { challenge, token } = createSignedChallenge();

      expect(() =>
        verifySessionChallengeToken({
          token,
          expectedApiAudience: API_AUDIENCE,
          jwtSecret: JWT_SECRET,
          now: challenge.expirationTime
        })
      ).toThrow('Invalid wallet auth challenge');
    });

    it('accepts only structured authentication text in legacy signed-string tokens', () => {
      const legacyMessage = buildStructuredWalletSignatureMessage({
        kind: 'authentication',
        domain: '6529.io',
        clientOrigin: 'https://6529.io',
        sessionType: 'first_party_web',
        wallet: wallet.address,
        issuedAt: NOW,
        expirationTime: new Date(
          NOW.getTime() + SIWE_WALLET_AUTH_TTL_SECONDS * 1000
        ),
        nonce: 'legacy-web-challenge-nonce',
        action: 'login',
        purpose: 'Sign this message to authenticate with 6529.'
      });
      const legacyToken = jwt.sign(legacyMessage, JWT_SECRET, {
        algorithm: 'HS256'
      });
      const siweStringToken = jwt.sign(createChallenge().message, JWT_SECRET, {
        algorithm: 'HS256'
      });
      const malformedToken = jwt.sign('not a challenge', JWT_SECRET, {
        algorithm: 'HS256'
      });

      expect(
        verifySessionChallengeToken({
          token: legacyToken,
          expectedApiAudience: null,
          jwtSecret: JWT_SECRET,
          now: NOW
        })
      ).toEqual({ format: 'legacy', message: legacyMessage });
      expect(() =>
        verifySessionChallengeToken({
          token: siweStringToken,
          expectedApiAudience: API_AUDIENCE,
          jwtSecret: JWT_SECRET,
          now: NOW
        })
      ).toThrow('Invalid wallet auth challenge');
      expect(() =>
        verifySessionChallengeToken({
          token: malformedToken,
          expectedApiAudience: API_AUDIENCE,
          jwtSecret: JWT_SECRET,
          now: NOW
        })
      ).toThrow('Invalid wallet auth challenge');
      expect(
        parseStructuredWalletSignatureMessage(legacyMessage)
      ).not.toBeNull();
    });
  });

  describe('atomic replay protection', () => {
    it('consumes a valid nonce exactly once with the local test fallback', async () => {
      const verified = await createVerifiedChallenge();

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(true);
      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(false);
    });

    it('allows only one concurrent local consumption', async () => {
      const verified = await createVerifiedChallenge();

      const results = await Promise.all([
        consumeSiweWalletAuthNonce(verified),
        consumeSiweWalletAuthNonce(verified)
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('uses a hashed nonce in the namespaced Redis replay key', async () => {
      const set = jest.fn().mockResolvedValue('OK');
      getRedisClientMock.mockReturnValue({ set } as never);
      const verified = await createVerifiedChallenge();

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(true);
      const [key, value, options] = set.mock.calls[0];
      expect(key).toMatch(
        new RegExp(
          `^wallet_auth_siwe_nonce_v1:${wallet.address.toLowerCase()}:[a-f0-9]{64}$`
        )
      );
      expect(key).not.toContain(verified.nonce);
      expect(value).toBe('1');
      expect(options).toMatchObject({ NX: true });
    });

    it('fails closed without Redis in production', async () => {
      process.env.NODE_ENV = 'production';
      const verified = await createVerifiedChallenge();

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(false);
    });

    it('fails closed on Redis errors in production', async () => {
      process.env.NODE_ENV = 'production';
      getRedisClientMock.mockReturnValue({
        set: jest.fn().mockRejectedValue(new Error('sensitive RPC details'))
      } as never);
      const verified = await createVerifiedChallenge();

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(false);
    });

    it('uses the local fallback on Redis errors only in test/local', async () => {
      getRedisClientMock.mockReturnValue({
        set: jest.fn().mockRejectedValue(new Error('Redis unavailable'))
      } as never);
      const verified = await createVerifiedChallenge();

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(true);
    });

    it('rejects a challenge that expires after signature verification but before consumption', async () => {
      const verified = await createVerifiedChallenge();
      jest.useFakeTimers().setSystemTime(verified.expirationTime);

      await expect(consumeSiweWalletAuthNonce(verified)).resolves.toBe(false);
    });
  });

  function createChallenge(clientOrigin = 'https://6529.io') {
    return createSiweWebAuthChallenge({
      address: wallet.address,
      clientOrigin,
      chainId: 1,
      nonce: '32f7c245a8804dd895dc76df4dff137b',
      issuedAt: NOW
    });
  }

  function createSignedChallenge() {
    const challenge = createChallenge();
    return {
      challenge,
      token: signSiweWebAuthChallenge({
        challenge,
        apiAudience: API_AUDIENCE,
        jwtSecret: JWT_SECRET
      })
    };
  }

  async function createVerifiedChallenge() {
    jest.useFakeTimers().setSystemTime(NOW);
    const challenge = createChallenge();
    const signature = await wallet.signMessage(challenge.message);
    const verified = await verifyChallengeSignature(
      challenge.message,
      signature
    );
    if (!verified) {
      throw new Error('Test challenge did not verify');
    }
    return verified;
  }

  async function verifyChallengeSignature(
    message: string,
    signature: string,
    overrides: Partial<{
      expectedAddress: string;
      expectedChainId: number;
      expectedClientOrigin: string;
      now: Date;
    }> = {}
  ) {
    return verifySiweWebAuthSignature({
      message,
      signature,
      expectedAddress: overrides.expectedAddress ?? wallet.address,
      expectedChainId: overrides.expectedChainId ?? 1,
      expectedClientOrigin: overrides.expectedClientOrigin ?? 'https://6529.io',
      now: overrides.now ?? NOW
    });
  }

  function prepareMessage(
    overrides: Partial<SiweMessage>,
    expectConstructionToSucceed = true
  ): string {
    const params: Partial<SiweMessage> = {
      scheme: 'https',
      domain: '6529.io',
      address: wallet.address,
      statement: SIWE_WALLET_AUTH_STATEMENT,
      uri: 'https://6529.io',
      version: '1',
      chainId: 1,
      nonce: '32f7c245a8804dd895dc76df4dff137b',
      issuedAt: NOW.toISOString(),
      expirationTime: new Date(
        NOW.getTime() + SIWE_WALLET_AUTH_TTL_SECONDS * 1000
      ).toISOString(),
      ...overrides
    };
    if (expectConstructionToSucceed) {
      return new SiweMessage(params).prepareMessage();
    }
    try {
      return new SiweMessage(params).prepareMessage();
    } catch {
      const validMessage = new SiweMessage({
        ...params,
        nonce: '12345678'
      }).prepareMessage();
      return validMessage.replace('Nonce: 12345678', `Nonce: ${params.nonce}`);
    }
  }

  function resignEnvelope(
    token: string,
    overrides: Record<string, unknown>,
    algorithm: jwt.Algorithm = 'HS256'
  ): string {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === 'string') {
      throw new Error('Expected object JWT payload');
    }
    return jwt.sign({ ...decoded, ...overrides }, JWT_SECRET, { algorithm });
  }

  function mockContract(contract: { isValidSignature: jest.Mock }): void {
    const contractConstructor = jest.fn().mockImplementation(() => contract);
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(
        contractConstructor as unknown as typeof ethers.Contract
      );
  }
});

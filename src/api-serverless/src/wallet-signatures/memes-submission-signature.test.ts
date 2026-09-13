import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { DropHasher } from '@/api/drops/drop-hasher';
import { getRedisClient } from '@/redis';
import { clearStructuredWalletSignatureReplayCacheForTests } from '@/api/wallet-signatures/structured-wallet-signatures';
import fixture from './fixtures/memes-submission-v1.json';
import {
  MEMES_SUBMISSION_ACTION,
  MEMES_SUBMISSION_AGREEMENT,
  MEMES_SUBMISSION_DOMAIN,
  MEMES_SUBMISSION_NOTICE,
  MEMES_SUBMISSION_PRIMARY_TYPE,
  MEMES_SUBMISSION_TYPES,
  MemesSubmissionEnvelope,
  parseMemesSubmissionEnvelope,
  verifyMemesSubmissionSignature
} from './memes-submission-signature';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
const otherWallet = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f094538e9d874d2fe3df31d0f01e3be7f0ca0a84'
);
const waveId = '5a8a8d52-1935-4d07-89db-fce66dd50e12';
const waveName = 'The Memes Main Stage';
const terms = 'The Memes submission terms.\nI own the submitted artwork.';
const issuedAt = '2026-09-13T12:00:00.000Z';
const expiresAt = '2026-09-13T12:05:00.000Z';
const signingTypes = {
  MemeCardSubmission: MEMES_SUBMISSION_TYPES.MemeCardSubmission,
  SubmissionVerification: MEMES_SUBMISSION_TYPES.SubmissionVerification
};
const dropHasher = new DropHasher();
const mockRedisClient = jest.mocked(getRedisClient);

function createDrop(): ApiCreateDropRequest {
  return {
    wave_id: waveId,
    drop_type: ApiDropType.Participatory,
    title: 'A Meme for Tomorrow',
    parts: [
      {
        content: 'An artwork about an open future.',
        media: [
          { url: 'https://example.com/artwork.png', mime_type: 'image/png' }
        ]
      }
    ],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    signature: null,
    signer_address: wallet.address
  };
}

function createEnvelope(drop = createDrop()): MemesSubmissionEnvelope {
  return {
    domain: MEMES_SUBMISSION_DOMAIN,
    types: MEMES_SUBMISSION_TYPES,
    primaryType: MEMES_SUBMISSION_PRIMARY_TYPE,
    message: {
      Action: MEMES_SUBMISSION_ACTION,
      Artwork: drop.title!,
      Destination: waveName,
      Agreement: MEMES_SUBMISSION_AGREEMENT,
      Notice: MEMES_SUBMISSION_NOTICE,
      ExpiresAt: expiresAt,
      Verification: {
        Wallet: drop.signer_address!,
        WaveId: waveId,
        Audience: 'api.6529.io',
        Origin: 'https://6529.io',
        IssuedAt: issuedAt,
        Nonce: '24d3ca71-71e8-4b98-b417-1bbb282a8b41',
        PayloadHash: `0x${dropHasher.hash({ drop, termsOfService: terms })}`,
        TermsHash: `0x${createHash('sha256').update(terms).digest('hex')}`
      }
    }
  };
}

function sign(envelope: MemesSubmissionEnvelope): Promise<string> {
  return wallet.signTypedData(
    MEMES_SUBMISSION_DOMAIN,
    signingTypes,
    envelope.message
  );
}

function verify(
  envelope: MemesSubmissionEnvelope,
  signature: string,
  overrides: Partial<Parameters<typeof verifyMemesSubmissionSignature>[0]> = {}
): Promise<boolean> {
  const drop = createDrop();
  return verifyMemesSubmissionSignature({
    message: JSON.stringify(envelope),
    signature,
    drop,
    wallets: [wallet.address],
    payloadHash: dropHasher.hash({ drop, termsOfService: terms }),
    termsOfService: terms,
    expectedWaveId: waveId,
    expectedWaveName: waveName,
    expectedAudience: 'api.6529.io',
    ...overrides
  });
}

describe('The Memes EIP-712 submission signatures', () => {
  let isValidSignature: jest.Mock;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'test',
      ALCHEMY_API_KEY: 'test-key'
    });
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(issuedAt) + 60_000);
    mockRedisClient.mockReturnValue(null);
    clearStructuredWalletSignatureReplayCacheForTests();
    isValidSignature = jest.fn().mockResolvedValue('0xffffffff');
    const contract = jest.fn().mockImplementation(() => ({ isValidSignature }));
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(contract as unknown as typeof ethers.Contract);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('verifies a real typed EOA signature once and rejects replay', async () => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    await expect(verify(envelope, signature)).resolves.toBe(true);
    await expect(verify(envelope, signature)).resolves.toBe(false);
    expect(isValidSignature).not.toHaveBeenCalled();
  });

  it('matches the cross-client EIP-712 fixture and real signature', async () => {
    const envelope = createEnvelope();
    expect(createDrop()).toEqual(fixture.drop);
    expect(envelope).toEqual(fixture.typedData);
    expect(
      ethers.TypedDataEncoder.hash(
        MEMES_SUBMISSION_DOMAIN,
        signingTypes,
        envelope.message
      )
    ).toBe(fixture.typedDataHash);
    expect(await sign(envelope)).toBe(fixture.signature);
    await expect(verify(envelope, fixture.signature)).resolves.toBe(true);
  });

  it('allows only one concurrent use of a signed nonce', async () => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    const results = await Promise.all([
      verify(envelope, signature),
      verify(envelope, signature)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not consume a nonce when the wallet is outside the author identity', async () => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    await expect(
      verify(envelope, signature, { wallets: [otherWallet.address] })
    ).resolves.toBe(false);
    expect(mockRedisClient).not.toHaveBeenCalled();
    await expect(verify(envelope, signature)).resolves.toBe(true);
  });

  it.each([
    ['missing Main Stage configuration', { expectedWaveId: null }],
    ['different Main Stage', { expectedWaveId: 'another-wave' }],
    ['changed wave name', { expectedWaveName: 'Other wave' }],
    ['missing API host', { expectedAudience: null }],
    ['another API environment', { expectedAudience: 'api.staging.6529.io' }],
    ['changed terms', { termsOfService: `${terms}\nUpdated` }],
    ['missing terms', { termsOfService: null }],
    ['empty terms', { termsOfService: '  ' }],
    ['changed payload', { payloadHash: '0'.repeat(64) }]
  ])('rejects %s without consuming its nonce', async (_name, overrides) => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    await expect(verify(envelope, signature, overrides)).resolves.toBe(false);
    expect(mockRedisClient).not.toHaveBeenCalled();
  });

  it.each([
    ['chat', { drop_type: ApiDropType.Chat }],
    ['another wave', { wave_id: 'another-wave' }],
    ['changed artwork', { title: 'Different artwork' }],
    ['missing signer', { signer_address: undefined }],
    ['wrong signer', { signer_address: otherWallet.address }]
  ])('rejects a request with %s', async (_name, update) => {
    const envelope = createEnvelope();
    await expect(
      verify(envelope, await sign(envelope), {
        drop: { ...createDrop(), ...update }
      })
    ).resolves.toBe(false);
  });

  it('rejects a title that would be trimmed after signature verification', async () => {
    const drop = { ...createDrop(), title: ' A Meme for Tomorrow ' };
    const envelope = createEnvelope(drop);
    await expect(
      verify(envelope, await sign(envelope), {
        drop,
        payloadHash: dropHasher.hash({ drop, termsOfService: terms })
      })
    ).resolves.toBe(false);
  });

  it.each([
    ['Action', 'Transfer my assets'],
    ['Artwork', 'Another artwork'],
    ['Destination', 'Other stage'],
    ['Agreement', 'I do not agree'],
    ['Notice', 'A different authorization'],
    ['ExpiresAt', '2026-09-13T12:04:00.000Z']
  ] as const)('rejects tampering with readable %s', async (key, value) => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    envelope.message[key] = value;
    await expect(verify(envelope, signature)).resolves.toBe(false);
  });

  it.each([
    ['Wallet', otherWallet.address],
    ['WaveId', 'other-wave'],
    ['Audience', 'api.staging.6529.io'],
    ['Origin', 'https://another-client.example'],
    ['IssuedAt', '2026-09-13T12:00:01.000Z'],
    ['Nonce', '24d3ca71-71e8-4b98-b417-1bbb282a8b42'],
    ['PayloadHash', `0x${'0'.repeat(64)}`],
    ['TermsHash', `0x${'0'.repeat(64)}`]
  ] as const)('rejects tampering with verification %s', async (key, value) => {
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    envelope.message.Verification[key] = value;
    await expect(verify(envelope, signature)).resolves.toBe(false);
  });

  it.each([
    ['expired', issuedAt, '2026-09-13T12:01:00.000Z'],
    ['too long', issuedAt, '2026-09-13T12:05:00.001Z'],
    ['reversed', expiresAt, issuedAt],
    ['future', '2026-09-13T12:06:00.001Z', '2026-09-13T12:11:00.001Z'],
    ['noncanonical', '2026-09-13T12:00:00Z', expiresAt],
    ['invalid', 'invalid-date', expiresAt]
  ])('rejects %s signature timing', async (_name, issue, expiry) => {
    const envelope = createEnvelope();
    envelope.message.Verification.IssuedAt = issue;
    envelope.message.ExpiresAt = expiry;
    await expect(verify(envelope, await sign(envelope))).resolves.toBe(false);
  });

  it.each([
    'https://6529.io/path',
    'https://6529.io/',
    'https://user:pass@6529.io',
    'https://6529.io?query=1',
    'https://6529.io#fragment',
    'HTTPS://6529.IO',
    'capacitor://localhost',
    'null',
    'javascript:alert(1)'
  ])('rejects noncanonical client origin %s', async (origin) => {
    const envelope = createEnvelope();
    envelope.message.Verification.Origin = origin;
    await expect(verify(envelope, await sign(envelope))).resolves.toBe(false);
  });

  it.each(['https://localhost', 'https://community-client.example'])(
    'preserves valid native/external origin context %s',
    async (origin) => {
      const envelope = createEnvelope();
      envelope.message.Verification.Origin = origin;
      await expect(verify(envelope, await sign(envelope))).resolves.toBe(true);
    }
  );

  it('rejects personal_sign over the typed-data digest', async () => {
    const envelope = createEnvelope();
    const hash = ethers.TypedDataEncoder.hash(
      MEMES_SUBMISSION_DOMAIN,
      signingTypes,
      envelope.message
    );
    const signature = await wallet.signMessage(ethers.getBytes(hash));
    await expect(verify(envelope, signature)).resolves.toBe(false);
  });

  it('uses the exact EIP-712 digest for EIP-1271 even with a false Safe hint', async () => {
    const drop = {
      ...createDrop(),
      signer_address: otherWallet.address,
      is_safe_signature: false
    };
    const envelope = createEnvelope(drop);
    isValidSignature.mockResolvedValue('0x1626ba7e');
    const signature = '0x1234';
    await expect(
      verify(envelope, signature, {
        drop,
        wallets: [otherWallet.address],
        payloadHash: dropHasher.hash({ drop, termsOfService: terms })
      })
    ).resolves.toBe(true);
    expect(isValidSignature).toHaveBeenCalledWith(
      ethers.TypedDataEncoder.hash(
        MEMES_SUBMISSION_DOMAIN,
        signingTypes,
        envelope.message
      ),
      signature
    );
  });

  it('rejects a reverting contract-wallet verification', async () => {
    isValidSignature.mockRejectedValue(new Error('contract reverted'));
    await expect(verify(createEnvelope(), '0x1234')).resolves.toBe(false);
  });

  it('uses an atomic Redis nonce reservation for the remaining lifetime', async () => {
    const set = jest
      .fn()
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null);
    mockRedisClient.mockReturnValue({ set } as unknown as NonNullable<
      ReturnType<typeof getRedisClient>
    >);
    const envelope = createEnvelope();
    const signature = await sign(envelope);
    await expect(verify(envelope, signature)).resolves.toBe(true);
    await expect(verify(envelope, signature)).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.stringContaining(
        `wallet_signature_nonce_v2:create_drop:${wallet.address.toLowerCase()}:`
      ),
      '1',
      { NX: true, EX: 240 }
    );
  });

  it.each(['missing', 'error'])(
    'fails closed when production Redis is %s',
    async (state) => {
      process.env.NODE_ENV = 'production';
      if (state === 'error') {
        mockRedisClient.mockReturnValue({
          set: jest.fn().mockRejectedValue(new Error('Redis unavailable'))
        } as unknown as NonNullable<ReturnType<typeof getRedisClient>>);
      }
      const envelope = createEnvelope();
      await expect(verify(envelope, await sign(envelope))).resolves.toBe(false);
    }
  );
});

describe('The Memes typed envelope schema', () => {
  it('parses the exact contract and tolerates JSON property ordering', () => {
    const envelope = createEnvelope();
    expect(parseMemesSubmissionEnvelope(JSON.stringify(envelope))).toEqual(
      envelope
    );
    expect(
      parseMemesSubmissionEnvelope(
        JSON.stringify({
          message: envelope.message,
          primaryType: envelope.primaryType,
          types: envelope.types,
          domain: envelope.domain
        })
      )
    ).toEqual(envelope);
  });

  it.each([
    '',
    'not JSON',
    'null',
    '[]',
    '{}',
    '1',
    JSON.stringify({ message: '0'.repeat(32_768) })
  ])('rejects malformed or oversized envelope %#', (raw) => {
    expect(parseMemesSubmissionEnvelope(raw)).toBeNull();
  });

  it.each([
    ['version', { domain: { ...MEMES_SUBMISSION_DOMAIN, version: '2' } }],
    ['name', { domain: { ...MEMES_SUBMISSION_DOMAIN, name: 'Other app' } }],
    ['chain', { domain: { ...MEMES_SUBMISSION_DOMAIN, chainId: 5 } }],
    ['coerced chain', { domain: { ...MEMES_SUBMISSION_DOMAIN, chainId: '1' } }],
    [
      'contract',
      {
        domain: {
          ...MEMES_SUBMISSION_DOMAIN,
          verifyingContract: wallet.address
        }
      }
    ],
    ['primary type', { primaryType: 'OtherSubmission' }],
    ['extra envelope field', { extra: true }],
    [
      'untrusted types',
      {
        types: {
          ...MEMES_SUBMISSION_TYPES,
          MemeCardSubmission: [{ name: 'Action', type: 'string' }]
        }
      }
    ]
  ])('rejects changed %s', (_name, update) => {
    expect(
      parseMemesSubmissionEnvelope(
        JSON.stringify({ ...createEnvelope(), ...update })
      )
    ).toBeNull();
  });

  it('rejects unknown message and verification fields', () => {
    const envelope = createEnvelope();
    expect(
      parseMemesSubmissionEnvelope(
        JSON.stringify({
          ...envelope,
          message: { ...envelope.message, Extra: true }
        })
      )
    ).toBeNull();
    expect(
      parseMemesSubmissionEnvelope(
        JSON.stringify({
          ...envelope,
          message: {
            ...envelope.message,
            Verification: { ...envelope.message.Verification, Extra: true }
          }
        })
      )
    ).toBeNull();
  });

  it.each(['', 'short', '24d3ca71-71e8-1b98-b417-1bbb282a8b41'])(
    'rejects a nonce outside the UUID v4 contract: %s',
    (nonce) => {
      const envelope = createEnvelope();
      envelope.message.Verification.Nonce = nonce;
      expect(parseMemesSubmissionEnvelope(JSON.stringify(envelope))).toBeNull();
    }
  );
});

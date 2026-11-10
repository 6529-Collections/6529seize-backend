import { keccak256, toUtf8Bytes, Wallet } from 'ethers';
import {
  createSanctionsRelease,
  releaseSigningBytes,
  SanctionsKeysV1,
  SanctionsReleaseEnvelope,
  SanctionsReleaseError,
  verifySanctionsRelease
} from '@/sanctions/sanctions-release';
import { readSanctionsVector } from '@/sanctions/sanctions-spec-files';

interface ReleaseVector {
  test_key_seed: string;
  other_key_seed: string;
  payload_utf8: string;
  signing_message_utf8: string;
  envelope: SanctionsReleaseEnvelope;
  keys: SanctionsKeysV1;
  other_signer: { address: string; sig: string };
}

const vector = readSanctionsVector<ReleaseVector>('release.json');
const payload = Buffer.from(vector.payload_utf8, 'utf8');
const beforeExpiry = new Date('2026-01-20T00:00:00Z');

function testWallet(seed: string): Wallet {
  return new Wallet(keccak256(toUtf8Bytes(seed)));
}

function withThreshold(threshold: number, extraKey?: string): SanctionsKeysV1 {
  const keys = vector.keys.roles.sanctions.keys.slice();
  if (extraKey) {
    keys.push({ keyid: extraKey, method: 'eip191-secp256k1' });
  }
  return {
    schema: vector.keys.schema,
    roles: { sanctions: { threshold, keys } }
  };
}

describe('createSanctionsRelease', () => {
  it('reproduces the vector envelope and signing bytes', async () => {
    const { signed } = vector.envelope;
    const envelope = await createSanctionsRelease(
      {
        payloadBytes: payload,
        sequence: signed.sequence,
        publishedAt: signed.published_at,
        expiresAt: signed.expires_at,
        previous: signed.previous,
        policy: signed.policy
      },
      [testWallet(vector.test_key_seed)]
    );
    expect(envelope).toEqual(vector.envelope);
    expect(releaseSigningBytes(envelope.signed).toString('utf8')).toBe(
      vector.signing_message_utf8
    );
  });

  it.each([
    ['a zero sequence', { sequence: 0 }],
    ['a local timestamp', { publishedAt: '2026-01-15T06:15:00+01:00' }],
    ['milliseconds', { expiresAt: '2026-01-29T06:15:00.000Z' }]
  ])('refuses %s', async (_label, override) => {
    await expect(
      createSanctionsRelease(
        {
          payloadBytes: payload,
          sequence: 1,
          publishedAt: '2026-01-15T06:15:00Z',
          expiresAt: '2026-01-29T06:15:00Z',
          previous: null,
          policy: { id: 'p', version: '1' },
          ...override
        },
        []
      )
    ).rejects.toThrow(SanctionsReleaseError);
  });
});

describe('verifySanctionsRelease', () => {
  it('accepts the vector release', () => {
    expect(
      verifySanctionsRelease(vector.envelope, vector.keys, payload, {
        now: beforeExpiry
      })
    ).toEqual({
      sequence: 2,
      signers: [vector.keys.roles.sanctions.keys[0].keyid],
      expired: false
    });
  });

  it('reports expiry without failing (never fail open)', () => {
    const result = verifySanctionsRelease(
      vector.envelope,
      vector.keys,
      payload,
      {
        now: new Date('2026-02-01T00:00:00Z')
      }
    );
    expect(result.expired).toBe(true);
  });

  it('refuses a release signed by a key that is not pinned', () => {
    const keys: SanctionsKeysV1 = {
      schema: vector.keys.schema,
      roles: {
        sanctions: {
          threshold: 1,
          keys: [
            { keyid: vector.other_signer.address, method: 'eip191-secp256k1' }
          ]
        }
      }
    };
    expect(() =>
      verifySanctionsRelease(vector.envelope, keys, payload, {
        now: beforeExpiry
      })
    ).toThrow(/0 valid signature/);
  });

  it('refuses a signature whose keyid does not match its signer', () => {
    const envelope: SanctionsReleaseEnvelope = {
      ...vector.envelope,
      signatures: [
        { ...vector.envelope.signatures[0], sig: vector.other_signer.sig }
      ]
    };
    expect(() =>
      verifySanctionsRelease(envelope, vector.keys, payload, {
        now: beforeExpiry
      })
    ).toThrow(/0 valid signature/);
  });

  it('refuses a tampered payload', () => {
    const tampered = Buffer.from(vector.payload_utf8.replace('true', 'fals'));
    expect(() =>
      verifySanctionsRelease(vector.envelope, vector.keys, tampered, {
        now: beforeExpiry
      })
    ).toThrow(/payload does not match/);
  });

  it('refuses a tampered signed body', () => {
    const envelope: SanctionsReleaseEnvelope = {
      ...vector.envelope,
      signed: { ...vector.envelope.signed, sequence: 3 }
    };
    expect(() =>
      verifySanctionsRelease(envelope, vector.keys, payload, {
        now: beforeExpiry
      })
    ).toThrow(/0 valid signature/);
  });

  it('refuses a rollback to an older or equal sequence', () => {
    expect(() =>
      verifySanctionsRelease(vector.envelope, vector.keys, payload, {
        now: beforeExpiry,
        minSequence: 2
      })
    ).toThrow(/not newer/);
  });

  it('enforces a threshold of distinct pinned signers', () => {
    const twoOfTwo = withThreshold(2, vector.other_signer.address);
    expect(() =>
      verifySanctionsRelease(vector.envelope, twoOfTwo, payload, {
        now: beforeExpiry
      })
    ).toThrow(/1 valid signature\(s\); 2 required/);

    const duplicated: SanctionsReleaseEnvelope = {
      ...vector.envelope,
      signatures: [vector.envelope.signatures[0], vector.envelope.signatures[0]]
    };
    expect(() =>
      verifySanctionsRelease(duplicated, twoOfTwo, payload, {
        now: beforeExpiry
      })
    ).toThrow(/2 required/);

    const both: SanctionsReleaseEnvelope = {
      ...vector.envelope,
      signatures: [
        vector.envelope.signatures[0],
        {
          keyid: vector.other_signer.address,
          method: 'eip191-secp256k1',
          sig: vector.other_signer.sig
        }
      ]
    };
    expect(
      verifySanctionsRelease(both, twoOfTwo, payload, { now: beforeExpiry })
        .signers
    ).toHaveLength(2);
  });
});

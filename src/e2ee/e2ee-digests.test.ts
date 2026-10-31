import * as fc from 'fast-check';
import { concat, getBytes, keccak256, toBeHex, toUtf8Bytes } from 'ethers';
import {
  E2EE_DIGEST_NAMES,
  E2EE_ZERO_32,
  e2eeEntryDigest,
  e2eeEntryWrapAad,
  e2eeEpochCommitment,
  e2eeFingerprint,
  e2eeMessageDigest,
  e2eeMessageWrapAad,
  E2eeEntryKind,
  e2eeRevokeDigest,
  e2eeRosterDigest,
  e2eeSortedDeviceKeys,
  e2eeTag,
  verifyE2eeEd25519
} from '@/e2ee/e2ee-digests';
import { e2eeKeyFromSeed, randomE2eeKey } from '@/tests/fixtures/e2ee.fixture';

// Known answers shared with the WASM/Rust module (e2ee-digest-vectors.json).
const label = (value: string) => keccak256(toUtf8Bytes(value));
const G = label('6529 e2ee test group');
const COMMIT_KEY_7 = e2eeKeyFromSeed(
  label('6529 e2ee test commit key epoch 7')
);
const COMMIT_KEY_8 = e2eeKeyFromSeed(
  label('6529 e2ee test commit key epoch 8')
);
const DEVICE_1 = e2eeKeyFromSeed(label('6529 e2ee test device 1'));
const DEVICE_2 = e2eeKeyFromSeed(label('6529 e2ee test device 2'));
const DEVICE_3 = e2eeKeyFromSeed(label('6529 e2ee test device 3'));
const ENTRY_DATA = new Uint8Array(2048).map((_, i) => i % 251);
const BODY = toUtf8Bytes(
  '{"v":1,"t":"msg","id":"00112233445566778899aabbccddeeff","ts":1760000000000,"text":"hello"}'
);

/** Independent encoder: 32-byte big-endian words, no AbiCoder. */
function word(value: string | number | bigint): string {
  if (typeof value === 'string') return value;
  return toBeHex(BigInt(value), 32);
}

function manualHash(name: string, values: (string | number | bigint)[]) {
  return keccak256(concat([label(name), ...values.map(word)]));
}

describe('E2EE digests', () => {
  it('matches the shared tags', () => {
    expect(e2eeTag(E2EE_DIGEST_NAMES.entry)).toBe(
      '0xb9e79460fc01cea6b3f1c6ade1899499dcc2a6206f75b6097630c9df36b7229d'
    );
    expect(e2eeTag(E2EE_DIGEST_NAMES.roster)).toBe(
      '0xe43921de9eb07f53d934cd02c46d2eeb15d17ddfd176bcf6ce9573edbef24205'
    );
    expect(e2eeTag(E2EE_DIGEST_NAMES.revoke)).toBe(
      '0xbacfeaa8a6998868f4d017f41f7f3149f1eb84bc48e829f20433af47c43bcb50'
    );
    expect(e2eeTag(E2EE_DIGEST_NAMES.message)).toBe(
      '0xcb3fbf90e3f89488c067dcf74257a74993a2fbf7c532505a9d81de235499e1bb'
    );
  });

  it('matches the shared key derivations', () => {
    expect(G).toBe(
      '0xa7d73b1e44ece08fbc9aa5f15cabb9c4acf864fa61971dfca0e33ffd6c2b9c69'
    );
    expect(COMMIT_KEY_7.publicKey).toBe(
      '0x6263eee99c33a72f6396ed93718578081d88a476c1f02a5775c5dc6e69465b5d'
    );
    expect(COMMIT_KEY_8.publicKey).toBe(
      '0x8b588022fa1f8d17786cfe6290c7f51af5c422c82510259058d55dd2a944f9ed'
    );
    expect(DEVICE_1.publicKey).toBe(
      '0x677b3d7b1775509a6eeffa28ef785652291356d3569fbb8a189b54bd0d684a83'
    );
  });

  it('matches the commit and proposal entry digest vectors', () => {
    const entryHash = keccak256(ENTRY_DATA);
    expect(entryHash).toBe(
      '0x7011a2293052db045ce02a115cb73bbb7991fecb54f392f98bd026d59e0eaf59'
    );
    const epochCommitment = e2eeEpochCommitment({
      group: G,
      epoch: 8,
      groupContextHash: label('group context 8')
    });
    expect(epochCommitment).toBe(
      '0xb4ea0b40f50b2844ef0318e2fd110722eee1050002ef826eb6cc4157354f35d1'
    );
    const commitDigest = e2eeEntryDigest({
      group: G,
      epoch: 7,
      kind: E2eeEntryKind.COMMIT,
      entryHash,
      epochCommitment,
      nextCommitKey: COMMIT_KEY_8.publicKey,
      paddedLen: 2048
    });
    expect(commitDigest).toBe(
      '0x14f86a7f94b1b1dbec0835abfcedc8af73f1a213ea0e06e7033995e90c718ead'
    );
    expect(COMMIT_KEY_7.sign(commitDigest)).toBe(
      '0x87f87617e7b6824913dde3b776a515af00dbf3bd718763a964305842050b81dd8e2af8a1dc09d0b43a20dda9765c759bdfac787dd93d0b3499434a8997ec6c05'
    );
    expect(
      e2eeEntryDigest({
        group: G,
        epoch: 7,
        kind: E2eeEntryKind.PROPOSAL,
        entryHash,
        epochCommitment: E2EE_ZERO_32,
        nextCommitKey: E2EE_ZERO_32,
        paddedLen: 2048
      })
    ).toBe(
      '0x29e75cdb7633efdaf8e223a330d5a89ae95e190fa21fd74f4e254861df727345'
    );
  });

  it('matches the roster, revoke, message, AAD and fingerprint vectors', () => {
    const rosterDigest = e2eeRosterDigest({
      group: G,
      epoch: 7,
      deviceKeys: [DEVICE_2.publicKey, DEVICE_3.publicKey, DEVICE_1.publicKey]
    });
    expect(rosterDigest).toBe(
      '0xbc17535eb615f03502edb5b99a9879c4a3a4f6f392bb219cb7e4f8635ce26bbf'
    );
    expect(
      e2eeRevokeDigest({
        targetDeviceKey: DEVICE_2.publicKey,
        revokerDeviceKey: DEVICE_1.publicKey,
        revokedAtSeconds: 1760270460
      })
    ).toBe(
      '0xf63029771ee9a9693d50df890a19408b0f8eee13bc39a77fff0e44eaffbb9156'
    );
    const messageDigest = e2eeMessageDigest({ group: G, epoch: 7, body: BODY });
    expect(messageDigest).toBe(
      '0x30b87c15aa025801f880c14ec71401d26ff201a3101a42275533991ba476531b'
    );
    expect(DEVICE_1.sign(messageDigest)).toBe(
      '0x8e397fbb01a38154e80c22eeab8fb38e697bdc99b5879f8753c5ac8cf1d32d425b409f66d6d2823374d65231c93c6bcb7d8565c7f08c557c8faa773d2e61a90b'
    );
    expect(
      e2eeEntryWrapAad({ group: G, epoch: 7, kind: E2eeEntryKind.COMMIT })
    ).toBe(
      '0x0a99747eb5f4414fbf11bf3788fa1ed2ff8a91d9a835740a23bec81900778566'
    );
    expect(e2eeMessageWrapAad({ group: G, epoch: 7 })).toBe(
      '0xa6c8cc3cf8d4cf40143a4e1aa386d88007a5b6ebf504d7ea3ff220c226aa4981'
    );
    expect(e2eeFingerprint(toUtf8Bytes('epoch authenticator 7'))).toBe(
      'ae6fe11a41a980cb'
    );
  });

  it('encodes entry digests as concatenated 32-byte words', () => {
    const hex32 = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((bytes) => `0x${Buffer.from(bytes).toString('hex')}`);
    fc.assert(
      fc.property(
        hex32,
        fc.nat({ max: 0xffffffff }),
        fc.constantFrom(E2eeEntryKind.COMMIT, E2eeEntryKind.PROPOSAL),
        hex32,
        hex32,
        hex32,
        fc.nat({ max: 0xffffffff }),
        (group, epoch, kind, entryHash, epochCommitment, key, paddedLen) => {
          expect(
            e2eeEntryDigest({
              group,
              epoch,
              kind,
              entryHash,
              epochCommitment,
              nextCommitKey: key,
              paddedLen
            })
          ).toBe(
            manualHash(E2EE_DIGEST_NAMES.entry, [
              group,
              epoch,
              kind,
              entryHash,
              epochCommitment,
              key,
              paddedLen
            ])
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it('encodes revoke digests with a uint64 timestamp', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(64),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (revokedAt, bytes) => {
          const key = `0x${Buffer.from(bytes).toString('hex')}`;
          expect(
            e2eeRevokeDigest({
              targetDeviceKey: key,
              revokerDeviceKey: E2EE_ZERO_32,
              revokedAtSeconds: Number(revokedAt % BigInt(2 ** 50))
            })
          ).toBe(
            manualHash(E2EE_DIGEST_NAMES.revoke, [
              key,
              E2EE_ZERO_32,
              revokedAt % BigInt(2 ** 50)
            ])
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it('makes the roster digest independent of input order', () => {
    const keys = [DEVICE_1, DEVICE_2, DEVICE_3].map((it) => it.publicKey);
    fc.assert(
      fc.property(fc.shuffledSubarray(keys, { minLength: 3 }), (shuffled) => {
        expect(
          e2eeRosterDigest({ group: G, epoch: 1, deviceKeys: shuffled })
        ).toBe(e2eeRosterDigest({ group: G, epoch: 1, deviceKeys: keys }));
      })
    );
    expect(e2eeSortedDeviceKeys(['0xbb', '0xaa'])).toEqual(['0xaa', '0xbb']);
  });

  it('rejects out-of-range fields', () => {
    expect(() =>
      e2eeEntryDigest({
        group: G,
        epoch: 2 ** 32,
        kind: E2eeEntryKind.COMMIT,
        entryHash: E2EE_ZERO_32,
        epochCommitment: E2EE_ZERO_32,
        nextCommitKey: E2EE_ZERO_32,
        paddedLen: 1
      })
    ).toThrow();
  });

  it('verifies Ed25519 signatures and rejects tampering or malformed input', () => {
    const key = randomE2eeKey();
    const digest = label('payload');
    const signature = key.sign(digest);
    expect(verifyE2eeEd25519(key.publicKey, digest, signature)).toBe(true);
    expect(verifyE2eeEd25519(key.publicKey, label('other'), signature)).toBe(
      false
    );
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`;
    expect(verifyE2eeEd25519(key.publicKey, digest, flipped)).toBe(false);
    expect(
      verifyE2eeEd25519(randomE2eeKey().publicKey, digest, signature)
    ).toBe(false);
    expect(verifyE2eeEd25519('0x1234', digest, signature)).toBe(false);
    expect(verifyE2eeEd25519(key.publicKey, digest, '0x')).toBe(false);
    expect(getBytes(signature)).toHaveLength(64);
  });
});

import { randomBytes } from 'node:crypto';
import { hexBytes, VECTORS } from './record-test-fixtures';
import {
  decodeKeysDocument,
  encodeKeysDocument,
  hpkeOpenBase,
  hpkeSealBase,
  loadProviderKeys,
  openSealedItems,
  readSealedItemsHeader,
  SealedClass,
  SealedFormatError,
  sealItems,
  unwrapSenderKey,
  wrapSenderKey,
  x25519PublicKeyOf
} from './sealed-crypto';

const rfc = VECTORS.rfc9180A1;
const inputs = VECTORS.inputs;
const PV_WAVE = VECTORS.sealedSettings.event.wave;
const senderKey = hexBytes(inputs.senderKey);
const provider = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};

function sealedC(): Buffer {
  const body = JSON.parse(VECTORS.sealedSettings.event.body!) as { c: string };
  return Buffer.from(body.c, 'base64url');
}

describe('HPKE base mode (RFC 9180 A.1.1)', () => {
  it('derives the recipient public key', () => {
    expect(x25519PublicKeyOf(hexBytes(rfc.skRm))).toEqual(hexBytes(rfc.pkRm));
  });

  it('reproduces the RFC ciphertext for sequence 0', () => {
    const { enc, ct } = hpkeSealBase({
      recipientPublicKey: hexBytes(rfc.pkRm),
      info: hexBytes(rfc.info),
      aad: hexBytes(rfc.aad),
      plaintext: hexBytes(rfc.pt),
      ephemeralPrivateKey: hexBytes(rfc.skEm)
    });
    expect(enc).toEqual(hexBytes(rfc.pkEm));
    expect(ct).toEqual(hexBytes(rfc.ct));
  });

  it('opens the RFC ciphertext and refuses another info', () => {
    const args = {
      recipientPrivateKey: hexBytes(rfc.skRm),
      enc: hexBytes(rfc.pkEm),
      aad: hexBytes(rfc.aad),
      ct: hexBytes(rfc.ct)
    };
    expect(hpkeOpenBase({ ...args, info: hexBytes(rfc.info) })).toEqual(
      hexBytes(rfc.pt)
    );
    expect(() =>
      hpkeOpenBase({ ...args, info: Buffer.from('another info') })
    ).toThrow();
  });
});

describe('sealed items (format 0x01)', () => {
  it('reproduces the vector bytes', () => {
    const c = sealItems({
      wave: PV_WAVE,
      cls: SealedClass.PROVIDER,
      gen: 1,
      deviceKey: inputs.deviceKey,
      senderKey,
      items: [{ t: 'mute', k: inputs.target, b: {} }],
      nonce: hexBytes(inputs.sealNonce)
    });
    expect(`0x${c.toString('hex')}`).toBe(VECTORS.sealedSettings.c);
    expect(c).toEqual(sealedC());
  });

  it('opens the vector and reads its clear header', () => {
    expect(readSealedItemsHeader(sealedC())).toEqual({
      cls: 1,
      gen: 1,
      deviceKey: inputs.deviceKey
    });
    expect(
      openSealedItems({ wave: PV_WAVE, bytes: sealedC(), senderKey })
    ).toEqual({
      cls: 1,
      gen: 1,
      deviceKey: inputs.deviceKey,
      items: [{ t: 'mute', k: inputs.target, b: {} }]
    });
  });

  it('refuses another key, another stream and a changed header', () => {
    expect(() =>
      openSealedItems({
        wave: PV_WAVE,
        bytes: sealedC(),
        senderKey: randomBytes(32)
      })
    ).toThrow(SealedFormatError);
    expect(() =>
      openSealedItems({
        wave: PV_WAVE.replace(/1$/, '2'),
        bytes: sealedC(),
        senderKey
      })
    ).toThrow(SealedFormatError);
    const changed = sealedC();
    changed[5] = 2; // generation 1 -> 2
    expect(() =>
      openSealedItems({ wave: PV_WAVE, bytes: changed, senderKey })
    ).toThrow(SealedFormatError);
  });

  it('pads to the buckets and refuses what does not fit', () => {
    const seal = (size: number) =>
      sealItems({
        wave: PV_WAVE,
        cls: SealedClass.OWN,
        gen: 7,
        deviceKey: inputs.deviceKey,
        senderKey,
        items: [{ t: 'bookmark', k: 'x', b: { note: 'a'.repeat(size) } }]
      });
    // header 50 + tag 16 around each padded plaintext
    expect(seal(10).length).toBe(50 + 256 + 16);
    expect(seal(500).length).toBe(50 + 1024 + 16);
    expect(seal(20_000).length).toBe(50 + 32_768 + 16);
    expect(() => seal(40_000)).toThrow('too large');
  });

  it('round-trips unset items and refuses malformed ones', () => {
    const items = [
      { t: 'pin', k: 'w1', b: { pos: 'a0' } },
      { t: 'pin', k: 'w2', b: null }
    ];
    const bytes = sealItems({
      wave: PV_WAVE,
      cls: SealedClass.PROVIDER,
      gen: 2,
      deviceKey: inputs.deviceKey,
      senderKey,
      items
    });
    expect(openSealedItems({ wave: PV_WAVE, bytes, senderKey }).items).toEqual(
      items
    );
    const bad = (item: unknown) => () =>
      sealItems({
        wave: PV_WAVE,
        cls: SealedClass.PROVIDER,
        gen: 1,
        deviceKey: inputs.deviceKey,
        senderKey,
        items: [item as never]
      });
    expect(bad({ t: 'Mute', k: 'x', b: {} })).toThrow(SealedFormatError);
    expect(bad({ t: 'mute', k: 'x'.repeat(201), b: {} })).toThrow(
      SealedFormatError
    );
    expect(bad({ t: 'mute', k: 'x', b: [] })).toThrow(SealedFormatError);
    expect(bad({ t: 'mute', k: 'x', b: {}, extra: 1 })).toThrow(
      SealedFormatError
    );
    expect(() =>
      sealItems({
        wave: PV_WAVE,
        cls: 3,
        gen: 1,
        deviceKey: inputs.deviceKey,
        senderKey,
        items
      })
    ).toThrow('unknown sealed class');
  });
});

describe('keys documents and wraps (format 0x02)', () => {
  const wrapArgs = {
    wave: PV_WAVE,
    cls: SealedClass.PROVIDER,
    gen: 1,
    from: inputs.deviceKey,
    to: `svc:${inputs.providerKeyId}`
  };

  it('reproduces the vector wrap and keys document', () => {
    const wrap = wrapSenderKey({
      ...wrapArgs,
      recipientPublicKey: provider.publicKey,
      senderKey,
      ephemeralPrivateKey: hexBytes(inputs.wrapEphemeralPrivateKey)
    });
    expect(`0x${Buffer.from(wrap.enc, 'base64url').toString('hex')}`).toBe(
      VECTORS.keys.enc
    );
    expect(`0x${Buffer.from(wrap.ct, 'base64url').toString('hex')}`).toBe(
      VECTORS.keys.ct
    );
    const doc = {
      v: 1 as const,
      dev: inputs.deviceKey,
      box: null,
      wraps: [wrap]
    };
    const body = JSON.parse(VECTORS.keys.event.body!) as { c: string };
    expect(encodeKeysDocument(doc).toString('base64url')).toBe(body.c);
    expect(decodeKeysDocument(Buffer.from(body.c, 'base64url'))).toEqual(doc);
  });

  it('unwraps with the provider key and only for its recipient', () => {
    const wrap = wrapSenderKey({
      ...wrapArgs,
      recipientPublicKey: provider.publicKey,
      senderKey
    });
    expect(unwrapSenderKey({ wave: PV_WAVE, wrap, provider })).toEqual(
      senderKey
    );
    expect(() =>
      unwrapSenderKey({
        wave: PV_WAVE,
        wrap: { ...wrap, to: 'svc:other' },
        provider
      })
    ).toThrow('another recipient');
    expect(() =>
      unwrapSenderKey({ wave: PV_WAVE, wrap: { ...wrap, gen: 2 }, provider })
    ).toThrow();
  });

  it('refuses malformed documents', () => {
    const encode = (doc: unknown) =>
      Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify(doc))]);
    expect(() => decodeKeysDocument(Buffer.from([1, 2, 3]))).toThrow(
      'not a keys document'
    );
    expect(() =>
      decodeKeysDocument(encode({ v: 1, dev: 'x', box: null, wraps: [] }))
    ).toThrow('malformed');
    expect(() =>
      decodeKeysDocument(
        Buffer.concat([
          Buffer.from([2]),
          Buffer.from(
            `{"v":1,"dev":"${inputs.deviceKey}","box":null,"wraps":[]}`
          )
        ])
      )
    ).toThrow('malformed'); // keys out of canonical order
  });
});

describe('loadProviderKeys', () => {
  it('reads ids and derives public keys', () => {
    expect(
      loadProviderKeys(
        JSON.stringify([
          { id: inputs.providerKeyId, private_key: inputs.providerPrivateKey }
        ])
      )
    ).toEqual([provider]);
    expect(loadProviderKeys(undefined)).toEqual([]);
    expect(loadProviderKeys(' ')).toEqual([]);
  });

  it('refuses malformed entries', () => {
    expect(() => loadProviderKeys('{}')).toThrow('JSON array');
    expect(() =>
      loadProviderKeys(JSON.stringify([{ id: 'Bad Id', private_key: '0x00' }]))
    ).toThrow(SealedFormatError);
  });
});

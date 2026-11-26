import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import { createHash } from 'node:crypto';
import {
  canonicalDocBytes,
  entryManifestDoc
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  checkEntryManifest,
  DOC_CLASS,
  docCid,
  MAX_MANIFEST_BYTES,
  docCommitment,
  nonceWordOf,
  StoredDocuments
} from './waves-chain-mirror.docs';

const D = `0x${'d1'.repeat(32)}`;
const W = `0x${'0e'.repeat(32)}`;
const A = `0x${'a1'.repeat(32)}`;
const E = `0x${'e1'.repeat(32)}`;
const NONCE = `0x${'5a'.repeat(16)}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return entryManifestDoc({
    nonce: NONCE,
    decision: D,
    wave: W,
    author: A,
    createdAt: 1_764_000_000_000,
    fields: { title: 'An entry', parts: [{ content: 'hello', media: [] }] },
    ...overrides
  });
}

const subject = (doc: ReturnType<typeof manifest>) => ({
  entryId: E,
  decisionId: D,
  author: A,
  manifestHash: doc.manifestHash,
  contentCid: doc.contentCid
});

describe('waves chain mirror documents', () => {
  it("computes the CID and the chain's document commitment as the frontend does", () => {
    const bytes = canonicalDocBytes({ b: 1, a: 'x' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('{"a":"x","b":1}\n');
    expect(docCid(bytes)).toBe(
      `0x01551220${createHash('sha256').update(bytes).digest('hex')}`
    );
    const nonceWord = nonceWordOf(NONCE)!;
    expect(nonceWord).toBe(`${NONCE}${'00'.repeat(16)}`);
    // abi.encode(TAG, uint8, bytes32, bytes32), hashed: H(name, fields).
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint8', 'bytes32', 'bytes32'],
        [
          keccak256(toUtf8Bytes('6529.OffchainDoc.v1')),
          8,
          nonceWord,
          keccak256(bytes)
        ]
      )
    );
    expect(docCommitment(DOC_CLASS.ENTRY_MANIFEST, nonceWord, bytes)).toBe(
      expected
    );
  });

  it('accepts a manifest whose CID, commitment, decision and author check', () => {
    const doc = manifest();
    const check = checkEntryManifest(doc.bytes, subject(doc));
    expect(check).toEqual({
      ok: true,
      manifest: {
        nonce: NONCE,
        decision: D,
        wave: W,
        author: A,
        createdAt: 1_764_000_000_000,
        consent: null,
        fields: { title: 'An entry', parts: [{ content: 'hello', media: [] }] }
      }
    });
  });

  it('refuses a manifest that does not check, saying why', () => {
    const doc = manifest();
    const other = manifest({ fields: { title: 'Another' } });
    const reason = (bytes: Uint8Array, s: Record<string, unknown> = {}) => {
      const check = checkEntryManifest(bytes, { ...subject(doc), ...s });
      return check.ok ? 'ok' : check.reason;
    };
    expect(reason(other.bytes)).toBe('cid_mismatch');
    expect(reason(doc.bytes, { manifestHash: other.manifestHash })).toBe(
      'commitment_mismatch'
    );
    expect(reason(doc.bytes, { decisionId: E })).toBe('decision_mismatch');
    expect(reason(doc.bytes, { author: E })).toBe('author_mismatch');
    expect(reason(doc.bytes, { contentCid: null })).toBe(
      'no_manifest_reference'
    );
    expect(reason(doc.bytes, { contentCid: '0x0102' })).toBe('bad_content_cid');
    const notJson = new TextEncoder().encode('not json\n');
    expect(
      checkEntryManifest(notJson, {
        ...subject(doc),
        contentCid: docCid(notJson)
      })
    ).toEqual({ ok: false, reason: 'not_json' });
    const wrongKind = manifest({ kind: 'wave' });
    expect(checkEntryManifest(wrongKind.bytes, subject(wrongKind))).toEqual({
      ok: false,
      reason: 'not_an_entry_manifest'
    });
    const badNonce = manifest({ nonce: '0x12' });
    expect(checkEntryManifest(badNonce.bytes, subject(badNonce))).toEqual({
      ok: false,
      reason: 'bad_nonce'
    });
  });

  it('reads documents from chain_docs first, keeping fetched ones only when asked', async () => {
    const doc = manifest();
    const cache = {
      findDocument: jest.fn().mockResolvedValue(null),
      saveDocument: jest.fn().mockResolvedValue(undefined)
    };
    const gateway = {
      getDocument: jest.fn().mockResolvedValue(Buffer.from(doc.bytes))
    };
    const reportOnly = new StoredDocuments(cache, gateway, false);
    expect(await reportOnly.get(doc.contentCid, 8)).toEqual(doc.bytes);
    expect(cache.saveDocument).not.toHaveBeenCalled();

    const writing = new StoredDocuments(cache, gateway, true);
    await writing.get(doc.contentCid, 8);
    expect(cache.saveDocument).toHaveBeenCalledWith(
      doc.contentCid,
      8,
      doc.bytes
    );

    gateway.getDocument.mockClear();
    cache.findDocument.mockResolvedValue(doc.bytes);
    expect(await writing.get(doc.contentCid, 8)).toEqual(doc.bytes);
    expect(gateway.getDocument).not.toHaveBeenCalled();

    // A manifest over its class's size is not kept (its check refuses it).
    const large = canonicalDocBytes({ text: 'x'.repeat(MAX_MANIFEST_BYTES) });
    const largeCid = docCid(large);
    cache.findDocument.mockResolvedValueOnce(null);
    cache.saveDocument.mockClear();
    gateway.getDocument.mockResolvedValueOnce(Buffer.from(large));
    expect(await writing.get(largeCid, 8)).toEqual(large);
    expect(cache.saveDocument).not.toHaveBeenCalled();
    expect(
      checkEntryManifest(large, {
        entryId: E,
        decisionId: D,
        author: A,
        manifestHash: doc.manifestHash,
        contentCid: largeCid
      })
    ).toEqual({ ok: false, reason: 'manifest_too_large' });

    // Bytes that don't match the CID are not used, from either place.
    cache.findDocument.mockResolvedValue(new Uint8Array([1, 2, 3]));
    gateway.getDocument.mockResolvedValue(Buffer.from('other'));
    expect(await writing.get(doc.contentCid, 8)).toBeNull();
    gateway.getDocument.mockResolvedValue(null);
    expect(await writing.get(doc.contentCid, 8)).toBeNull();
  });
});

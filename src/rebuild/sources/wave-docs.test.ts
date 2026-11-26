import * as fs from 'node:fs';
import * as path from 'node:path';
import { keccakHex } from '@/rebuild/sources/drop-archives';
import {
  checkDocsIndex,
  docsRoot,
  WaveDocEntry
} from '@/rebuild/sources/wave-docs';

// Made-up documents and their index, written with the snapshot tool's own
// encoder (ce.py and waves_model.commitment; no real data): a wave and a
// decision document named by their CIDs, and a group commitment document.
const fixtures = path.join(__dirname, 'fixtures', 'wave-docs');
const indexBytes = fs.readFileSync(path.join(fixtures, 'index.json'));
const index = JSON.parse(indexBytes.toString('utf8')) as {
  docsRoot: string;
  docs: (WaveDocEntry & { file: string; nonce: string | null })[];
};
// The snapshot tool's roots for these documents and for none.
const ROOT = '9509ca9829eb8060aa2e9b418b6f6ad04ee3c1c6c67497c0238fb9adf5ca7139';
const EMPTY =
  '7746dca0b6e814bbb0a397285cfbad51c6aa3463cd8cab93d6b71741baf5051a';
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('docs root', () => {
  it("gives the snapshot tool's roots", () => {
    expect(index.docsRoot).toBe(ROOT);
    expect(docsRoot(index.docs)).toBe(ROOT);
    expect(docsRoot([])).toBe(EMPTY);
  });

  it("hashes each document's bytes into its entry", () => {
    for (const doc of index.docs) {
      expect(keccakHex(fs.readFileSync(path.join(fixtures, doc.file)))).toBe(
        doc.hash
      );
    }
  });

  it('refuses entries out of order, twice, or with a bad field', () => {
    const [a, b, c] = index.docs;
    expect(() => docsRoot([b, a, c])).toThrow(
      'document 2: documents must be strictly ascending by docClass, then ref'
    );
    expect(() => docsRoot([a, a])).toThrow('document 2');
    expect(() => docsRoot([{ ...a, docClass: 256 }])).toThrow(
      'document 1: docClass must be 0 to 255'
    );
    expect(() => docsRoot([{ ...a, hash: a.hash.toUpperCase() }])).toThrow(
      'document 1'
    );
  });
});

describe('a docs index against the docsRoot of the Waves v1 file the chain names', () => {
  it("attests its documents when its root is the chain's", () => {
    const checked = checkDocsIndex(indexBytes, [ROOT]);
    expect(checked).toMatchObject({ problems: [], waiting: null });
    expect(checked.docs.map((d) => [d.docClass, d.rawCid === d.cid])).toEqual([
      [3, true],
      [6, false],
      [10, true]
    ]);
  });

  it('waits, failing nothing, with no Waves v1 file the chain names', () => {
    expect(checkDocsIndex(indexBytes, [])).toEqual({
      docs: [],
      problems: [],
      waiting:
        "no Waves v1 file the chain names is served, so the docs index can't be checked against the chain"
    });
  });

  it('refuses a root that differs, and attests nothing', () => {
    const other = 'ab'.repeat(32);
    expect(checkDocsIndex(indexBytes, [other])).toEqual({
      docs: [],
      problems: [
        `the docs index's root ${ROOT} is not the docsRoot of the Waves v1 file the chain names`
      ],
      waiting: null
    });
    // A tampered entry moves the root, whatever the index says it is.
    const tampered = {
      docsRoot: ROOT,
      docs: index.docs.map((d, i) =>
        i === 1 ? { ...d, hash: 'cd'.repeat(32) } : d
      )
    };
    expect(checkDocsIndex(bytes(tampered), [ROOT]).problems).toEqual([
      `the docs index gives docsRoot ${ROOT}, but its documents' root is ${docsRoot(tampered.docs)}`
    ]);
  });

  it("refuses an entry without its rawCid, a CID document served under another name, and a ref not its CID's", () => {
    const [cidDoc, commitmentDoc] = index.docs;
    const one = (doc: unknown) =>
      checkDocsIndex(bytes({ docs: [doc] }), [ROOT]).problems;
    expect(one({ ...commitmentDoc, rawCid: undefined })).toEqual([
      "the docs index's document 1 gives no rawCid, the raw sha2-256 CIDv1 of its bytes in lowercase hex, the name it is served under"
    ]);
    expect(one({ ...commitmentDoc, rawCid: `0170${'0'.repeat(68)}` })).toEqual([
      "the docs index's document 1 gives no rawCid, the raw sha2-256 CIDv1 of its bytes in lowercase hex, the name it is served under"
    ]);
    expect(one({ ...cidDoc, rawCid: commitmentDoc.rawCid })).toEqual([
      `the docs index's document 1 gives cid ${cidDoc.cid}, but rawCid ${commitmentDoc.rawCid}: a CID document is served under its CID`
    ]);
    expect(one({ ...cidDoc, ref: 'ef'.repeat(32) })).toEqual([
      `the docs index's document 1 gives ref ${'ef'.repeat(32)}, which isn't its CID's Keccak-256`
    ]);
    expect(one({ ...cidDoc, docClass: '3' })).toEqual([
      "the docs index's document 1 lacks a docClass number, or a ref or hash string"
    ]);
  });

  it('refuses an index that is not JSON or has no docs list', () => {
    expect(checkDocsIndex(Buffer.from('{'), [ROOT]).problems).toEqual([
      'the docs index is not JSON'
    ]);
    expect(checkDocsIndex(bytes({ documents: [] }), [ROOT]).problems).toEqual([
      'the docs index has no docs list'
    ]);
  });
});

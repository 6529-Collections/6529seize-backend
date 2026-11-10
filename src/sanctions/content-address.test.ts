import {
  MAX_SINGLE_BLOCK_BYTES,
  rawBlockCid,
  sha256Hex
} from '@/sanctions/content-address';
import { readSanctionsVector } from '@/sanctions/sanctions-spec-files';

interface CidVectors {
  cases: Array<{
    description: string;
    utf8: string;
    sha256: string;
    cid: string;
  }>;
}

const vectors = readSanctionsVector<CidVectors>('cid.json');

describe('rawBlockCid', () => {
  it.each(vectors.cases)('matches the vector for $description', (vector) => {
    const bytes = Buffer.from(vector.utf8, 'utf8');
    expect(sha256Hex(bytes)).toBe(vector.sha256);
    expect(rawBlockCid(bytes)).toBe(vector.cid);
  });

  it('refuses files larger than one IPFS block', () => {
    expect(() => rawBlockCid(Buffer.alloc(MAX_SINGLE_BLOCK_BYTES + 1))).toThrow(
      /single raw IPFS block/
    );
  });

  it('accepts a file of exactly one block', () => {
    expect(rawBlockCid(Buffer.alloc(MAX_SINGLE_BLOCK_BYTES))).toMatch(
      /^bafkrei[a-z2-7]{52}$/
    );
  });
});

import { computeAllowlistMerkle } from '@/api/minting-claims/allowlist-merkle';
import {
  compactMerkleRoot,
  expandMerkleRoot,
  MintProofRow
} from './mint-log-merkle';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';

function stored(entries: Array<{ address: string; amount: number }>) {
  const { merkleRoot, proofsByAddress } = computeAllowlistMerkle(entries);
  const row = {
    id: 7,
    card_id: 100,
    contract: '0x0000000000000000000000000000000000000abc',
    phase: 'Phase 1',
    merkle_root: merkleRoot,
    created_at: '2026-11-20 10:00:00.000000'
  };
  // MySQL hands JSON back normalized, with spaces and its own key order.
  const proofs: MintProofRow[] = Object.entries(proofsByAddress).map(
    ([address, items]) => ({
      merkle_root: merkleRoot,
      address,
      proofs: JSON.stringify(
        items.map((item) => ({
          value: item.value,
          merkleProof: item.merkleProof
        })),
        null,
        1
      )
    })
  );
  return { row, proofs };
}

describe('mint log merkle form', () => {
  it('keeps only the allowlist when the recompute gives the stored proofs', () => {
    const { row, proofs } = stored([
      { address: B, amount: 2 },
      { address: A, amount: 1 },
      { address: C, amount: 3 }
    ]);
    const root = compactMerkleRoot(row, proofs);
    expect(root.raw_proofs).toBeNull();
    expect(root.allowlist).toEqual([
      [A, 1],
      [B, 2],
      [C, 3]
    ]);
    const expanded = expandMerkleRoot(root);
    expect(expanded.map((proof) => proof.address)).toEqual([A, B, C]);
    for (const proof of expanded) {
      const original = proofs.find((p) => p.address === proof.address)!;
      expect(JSON.parse(proof.proofs)).toEqual(
        JSON.parse(original.proofs).map((item: any) => ({
          merkleProof: item.merkleProof,
          value: item.value
        }))
      );
    }
  });

  it('keeps the stored proofs when they differ from the recompute', () => {
    const { row, proofs } = stored([
      { address: A, amount: 1 },
      { address: B, amount: 1 }
    ]);
    const tampered = proofs.map((proof, i) =>
      i === 0 ? { ...proof, proofs: '[{"merkleProof":[],"value":9}]' } : proof
    );
    const root = compactMerkleRoot(row, tampered);
    expect(root.raw_proofs).toEqual(
      tampered.map((proof) => [proof.address, proof.proofs])
    );
    expect(expandMerkleRoot(root).map((proof) => proof.proofs)).toEqual(
      tampered.map((proof) => proof.proofs)
    );
  });

  it('keeps the stored proofs when the root is not the recomputed one', () => {
    const { row, proofs } = stored([{ address: A, amount: 2 }]);
    const root = compactMerkleRoot(
      { ...row, merkle_root: '0x' + '1'.repeat(64) },
      proofs
    );
    expect(root.raw_proofs).not.toBeNull();
  });

  it('refuses to expand an allowlist that does not give the logged root', () => {
    const { row, proofs } = stored([{ address: A, amount: 2 }]);
    const root = compactMerkleRoot(row, proofs);
    expect(() => expandMerkleRoot({ ...root, allowlist: [[A, 3]] })).toThrow(
      /gives root/
    );
  });
});

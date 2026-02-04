import { getBytes, keccak256 } from 'ethers';
import { MerkleTree } from 'merkletreejs';

export interface AllowlistMerkleEntry {
  address: string;
  amount: number;
}

export interface AllowlistMerkleProofItem {
  merkleProof: string[];
  value: number;
}

export interface AllowlistMerkleResult {
  merkleRoot: string;
  proofsByAddress: Record<string, AllowlistMerkleProofItem[]>;
}

function toHexIndex(index: number): string {
  return index.toString(16).padStart(8, '0');
}

function hashToBuffer(data: Buffer): Buffer {
  const hex = keccak256(new Uint8Array(data));
  return Buffer.from(hex.slice(2), 'hex');
}

export function computeAllowlistMerkle(
  entries: AllowlistMerkleEntry[]
): AllowlistMerkleResult {
  const expanded: { address: string; index: number }[] = [];
  let globalIndex = 0;
  for (const entry of entries) {
    const address = entry.address.toLowerCase().replace(/^0x/, '');
    for (let i = 0; i < entry.amount; i++) {
      expanded.push({ address, index: globalIndex });
      globalIndex++;
    }
  }
  if (expanded.length === 0) {
    return { merkleRoot: '', proofsByAddress: {} };
  }
  const leaves = expanded.map((entry) => {
    const hexIndex = toHexIndex(entry.index);
    const concatenatedData = entry.address + hexIndex;
    const bufferData = Buffer.from(getBytes('0x' + concatenatedData));
    return hashToBuffer(bufferData);
  });
  const merkleTree = new MerkleTree(leaves, hashToBuffer, {
    sortPairs: true
  });
  const merkleRoot = merkleTree.getHexRoot();
  const proofsByAddress: Record<string, AllowlistMerkleProofItem[]> = {};
  expanded.forEach((entry, idx) => {
    const address = '0x' + entry.address;
    const proof = merkleTree.getHexProof(leaves[idx] as Buffer);
    if (!proofsByAddress[address]) {
      proofsByAddress[address] = [];
    }
    proofsByAddress[address].push({
      merkleProof: proof,
      value: entry.index
    });
  });
  return { merkleRoot, proofsByAddress };
}

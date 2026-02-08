import { keccak256 } from 'ethers';
import { MerkleTree } from 'merkletreejs';

function hashToBuffer(data: Buffer): Buffer {
  const hex = keccak256(new Uint8Array(data));
  return Buffer.from(hex.slice(2), 'hex');
}

export function getProof(merkle_tree: string, keccak: string): string[] {
  const parsedMerkleTree = JSON.parse(merkle_tree);
  const leaves = parsedMerkleTree.leaves.map((leaf: { data: number[] }) =>
    Buffer.from(leaf.data)
  );
  const merkleTree = new MerkleTree(leaves, hashToBuffer, { sortPairs: true });
  const leafBuffer = Buffer.from(keccak.replace(/^0x/, ''), 'hex');
  const proof = merkleTree.getProof(leafBuffer);
  return proof.map((p: { data: Buffer }) => '0x' + p.data.toString('hex'));
}

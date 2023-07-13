const { MerkleTree } = require('merkletreejs');
const { keccak256 } = require('@ethersproject/keccak256');

export const getProof = (merkle_tree: string, keccak: string) => {
  const parsedMerkleTree = JSON.parse(JSON.parse(merkle_tree));
  const leaves = parsedMerkleTree.leaves.map((leaf: any) =>
    Buffer.from(leaf.data)
  );
  const merkleTree = new MerkleTree(leaves, keccak256, {
    sortPairs: true
  });
  const proof = merkleTree.getProof(keccak, 'hex');
  const parsedProof = proof.map((p: any) => '0x' + p.data.toString('hex'));
  return parsedProof;
};

import crypto from 'crypto';
import { ConsolidatedTDH } from '../entities/ITDH';

export function computeMerkleRoot(data: ConsolidatedTDH[]) {
  const filteredData = data
    .filter((item) => item.boosted_tdh > 0)
    .sort((a, b) => {
      if (a.boosted_tdh > b.boosted_tdh) return -1;
      else if (a.boosted_tdh < b.boosted_tdh) return 1;
      else if (a.consolidation_key < b.consolidation_key) return -1;
      else return 1;
    });

  const merkleRoot = getMerkleRoot(
    filteredData.map((item) => ({
      key: item.consolidation_key,
      value: item.boosted_tdh
    }))
  );

  return merkleRoot;
}

function hashPair(a: string, b: string): string {
  return crypto
    .createHash('sha256')
    .update(a + b)
    .digest('hex');
}

function getMerkleRoot(data: { key: string; value: number }[]): string {
  // Step 1: Generate leaf nodes by hashing each address-value pair
  let leaves = data.map(({ key, value }) =>
    crypto.createHash('sha256').update(`${key}:${value}`).digest('hex')
  );

  // Step 2: Build the Merkle Tree by hashing pairs until we reach the root
  while (leaves.length > 1) {
    const tempLeaves: string[] = [];

    // Pair up leaves, hash them, and push to the next level
    for (let i = 0; i < leaves.length; i += 2) {
      if (i + 1 < leaves.length) {
        // Hash pairs of leaves
        tempLeaves.push(hashPair(leaves[i], leaves[i + 1]));
      } else {
        // If odd number, duplicate the last leaf
        tempLeaves.push(leaves[i]);
      }
    }
    leaves = tempLeaves;
  }

  // The last remaining element is the Merkle root
  return `0x${leaves[0]}`;
}

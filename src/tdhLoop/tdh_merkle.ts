import crypto from 'crypto';
import { MoreThan } from 'typeorm';
import { ConsolidatedTDH } from '../entities/ITDH';
import { getDataSource } from '../db';

export async function computeMerkleRoot() {
  type PartialConsolidatedTDH = Pick<
    ConsolidatedTDH,
    'consolidation_key' | 'boosted_tdh'
  >;
  const data = (await getDataSource()
    .getRepository(ConsolidatedTDH)
    .find({
      select: ['consolidation_key', 'boosted_tdh'],
      where: { boosted_tdh: MoreThan(0) },
      order: {
        boosted_tdh: 'DESC',
        consolidation_key: 'ASC'
      }
    })) as PartialConsolidatedTDH[];

  const merkleRoot = getMerkleRoot(
    data.map((item) => ({
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

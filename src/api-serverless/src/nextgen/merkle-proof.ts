import { Logger } from '@/logging';
import { keccak256 } from 'ethers';
import { MerkleTree } from 'merkletreejs';

const logger = Logger.get('nextgen.merkle-proof');

function hashToBuffer(data: Buffer): Buffer {
  const hex = keccak256(new Uint8Array(data));
  return Buffer.from(hex.slice(2), 'hex');
}

function parseAndValidateMerkleTree(merkle_tree: string): Buffer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(merkle_tree);
  } catch (err) {
    logger.warn('Invalid merkle_tree: parse failed', {
      inputLength: merkle_tree?.length,
      err
    });
    throw new Error(`Invalid merkle_tree: JSON parse failed`);
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { leaves?: unknown }).leaves)
  ) {
    logger.warn('Invalid merkle_tree: missing or invalid leaves array', {
      inputLength: merkle_tree?.length
    });
    throw new Error('Invalid merkle_tree: expected object with leaves array');
  }
  const leaves = (parsed as { leaves: { data?: number[] }[] }).leaves;
  const buffers: Buffer[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const data = leaf?.data;
    if (data == null || !Array.isArray(data)) {
      throw new Error(
        `Invalid merkle_tree: leaf at index ${i} has no valid data`
      );
    }
    try {
      buffers.push(Buffer.from(data));
    } catch (err) {
      logger.warn('Invalid merkle_tree: leaf data to Buffer failed', {
        index: i,
        err
      });
      throw new Error(
        `Invalid merkle_tree: leaf at index ${i} could not be converted to Buffer`
      );
    }
  }
  return buffers;
}

export function getProof(merkle_tree: string, keccak: string): string[] {
  const leaves = parseAndValidateMerkleTree(merkle_tree);
  const merkleTree = new MerkleTree(leaves, hashToBuffer, { sortPairs: true });
  const normalizedKeccak = keccak.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalizedKeccak)) {
    throw new Error(`Invalid keccak: expected 32-byte hex string`);
  }
  const leafBuffer = Buffer.from(normalizedKeccak, 'hex');
  const proof = merkleTree.getProof(leafBuffer);
  return proof.map((p: { data: Buffer }) => '0x' + p.data.toString('hex'));
}

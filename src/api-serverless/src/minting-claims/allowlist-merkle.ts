import { isAddress, keccak256, solidityPackedKeccak256 } from 'ethers';
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

const MAX_LEAVES = 250_000;
const MAX_UINT32 = 0xffffffff;

function hashToBuffer(data: Buffer): Buffer {
  const hex = keccak256(new Uint8Array(data));
  return Buffer.from(hex.slice(2), 'hex');
}

function validateAllowlistEntry(entry: AllowlistMerkleEntry): {
  address: string;
  amount: number;
} {
  const rawAddress = entry?.address?.trim();
  if (!rawAddress || !isAddress(rawAddress)) {
    throw new Error(`Invalid allowlist address: ${String(entry?.address)}`);
  }
  const amount = Number(entry?.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `Invalid allowlist amount for ${rawAddress}: ${String(entry?.amount)}`
    );
  }
  return { address: rawAddress.toLowerCase(), amount };
}

function buildAddressAmounts(
  entries: AllowlistMerkleEntry[]
): Array<[string, number]> {
  const byAddress = new Map<string, number>();
  for (const entry of entries) {
    const normalized = validateAllowlistEntry(entry);
    byAddress.set(
      normalized.address,
      (byAddress.get(normalized.address) ?? 0) + normalized.amount
    );
  }
  return Array.from(byAddress.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
}

function appendLeaf(
  address: string,
  globalIndex: number,
  leaves: Buffer[],
  leafOwners: string[],
  leafValues: number[]
): void {
  if (globalIndex > MAX_UINT32) {
    throw new Error(
      `Allowlist index exceeded uint32 max: ${globalIndex} > ${MAX_UINT32}`
    );
  }
  if (leaves.length >= MAX_LEAVES) {
    throw new Error(
      `Allowlist too large: ${leaves.length + 1} leaves exceeds max ${MAX_LEAVES}`
    );
  }
  const leafHex = solidityPackedKeccak256(
    ['address', 'uint32'],
    [address, globalIndex]
  );
  leaves.push(Buffer.from(leafHex.slice(2), 'hex'));
  leafOwners.push(address);
  leafValues.push(globalIndex);
}

export function computeAllowlistMerkle(
  entries: AllowlistMerkleEntry[]
): AllowlistMerkleResult {
  const sortedEntries = buildAddressAmounts(entries);
  if (sortedEntries.length === 0) {
    return { merkleRoot: '', proofsByAddress: {} };
  }

  const leaves: Buffer[] = [];
  const leafOwners: string[] = [];
  const leafValues: number[] = [];

  let globalIndex = 0;
  for (const [address, amount] of sortedEntries) {
    for (let i = 0; i < amount; i++) {
      appendLeaf(address, globalIndex, leaves, leafOwners, leafValues);
      globalIndex++;
    }
  }

  const merkleTree = new MerkleTree(leaves, hashToBuffer, {
    sortPairs: true
  });
  const merkleRoot = merkleTree.getHexRoot();
  const proofsByAddress: Record<string, AllowlistMerkleProofItem[]> = {};
  for (let idx = 0; idx < leaves.length; idx++) {
    const address = leafOwners[idx];
    const proof = merkleTree.getHexProof(leaves[idx]);
    if (!proofsByAddress[address]) proofsByAddress[address] = [];
    proofsByAddress[address].push({
      merkleProof: proof,
      value: leafValues[idx]
    });
  }
  return { merkleRoot, proofsByAddress };
}

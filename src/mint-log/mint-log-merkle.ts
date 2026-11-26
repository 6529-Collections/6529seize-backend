import { computeAllowlistMerkle } from '@/api/minting-claims/allowlist-merkle';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { compareText } from './mint-log-parts';
import type { MintMerkleRoot, MintRow } from './mint-log.types';

/** A proofs row as captured: the address and its proofs JSON as text. */
export interface MintProofRow {
  readonly merkle_root: string;
  readonly address: string;
  readonly proofs: string;
}

function sameJson(storedText: string, value: unknown): boolean {
  try {
    return canonicalizeJson(JSON.parse(storedText)) === canonicalizeJson(value);
  } catch {
    return false;
  }
}

/**
 * Turns a root row and its stored proofs into the logged form. Each address
 * has one leaf per allowlist spot, so the leaf count per address rebuilds the
 * same tree. The compact form is used only when the recompute gives the same
 * root and, address by address, the same proofs; otherwise the proofs are
 * kept as stored.
 */
export function compactMerkleRoot(
  row: MintRow,
  proofs: readonly MintProofRow[]
): MintMerkleRoot {
  const sorted = [...proofs].sort((a, b) => compareText(a.address, b.address));
  const allowlist: Array<[string, number]> = [];
  let parseable = true;
  for (const proof of sorted) {
    try {
      const items: unknown = JSON.parse(proof.proofs);
      allowlist.push([proof.address, Array.isArray(items) ? items.length : 0]);
      if (!Array.isArray(items) || items.length === 0) parseable = false;
    } catch {
      parseable = false;
    }
  }
  if (parseable && recomputeMatches(row, sorted, allowlist)) {
    return { row, allowlist, raw_proofs: null };
  }
  return {
    row,
    allowlist,
    raw_proofs: sorted.map((proof) => [proof.address, proof.proofs])
  };
}

function recomputeMatches(
  row: MintRow,
  proofs: readonly MintProofRow[],
  allowlist: ReadonlyArray<[string, number]>
): boolean {
  if (!allowlist.length) return false;
  let computed: ReturnType<typeof computeAllowlistMerkle>;
  try {
    computed = computeAllowlistMerkle(
      allowlist.map(([address, amount]) => ({ address, amount }))
    );
  } catch {
    return false;
  }
  if (computed.merkleRoot !== row.merkle_root) return false;
  if (Object.keys(computed.proofsByAddress).length !== proofs.length) {
    return false;
  }
  return proofs.every((proof) =>
    sameJson(proof.proofs, computed.proofsByAddress[proof.address])
  );
}

/** The proofs rows a logged root stands for, in the form the writer stores. */
export function expandMerkleRoot(root: MintMerkleRoot): MintProofRow[] {
  const merkleRoot = String(root.row.merkle_root);
  if (root.raw_proofs) {
    return root.raw_proofs.map(([address, proofs]) => ({
      merkle_root: merkleRoot,
      address,
      proofs
    }));
  }
  const computed = computeAllowlistMerkle(
    root.allowlist.map(([address, amount]) => ({ address, amount }))
  );
  if (computed.merkleRoot !== merkleRoot) {
    throw new Error(
      `Logged allowlist for phase ${String(root.row.phase)} gives root ${computed.merkleRoot}, not ${merkleRoot}`
    );
  }
  return Object.entries(computed.proofsByAddress)
    .sort(([a], [b]) => compareText(a, b))
    .map(([address, items]) => ({
      merkle_root: merkleRoot,
      address,
      proofs: JSON.stringify(items)
    }));
}

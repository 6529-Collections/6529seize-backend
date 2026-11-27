import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import {
  compareText,
  keyOnly,
  MINT_ROW_PART_SPECS,
  MintRowPartSpec,
  rowKey,
  sortRows
} from './mint-log-parts';
import {
  MINT_ROW_PARTS,
  MintCardEffects,
  MintCardState,
  MintMerkleDiff,
  MintMerkleRoot,
  MintPart,
  MintRow,
  MintRowDiff,
  MintRowPart
} from './mint-log.types';

export function emptyCardState(): MintCardState {
  return {
    distribution: [],
    normalized: [],
    photos: [],
    claim: [],
    claim_actions: [],
    card_mapping: [],
    subscription_phases: [],
    subscription_phases_identity: [],
    nextgen_allowlists: [],
    nextgen_allowlist_rows: [],
    nextgen_allowlist_burn_rows: [],
    nextgen_burn_collection: [],
    rememes: [],
    collaboration: [],
    collaboration_invitations: [],
    rememe_uploads: [],
    royalties_uploads: [],
    merkle: []
  };
}

function same(a: unknown, b: unknown): boolean {
  return canonicalizeJson(a) === canonicalizeJson(b);
}

function isDefaultSubscriptionPhase(row: MintRow): boolean {
  return (
    row.phase === null &&
    (row.phase_subscriptions === null || row.phase_subscriptions === -1) &&
    (row.phase_position === null || row.phase_position === -1)
  );
}

function diffRows(
  spec: MintRowPartSpec,
  before: readonly MintRow[],
  after: readonly MintRow[]
): MintRowDiff | null {
  const beforeByKey = new Map(before.map((row) => [rowKey(spec, row), row]));
  const afterByKey = new Map(after.map((row) => [rowKey(spec, row), row]));
  const upsert: MintRow[] = [];
  const deleted: MintRow[] = [];
  for (const [key, row] of Array.from(afterByKey.entries())) {
    const previous = beforeByKey.get(key);
    if (previous && same(previous, row)) continue;
    // The subscriptions module creates and deletes these rows; the log only
    // follows the phase columns the allowlist writer sets.
    if (
      spec.mode === 'update-only' &&
      !previous &&
      isDefaultSubscriptionPhase(row)
    ) {
      continue;
    }
    upsert.push(row);
  }
  if (spec.mode === 'upsert') {
    for (const [key, row] of Array.from(beforeByKey.entries())) {
      if (!afterByKey.has(key)) deleted.push(keyOnly(spec, row));
    }
  }
  if (!upsert.length && !deleted.length) return null;
  return {
    upsert: sortRows(spec, upsert),
    delete: sortRows(spec, deleted)
  };
}

function phaseOf(root: MintMerkleRoot): string {
  return String(root.row.phase);
}

function diffMerkle(
  before: readonly MintMerkleRoot[],
  after: readonly MintMerkleRoot[]
): MintMerkleDiff | null {
  const beforeByPhase = new Map(before.map((root) => [phaseOf(root), root]));
  const afterPhases = new Set(after.map(phaseOf));
  const upsert = after.filter((root) => {
    const previous = beforeByPhase.get(phaseOf(root));
    return !previous || !same(previous, root);
  });
  const deleted = before
    .map(phaseOf)
    .filter((phase) => !afterPhases.has(phase))
    .sort(compareText);
  if (!upsert.length && !deleted.length) return null;
  return { upsert, delete: deleted };
}

/**
 * A part's rows in a state. A state written before the part existed (a
 * genesis file from an earlier version) lacks it: it was not captured, which
 * is what an empty part means.
 */
function partRows(state: MintCardState, part: MintRowPart): MintRow[] {
  return state[part] ?? [];
}

/** The row changes that turn `before` into `after`, part by part. */
export function diffCardState(
  before: MintCardState,
  after: MintCardState
): MintCardEffects {
  const effects: Record<string, MintRowDiff | MintMerkleDiff> = {};
  for (const part of MINT_ROW_PARTS) {
    const diff = diffRows(
      MINT_ROW_PART_SPECS[part],
      partRows(before, part),
      partRows(after, part)
    );
    if (diff) effects[part] = diff;
  }
  const merkle = diffMerkle(before.merkle, after.merkle);
  if (merkle) effects.merkle = merkle;
  return effects as MintCardEffects;
}

export function changedParts(effects: MintCardEffects): MintPart[] {
  return (Object.keys(effects) as MintPart[]).filter(
    (part) => effects[part] !== undefined
  );
}

function applyRowDiff(
  spec: MintRowPartSpec,
  rows: readonly MintRow[],
  diff: MintRowDiff | undefined
): MintRow[] {
  if (!diff) return [...rows];
  const byKey = new Map(rows.map((row) => [rowKey(spec, row), row]));
  for (const key of diff.delete) byKey.delete(rowKey(spec, key));
  for (const row of diff.upsert) {
    const previous = byKey.get(rowKey(spec, row));
    byKey.set(rowKey(spec, row), previous ? { ...previous, ...row } : row);
  }
  return sortRows(spec, Array.from(byKey.values()));
}

/** Applies effects to a captured state in memory (what the SQL reducer does). */
export function applyEffectsToState(
  state: MintCardState,
  effects: MintCardEffects
): MintCardState {
  const rows = {} as Record<MintRowPart, MintRow[]>;
  for (const part of MINT_ROW_PARTS) {
    rows[part] = applyRowDiff(
      MINT_ROW_PART_SPECS[part],
      partRows(state, part),
      effects[part]
    );
  }
  let merkle = [...state.merkle];
  if (effects.merkle) {
    const removed = new Set([
      ...effects.merkle.delete,
      ...effects.merkle.upsert.map(phaseOf)
    ]);
    merkle = [
      ...merkle.filter((root) => !removed.has(phaseOf(root))),
      ...effects.merkle.upsert
    ].sort((a, b) => compareText(phaseOf(a), phaseOf(b)));
  }
  return { ...rows, merkle };
}

/** Part names whose content differs between two states, for reports. */
export function differingParts(a: MintCardState, b: MintCardState): MintPart[] {
  const parts: MintPart[] = [];
  for (const part of MINT_ROW_PARTS) {
    if (!same(partRows(a, part), partRows(b, part))) parts.push(part);
  }
  if (!same(a.merkle, b.merkle)) parts.push('merkle');
  return parts;
}

/** Operator-only diagnostics; never used for public API responses. */
export class KeysAndGatesSourceDropsMissingError extends Error {
  readonly code = 'KEYS_AND_GATES_SOURCE_DROPS_MISSING';
  readonly mode: 'dry_run' | 'apply';

  constructor(
    readonly missingDropIds: readonly string[],
    apply: boolean,
    readonly correlationId?: string
  ) {
    super(
      `Keys and Gates import aborted: ${missingDropIds.length} required source ${missingDropIds.length === 1 ? 'drop was' : 'drops were'} not found. No import changes were made.`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'KeysAndGatesSourceDropsMissingError';
    this.mode = apply ? 'apply' : 'dry_run';
  }
}

export type ParityRun = 'run1' | 'run2';

/**
 * Where the engine's inputs come from.
 *
 * - `gate`: only what was read before the build (the snapshot), the users'
 *   own log lines dated before the build, and top-ups dated before it. No
 *   value from the legacy build's lines or list is used as an input. This is
 *   the mode a switch decision rests on.
 * - `pinned`: a diagnostic. Balances and run 1's airdrop addresses are copied
 *   from the legacy build's own lines, so those fields are not checked.
 */
export type InputMode = 'gate' | 'pinned';

export type DiffCause =
  | 'duplicate-identity'
  | 'key-not-collected'
  | 'balance-input'
  | 'topup-timing'
  | 'eligibility-input'
  | 'card-input'
  | 'row-flag'
  | 'airdrop-input'
  | 'tdh-tie'
  | 'delegation-tie'
  | 'chain-source'
  | 'no-wallets'
  | 'distribution-input'
  | 'read-after-build'
  | 'key-map'
  | 'unknown';

export interface ParityDiff {
  readonly key: string | null;
  readonly wallet?: string;
  readonly transaction?: string;
  readonly field: string;
  readonly old: unknown;
  readonly new: unknown;
  readonly cause: DiffCause;
}

export interface ParitySide {
  /** Every row, duplicates included. */
  readonly rows: number;
  /** Cards on the rows, where the gate has a card count. */
  readonly cards?: number;
  readonly inputs: Record<string, unknown>;
}

export interface ParityReport {
  readonly id: string;
  readonly gate: 'LIST' | 'PHASE' | 'REDEMPTIONS';
  readonly run: ParityRun;
  readonly mode: InputMode;
  readonly card: number;
  readonly phase: string | null;
  readonly old: ParitySide;
  readonly new: ParitySide;
  /** Fields the verdict covers. */
  readonly checked: string[];
  /**
   * Fields copied from the legacy side, or not observable from public data.
   * They never count toward MATCH.
   */
  readonly notChecked: string[];
  /** MATCH means no difference in any checked field. */
  readonly verdict: 'MATCH' | 'DIFF';
  readonly positionsDiffer: number;
  readonly diffs: ParityDiff[];
  readonly notes: string[];
}

export function verdictOf(diffs: readonly ParityDiff[]): 'MATCH' | 'DIFF' {
  return diffs.length === 0 ? 'MATCH' : 'DIFF';
}

function side(s: ParitySide): string {
  return s.cards === undefined
    ? `${s.rows} rows`
    : `${s.rows} rows/${s.cards} cards`;
}

export function summaryLine(report: ParityReport): string {
  const scope = report.phase
    ? `card ${report.card} ${report.phase}`
    : `card ${report.card}`;
  const notChecked = report.notChecked.length
    ? report.notChecked.join(', ')
    : 'none';
  return (
    `${report.gate} ${scope} ${report.run} [${report.mode}]: ${report.verdict} ` +
    `on ${report.checked.join(', ')} (old ${side(report.old)}, new ${side(report.new)}, ` +
    `${report.diffs.length} diffs); not checked: ${notChecked}`
  );
}

/** Rows grouped by key, keeping every row. */
export function groupRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

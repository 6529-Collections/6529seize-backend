import { SUBSCRIPTIONS_ID_REPORTS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { compareText } from '../engine/text-order';
import { IdentityWriteMode } from '../identity/identity-switch';

const logger = Logger.get('SUBSCRIPTIONS_IDENTITY_REPORTS');

export type ReportKind = 'LIST' | 'PHASE' | 'REDEMPTIONS' | 'RECORD';

export interface RowDiff {
  readonly key: string;
  readonly legacy: string | null;
  readonly identity: string | null;
}

export interface ComparisonReport {
  readonly kind: ReportKind;
  readonly mode: IdentityWriteMode;
  readonly contract: string | null;
  readonly tokenId: number | null;
  readonly verdict: 'MATCH' | 'DIFF' | 'FAILED';
  readonly legacyRows: number;
  readonly identityRows: number;
  readonly diffs: RowDiff[];
  /** Rows only one side could have (for example a key the legacy tables can't hold). */
  readonly notes: string[];
  /**
   * How many differences and notes have no known structural cause. A list
   * report counts out the identities whose difference the notes explain (a
   * key spanning identities, a second legacy row of one identity, a row the
   * key-width guard holds back). Unset: every difference counts.
   */
  readonly unexplained?: number;
}

/**
 * Compares two sides keyed the same way: each side maps a key (an
 * identity, or an identity and a transaction) to the text of what it holds.
 */
export function compareKeyed(
  legacy: ReadonlyMap<string, string>,
  identity: ReadonlyMap<string, string>
): RowDiff[] {
  const keys = Array.from(
    new Set([...Array.from(legacy.keys()), ...Array.from(identity.keys())])
  ).sort(compareText);
  return keys
    .filter((key) => legacy.get(key) !== identity.get(key))
    .map((key) => ({
      key,
      legacy: legacy.get(key) ?? null,
      identity: identity.get(key) ?? null
    }));
}

/**
 * Saves a FAILED report for a shadow comparison that could not be made,
 * so the go-live gate sees the gap, never an absence. The error goes in
 * the notes.
 */
export async function saveFailedReport(
  kind: ComparisonReport['kind'],
  card: { readonly contract: string; readonly tokenId: number },
  error: unknown
): Promise<void> {
  await saveReport({
    kind,
    mode: 'SHADOW',
    contract: card.contract,
    tokenId: card.tokenId,
    verdict: 'FAILED',
    legacyRows: 0,
    identityRows: 0,
    diffs: [],
    notes: [`failed: ${error instanceof Error ? error.message : String(error)}`]
  });
}

/** Stores a comparison and logs its one-line summary. */
export async function saveReport(report: ComparisonReport): Promise<void> {
  const summary = `[${report.kind} ${report.verdict}] [${report.mode}] card ${report.tokenId ?? '-'}: ${report.identityRows} identity rows, ${report.legacyRows} legacy rows, ${report.diffs.length} differences`;
  if (
    report.mode === 'TRUTH' &&
    report.verdict !== 'MATCH' &&
    (report.unexplained === undefined || report.unexplained > 0)
  ) {
    // After the switch the legacy dual write is the only independent check
    // of the truth: a difference without a known cause is someone's money
    // or list, so alert.
    logger.errorWithCode('SUBSCRIPTIONS_TRUTH_COMPARISON_DIFF', summary);
  } else {
    logger.info(summary);
  }
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_ID_REPORTS_TABLE}
      (kind, mode, contract, token_id, verdict, report, created_at)
      VALUES (:kind, :mode, :contract, :tokenId, :verdict, :report, :createdAt)`,
    {
      kind: report.kind,
      mode: report.mode,
      contract: report.contract,
      tokenId: report.tokenId,
      verdict: report.verdict,
      report: JSON.stringify(report),
      createdAt: Date.now()
    }
  );
}

/**
 * Whether the shadow comparisons back a switch: an exact match of who gets
 * what on a real mint. For the last minted card it requires a MATCH list
 * from its last build, at least one phase comparison and at least one
 * redemption comparison, all MATCH, and no shadow DIFF of any kind since
 * that card's first list comparison. `checked` says what was looked at.
 */
export async function shadowReportsMatch(mintedCard: number): Promise<{
  readonly ok: boolean;
  readonly checked: string[];
  readonly problems: string[];
}> {
  const reports = await sqlExecutor.execute<{
    id: number;
    kind: string;
    verdict: string;
    token_id: number | null;
  }>(
    `SELECT id, kind, verdict, token_id FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE}
      WHERE mode = 'SHADOW' ORDER BY id ASC`
  );
  const ofCard = (kind: ReportKind) =>
    reports.filter((r) => r.kind === kind && Number(r.token_id) === mintedCard);
  const lists = ofCard('LIST');
  const phases = ofCard('PHASE');
  const redemptions = ofCard('REDEMPTIONS');
  const checked = [
    `card ${mintedCard}: ${lists.length} list, ${phases.length} phase and ${redemptions.length} redemption comparisons`
  ];
  const problems: string[] = [];
  if (lists.length === 0) {
    problems.push(`no list comparison for card ${mintedCard}`);
  } else if (lists[lists.length - 1].verdict !== 'MATCH') {
    problems.push(`card ${mintedCard}'s last list comparison is a DIFF`);
  }
  if (phases.length === 0) {
    problems.push(`no phase comparison for card ${mintedCard}`);
  }
  if (redemptions.length === 0) {
    problems.push(`no redemption comparison for card ${mintedCard}`);
  }
  const since = lists[0]?.id ?? 0;
  const diffs = reports.filter((r) => r.id >= since && r.verdict !== 'MATCH');
  checked.push(
    `${reports.filter((r) => r.id >= since).length} shadow comparisons since card ${mintedCard}'s first list`
  );
  for (const diff of diffs) {
    problems.push(
      `${diff.kind} comparison ${diff.id} (card ${diff.token_id ?? '-'}) is a DIFF`
    );
  }
  return { ok: problems.length === 0, checked, problems };
}

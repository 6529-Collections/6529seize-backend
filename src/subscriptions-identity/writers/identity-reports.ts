import { SUBSCRIPTIONS_ID_REPORTS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { compareText } from '../engine/text-order';
import { IdentityWriteMode } from '../identity/identity-switch';

const logger = Logger.get('SUBSCRIPTIONS_IDENTITY_REPORTS');

export type ReportKind = 'LIST' | 'PHASE' | 'REDEMPTIONS';

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
  readonly verdict: 'MATCH' | 'DIFF';
  readonly legacyRows: number;
  readonly identityRows: number;
  readonly diffs: RowDiff[];
  /** Rows only one side could have (for example a key the legacy tables can't hold). */
  readonly notes: string[];
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

/** Stores a comparison and logs its one-line summary. */
export async function saveReport(report: ComparisonReport): Promise<void> {
  logger.info(
    `[${report.kind} ${report.verdict}] [${report.mode}] card ${report.tokenId ?? '-'}: ${report.identityRows} identity rows, ${report.legacyRows} legacy rows, ${report.diffs.length} differences`
  );
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

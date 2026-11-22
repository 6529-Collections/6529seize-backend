import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import { IdentityDirectory } from '../identity/identity-directory';
import { cutOpeningFiles } from './opening-build';
import { canonicalJson } from './opening-file';
import { OPENING_STATE_ID } from '../identity/identity-switch';
import { ParsedOpening } from './opening-load';

const AS_TEXT = (column: string) =>
  `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;
const flag = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

/** The sections the identity tables hold, in the files' row shapes. */
export interface IdentitySections {
  readonly keys: unknown[];
  readonly balances: unknown[];
  readonly modes: unknown[];
  readonly choices: unknown[];
  readonly topUps: unknown[];
  readonly finalRows: unknown[];
  readonly uploads: unknown[];
  readonly redeemed: unknown[];
  readonly logs: unknown[];
}

/** Reads the identity tables back into the files' row shapes. */
export async function dumpIdentityTables(
  options?: DbQueryOptions
): Promise<IdentitySections> {
  const q = <T>(sql: string) => sqlExecutor.execute<T>(sql, undefined, options);
  return {
    keys: (
      await q<{
        consolidation_key: string;
        identity_key: string;
        identities: string | string[];
      }>(
        `SELECT consolidation_key, identity_key, identities FROM ${SUBSCRIPTIONS_ID_KEY_MAP_TABLE}`
      )
    ).map((r) => ({
      consolidationKey: r.consolidation_key,
      identityKey: r.identity_key,
      identities:
        typeof r.identities === 'string'
          ? JSON.parse(r.identities)
          : r.identities
    })),
    balances: (
      await q<any>(
        `SELECT identity_key, balance, ${AS_TEXT('created_at')} AS created_at,
                ${AS_TEXT('updated_at')} AS updated_at FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}`
      )
    ).map((r) => ({
      identityKey: r.identity_key,
      balance: Number(r.balance),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    modes: (
      await q<any>(
        `SELECT identity_key, automatic, subscribe_all_editions,
                ${AS_TEXT('created_at')} AS created_at, ${AS_TEXT('updated_at')} AS updated_at
           FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}`
      )
    ).map((r) => ({
      identityKey: r.identity_key,
      automatic: flag(r.automatic),
      subscribeAllEditions: flag(r.subscribe_all_editions),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    choices: (
      await q<any>(
        `SELECT identity_key, contract, token_id, subscribed, subscribed_count,
                automatic_subscription, ${AS_TEXT('created_at')} AS created_at,
                ${AS_TEXT('updated_at')} AS updated_at FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE}`
      )
    ).map((r) => ({
      identityKey: r.identity_key,
      contract: r.contract,
      tokenId: Number(r.token_id),
      subscribed: flag(r.subscribed),
      subscribedCount: Number(r.subscribed_count),
      automaticSubscription: flag(r.automatic_subscription),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    topUps: (
      await q<any>(
        `SELECT hash, block, ${AS_TEXT('transaction_date')} AS transaction_date,
                from_wallet, amount, identity_key, ${AS_TEXT('created_at')} AS created_at
           FROM ${SUBSCRIPTIONS_ID_TOP_UP_TABLE}`
      )
    ).map((r) => ({
      hash: r.hash,
      block: Number(r.block),
      transactionDate: r.transaction_date,
      fromWallet: r.from_wallet,
      amount: Number(r.amount),
      identityKey: r.identity_key,
      createdAt: r.created_at
    })),
    finalRows: (
      await q<any>(
        `SELECT id, identity_key, consolidation_key, contract, token_id, subscribed_count,
                airdrop_address, balance, subscribed_at, phase, phase_subscriptions,
                phase_position, redeemed_count, ${AS_TEXT('created_at')} AS created_at,
                ${AS_TEXT('updated_at')} AS updated_at
           FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}`
      )
    ).map((r) => ({
      id: Number(r.id),
      identityKey: r.identity_key,
      consolidationKey: r.consolidation_key,
      contract: r.contract,
      tokenId: Number(r.token_id),
      subscribedCount: Number(r.subscribed_count),
      airdropAddress: r.airdrop_address,
      balance: Number(r.balance),
      subscribedAt: r.subscribed_at ?? null,
      phase: r.phase ?? null,
      phaseSubscriptions: Number(r.phase_subscriptions),
      phasePosition: Number(r.phase_position),
      redeemedCount: Number(r.redeemed_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    uploads: (
      await q<any>(
        `SELECT contract, token_id, date, upload_url, ${AS_TEXT('created_at')} AS created_at
           FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE}`
      )
    ).map((r) => ({
      contract: r.contract,
      tokenId: Number(r.token_id),
      date: r.date,
      uploadUrl: r.upload_url,
      createdAt: r.created_at
    })),
    redeemed: (
      await q<any>(
        `SELECT identity_key, consolidation_key, contract, token_id, address,
                \`transaction\`, ${AS_TEXT('transaction_date')} AS transaction_date, value,
                balance_after, count, ${AS_TEXT('created_at')} AS created_at
           FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}`
      )
    ).map((r) => ({
      identityKey: r.identity_key,
      consolidationKey: r.consolidation_key,
      contract: r.contract,
      tokenId: Number(r.token_id),
      address: r.address,
      transaction: r.transaction,
      transactionDate: r.transaction_date ?? null,
      value: Number(r.value),
      balanceAfter: Number(r.balance_after),
      count: Number(r.count),
      createdAt: r.created_at
    })),
    logs: (
      await q<any>(
        `SELECT legacy_id, queue_sequence, identity_key, consolidation_key, log, additional_info,
                ${AS_TEXT('created_at')} AS created_at FROM ${SUBSCRIPTIONS_ID_LOGS_TABLE}`
      )
    ).map((r) => ({
      legacyId: r.legacy_id === null ? null : Number(r.legacy_id),
      queueSequence:
        r.queue_sequence === null ? null : Number(r.queue_sequence),
      identityKey: r.identity_key,
      consolidationKey: r.consolidation_key,
      log: r.log,
      additionalInfo: r.additional_info ?? null,
      createdAt: r.created_at
    }))
  };
}

export interface SectionDiff {
  readonly section: string;
  readonly expected: number;
  readonly actual: number;
  /** Rows in the expected side only, then in the actual side only (first 5). */
  readonly missing: string[];
  readonly extra: string[];
  readonly missingCount: number;
  readonly extraCount: number;
}

const rowText = canonicalJson;

/** Multiset difference of two sections' rows, by their canonical text. */
export function diffSection(
  section: string,
  expected: readonly unknown[],
  actual: readonly unknown[]
): SectionDiff {
  const counts = new Map<string, number>();
  for (const row of expected) {
    const text = rowText(row);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const extra: string[] = [];
  for (const row of actual) {
    const text = rowText(row);
    const left = counts.get(text) ?? 0;
    if (left > 0) {
      counts.set(text, left - 1);
    } else {
      extra.push(text);
    }
  }
  const missing: string[] = [];
  for (const [text, left] of Array.from(counts.entries())) {
    for (let i = 0; i < left; i++) {
      missing.push(text);
    }
  }
  return {
    section,
    expected: expected.length,
    actual: actual.length,
    missing: missing.slice(0, 5),
    extra: extra.slice(0, 5),
    missingCount: missing.length,
    extraCount: extra.length
  };
}

function sectionsOf(parsed: ParsedOpening): IdentitySections {
  const { opening, history } = parsed;
  return {
    keys: [...opening.keys],
    balances: [...opening.balances],
    modes: [...opening.modes],
    choices: [...opening.choices],
    topUps: [...opening.topUps],
    finalRows: [...opening.finalRows],
    uploads: [...opening.uploads],
    redeemed: [...opening.redeemed],
    logs: [...history.logs]
  };
}

function diffAll(
  label: string,
  expected: IdentitySections,
  actual: IdentitySections
): SectionDiff[] {
  return (Object.keys(expected) as Array<keyof IdentitySections>).map((name) =>
    diffSection(`${label}.${name}`, expected[name], actual[name])
  );
}

export interface G4Result {
  readonly ok: boolean;
  readonly diffs: SectionDiff[];
  /** The legacy tables cut again now: blocked keys found then. */
  readonly blockedNow: number;
}

/**
 * The opening comparison: the loaded identity tables hold exactly the file, and the legacy
 * tables, cut again now, give exactly the same file (nothing moved since
 * the cut). On a match the opening state is marked verified, which makes
 * the identity tables the truth once FEATURE_SUBSCRIPTIONS_IDENTITY_FROM
 * has passed. On any difference nothing is marked.
 */
export async function compareAndMarkVerified(
  parsed: ParsedOpening,
  directory: IdentityDirectory,
  nowMs: number = Date.now()
): Promise<G4Result> {
  const expected = sectionsOf(parsed);
  const loaded = diffAll('identity', expected, await dumpIdentityTables());
  // Cut again with the file's cut time, so the rows the cut itself writes
  // (merged and credited balances) carry the same times.
  const again = await cutOpeningFiles(
    directory,
    Date.parse(parsed.opening.cut.at)
  );
  const legacy = diffAll('legacy', expected, sectionsOf(again));
  const pastChoices = diffSection(
    'legacy.pastChoices',
    parsed.history.pastChoices,
    again.history.pastChoices
  );
  const diffs = [...loaded, ...legacy, pastChoices];
  const ok =
    again.opening.blocked.length === 0 &&
    diffs.every((d) => d.missingCount === 0 && d.extraCount === 0);
  if (ok) {
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
          SET verified_at = :nowMs
        WHERE id = :id AND opening_sha256 = :sha AND suspended_at IS NULL`,
      { nowMs, id: OPENING_STATE_ID, sha: parsed.openingSha256 }
    );
    const [state] = await sqlExecutor.execute<{ verified_at: number | null }>(
      `SELECT verified_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id AND opening_sha256 = :sha`,
      { id: OPENING_STATE_ID, sha: parsed.openingSha256 }
    );
    if (!state || state.verified_at === null) {
      throw new Error(
        'The identity tables hold another load; nothing was marked'
      );
    }
  }
  return { ok, diffs, blockedNow: again.opening.blocked.length };
}

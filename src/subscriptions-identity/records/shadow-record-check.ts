import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { sqlExecutor } from '@/sql-executor';
import { compareText } from '../engine/text-order';
import type { ChoiceEffects } from '../identity/identity-choices';
import { flag, Flag } from '../opening/legacy-tables';
import type { ComparisonReport, RowDiff } from '../writers/identity-reports';
import type { SubscriptionChange } from './subscription-records';

/*
 * In shadow, a signed change is applied to the identity tables after
 * today's write has changed the legacy tables. This compares what the two
 * now hold for the rows the change is about: the mode row and every
 * upcoming card for a mode or editions change, the one card for a card or
 * count change, and the log lines each write added. A report names the
 * rows and fields that differ, never their values or the record.
 */

type Fields = Readonly<Record<string, string>>;

/** The legacy log's last id for a key, before today's write adds lines. */
export async function legacyLogMark(consolidationKey: string): Promise<number> {
  const [row] = await sqlExecutor.execute<{ id: number | string | null }>(
    `SELECT MAX(id) AS id FROM ${SUBSCRIPTIONS_LOGS_TABLE} WHERE consolidation_key = :key`,
    { key: consolidationKey }
  );
  return Number(row?.id ?? 0);
}

async function modeRow(
  table: string,
  keyColumn: string,
  key: string
): Promise<Fields | null> {
  const [row] = await sqlExecutor.execute<{
    automatic: Flag;
    subscribe_all_editions: Flag;
  }>(
    `SELECT automatic, subscribe_all_editions FROM ${table} WHERE ${keyColumn} = :key`,
    { key }
  );
  return row
    ? {
        automatic: String(flag(row.automatic)),
        subscribe_all_editions: String(flag(row.subscribe_all_editions))
      }
    : null;
}

async function cardRows(
  table: string,
  keyColumn: string,
  key: string,
  tokens: { readonly after: number } | { readonly only: number }
): Promise<Map<string, Fields>> {
  const rows = await sqlExecutor.execute<{
    token_id: number | string;
    subscribed: Flag;
    subscribed_count: number | string;
    automatic_subscription: Flag;
  }>(
    `SELECT token_id, subscribed, subscribed_count, automatic_subscription
       FROM ${table}
      WHERE ${keyColumn} = :key AND contract = :contract
        AND ${'only' in tokens ? 'token_id = :token' : 'token_id > :token'}`,
    {
      key,
      contract: MEMES_CONTRACT,
      token: 'only' in tokens ? tokens.only : tokens.after
    }
  );
  return new Map(
    rows.map((row) => [
      `card ${Number(row.token_id)}`,
      {
        subscribed: String(flag(row.subscribed)),
        subscribed_count: String(Number(row.subscribed_count)),
        automatic_subscription: String(flag(row.automatic_subscription))
      }
    ])
  );
}

/** The rows a change is about, on one side. */
async function rowsOf(
  side: 'legacy' | 'identity',
  key: string,
  change: SubscriptionChange,
  maxMemeId: number
): Promise<Map<string, Fields>> {
  const [modeTable, cardTable, keyColumn] =
    side === 'legacy'
      ? [
          SUBSCRIPTIONS_MODE_TABLE,
          SUBSCRIPTIONS_NFTS_TABLE,
          'consolidation_key'
        ]
      : [
          SUBSCRIPTIONS_ID_MODE_TABLE,
          SUBSCRIPTIONS_ID_NFTS_TABLE,
          'identity_key'
        ];
  if (change.type === 'subs.card' || change.type === 'subs.count') {
    return cardRows(cardTable, keyColumn, key, { only: change.tokenId });
  }
  const rows = await cardRows(cardTable, keyColumn, key, { after: maxMemeId });
  const mode = await modeRow(modeTable, keyColumn, key);
  if (mode) {
    rows.set('mode', mode);
  }
  return rows;
}

function rowDiffs(
  legacy: ReadonlyMap<string, Fields>,
  identity: ReadonlyMap<string, Fields>
): RowDiff[] {
  const keys = Array.from(
    new Set([...Array.from(legacy.keys()), ...Array.from(identity.keys())])
  ).sort(compareText);
  const diffs: RowDiff[] = [];
  for (const key of keys) {
    const left = legacy.get(key);
    const right = identity.get(key);
    if (!left || !right) {
      diffs.push({
        key,
        legacy: left ? 'row' : null,
        identity: right ? 'row' : null
      });
      continue;
    }
    for (const field of Object.keys(left).sort(compareText)) {
      if (left[field] !== right[field]) {
        diffs.push({ key: `${key} ${field}`, legacy: null, identity: null });
      }
    }
  }
  return diffs;
}

const lineText = (log: string, additionalInfo: string | null) =>
  JSON.stringify([log, additionalInfo]);

function cardOf(change: SubscriptionChange): {
  contract: string | null;
  tokenId: number | null;
} {
  return change.type === 'subs.card' || change.type === 'subs.count'
    ? { contract: change.contract, tokenId: change.tokenId }
    : { contract: null, tokenId: null };
}

/**
 * Compares the legacy rows of the route's key with the identity rows of
 * its identity after both writes, and the log lines each added.
 */
export async function compareShadowChange(input: {
  readonly routeKey: string;
  readonly change: SubscriptionChange;
  readonly effects: ChoiceEffects;
  /** null: the mark could not be read, so lines are not compared. */
  readonly legacyLogMark: number | null;
  readonly eventId: string;
}): Promise<ComparisonReport> {
  const { routeKey, change, effects } = input;
  const maxMemeId = await getMaxMemeId(true);
  const legacy = await rowsOf('legacy', routeKey, change, maxMemeId);
  const identity = await rowsOf(
    'identity',
    effects.identityKey,
    change,
    maxMemeId
  );
  const mark = input.legacyLogMark;
  const legacyLines =
    mark === null
      ? []
      : (
          await sqlExecutor.execute<{
            log: string;
            additional_info: string | null;
          }>(
            `SELECT log, additional_info FROM ${SUBSCRIPTIONS_LOGS_TABLE}
              WHERE consolidation_key = :key AND id > :mark ORDER BY id`,
            { key: routeKey, mark }
          )
        ).map((line) => lineText(line.log, line.additional_info));
  const identityLines =
    mark === null
      ? []
      : effects.logs.map((line) => lineText(line.log, line.additionalInfo));
  const diffs = rowDiffs(legacy, identity);
  const sorted = (lines: string[]) => [...lines].sort(compareText).join('\n');
  if (sorted(legacyLines) !== sorted(identityLines)) {
    diffs.push({
      key: 'log lines',
      legacy: String(legacyLines.length),
      identity: String(identityLines.length)
    });
  }
  return {
    kind: 'RECORD',
    mode: 'SHADOW',
    ...cardOf(change),
    verdict: diffs.length ? 'DIFF' : 'MATCH',
    legacyRows: legacy.size + legacyLines.length,
    identityRows: identity.size + identityLines.length,
    diffs,
    notes: [
      `${change.type} ${input.eventId}`,
      ...(mark === null ? ['log lines not compared'] : [])
    ]
  };
}

/**
 * A signed change that did not reach the identity tables while today's
 * write went through, with the cause as a code (a refusal's reason or rule
 * code), never the record or the refusal's text:
 * - REFUSED: the record itself was not taken (it did not verify, did not
 *   state the request, was stale, or could not be checked), or the route
 *   key's wallets span identities for now (mid re-key); neither says
 *   anything about the identity tables, so the gate skips it;
 * - DIFF: the identity side's rules refused what today's write took;
 * - FAILED: the identity side failed (an error).
 */
export function failedShadowReport(
  change: SubscriptionChange,
  failure: {
    readonly verdict: 'REFUSED' | 'DIFF' | 'FAILED';
    readonly cause: string;
  },
  eventId: string | null
): ComparisonReport {
  return {
    kind: 'RECORD',
    mode: 'SHADOW',
    ...cardOf(change),
    verdict: failure.verdict,
    legacyRows: 0,
    identityRows: 0,
    diffs: [
      { key: 'record not applied', legacy: null, identity: failure.cause }
    ],
    notes: [`${change.type} ${eventId ?? 'no event id'}`, failure.cause]
  };
}

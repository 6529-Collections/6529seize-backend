import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { fetchAirdropAddressForConsolidationKey } from '@/delegationsLoop/db.delegations';
import { sqlExecutor } from '@/sql-executor';
import { fetchSubscriptionEligibilityForKeys } from '@/subscriptionsDaily/db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from '@/subscriptionsDaily/subscription-eligibility';
import {
  AirdropTarget,
  buildFinalList,
  FinalListDecision,
  SubscriberBuildInput
} from '../engine/final-list';
import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import { AS_TEXT, flag, msToDbText } from '../opening/legacy-tables';
import { insertIdentityLog, journal, journalBefore } from '../timeline/journal';

/** Where shadow ids for rows only the identity side has begin. */
export const SHADOW_ONLY_ID_FROM = 1_000_000_000;

/** A row of a card's list as the identity tables hold it. */
export interface IdentityListRow {
  readonly id: number;
  readonly identityKey: string;
  /** The identity's consolidation key at the build (what the file shows). */
  readonly consolidationKey: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribedCount: number;
  readonly airdropAddress: string;
  readonly balance: number;
  readonly subscribedAt: string;
}

export interface IdentityListBuild {
  readonly tokenId: number;
  readonly rows: IdentityListRow[];
  readonly decisions: FinalListDecision[];
  /** What the build wrote, with the rows' ids: the build record's body. */
  readonly effects: BuildEffects;
}

const dbTextToMs = (text: string | null): number | null =>
  text ? Date.parse(`${text.replace(' ', 'T').slice(0, 23)}Z`) : null;

function decisionLog(
  decision: FinalListDecision,
  tokenId: number,
  dateStr: string
): { log: string; additional_info: string | null } {
  switch (decision.kind) {
    case 'ADDED':
      return {
        log: `Added to Final Subscription for Meme #${tokenId} on ${dateStr}`,
        additional_info: `Airdrop Address: ${decision.airdropAddress} - Subscription Count: x${decision.count} - Balance: ${decision.balance} ETH`
      };
    case 'INSUFFICIENT_BALANCE':
      return {
        log: `Insufficient Balance for Meme #${tokenId} on ${dateStr} - Not Added to Final Subscription`,
        additional_info: `Balance: ${decision.balance} ETH`
      };
    case 'NO_BALANCE':
      return {
        log: `No Balance for Meme #${tokenId} on ${dateStr}`,
        additional_info: null
      };
    case 'NO_COUNT':
      return {
        log: `No Subscription Count for Meme #${tokenId} on ${dateStr} - Not Added to Final Subscription`,
        additional_info: `Subscription Count: x${decision.requested} - Eligibility: x${decision.eligibility}`
      };
  }
}

/**
 * Builds a card's final list from the identity tables, by the legacy daily
 * build's rules (the engine's buildFinalList), and writes it there:
 * automatic rows for automatic subscribers with none, the queue push for
 * automatic subscribers short of balance, the build's log lines, and the
 * card's final rows. `idOf` gives a row the id it must share with the
 * legacy table (one id per final row across both tables); a row without
 * one takes the table's next id. It does not publish.
 */
export async function buildIdentityList(params: {
  readonly tokenId: number;
  readonly buildAtMs: number;
  readonly idOf?: (identityKey: string) => number | undefined;
  readonly directory?: IdentityDirectory;
}): Promise<IdentityListBuild> {
  const { tokenId, buildAtMs } = params;
  const directory = params.directory ?? mirrorIdentityDirectory;
  const buildText = msToDbText(buildAtMs);
  const dateStr = new Date(buildAtMs).toISOString().slice(0, 10);

  // Modes, choices and balances from one snapshot, so a top-up or fold
  // committing meanwhile is seen whole or not at all.
  const { modes, choices, balances } =
    await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        const options = { wrappedConnection: connection };
        const modes = await sqlExecutor.execute<{
          identity_key: string;
          automatic: number;
          subscribe_all_editions: number;
          updated_at: string;
        }>(
          `SELECT identity_key, automatic, subscribe_all_editions, ${AS_TEXT('updated_at')} AS updated_at
             FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}`,
          {},
          options
        );
        const choices = await sqlExecutor.execute<{
          identity_key: string;
          subscribed: number;
          subscribed_count: number;
          automatic_subscription: number;
          updated_at: string;
        }>(
          `SELECT identity_key, subscribed, subscribed_count, automatic_subscription,
                  ${AS_TEXT('updated_at')} AS updated_at
             FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE contract = :contract AND token_id = :tokenId`,
          { contract: MEMES_CONTRACT, tokenId },
          options
        );
        const balances = await sqlExecutor.execute<{
          identity_key: string;
          balance: number;
        }>(
          `SELECT identity_key, balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}`,
          {},
          options
        );
        return { modes, choices, balances };
      },
      { isolationLevel: 'REPEATABLE READ' }
    );

  const modeOf = new Map(modes.map((m) => [m.identity_key, m]));
  const choiceOf = new Map(choices.map((c) => [c.identity_key, c]));
  const balanceOf = new Map(
    balances.map((b) => [b.identity_key, Number(b.balance)])
  );
  const candidates = Array.from(
    new Set([
      ...choices.map((c) => c.identity_key),
      ...modes.filter((m) => flag(m.automatic)).map((m) => m.identity_key)
    ])
  );
  const consolidationKeys = await directory.consolidationKeysOf(candidates);
  const keyOf = (identity: string) =>
    consolidationKeys.get(identity) ?? identity;
  const eligibility = await fetchSubscriptionEligibilityForKeys(
    candidates.map(keyOf)
  );
  const airdrops = new Map<string, AirdropTarget>();
  for (const identity of candidates) {
    const target = await fetchAirdropAddressForConsolidationKey(
      keyOf(identity)
    );
    airdrops.set(identity, {
      airdropAddress: target.airdrop_address,
      tdhWallet: target.tdh_wallet
    });
  }

  const subscribers: SubscriberBuildInput[] = candidates.map((identity) => {
    const mode = modeOf.get(identity);
    const card = choiceOf.get(identity);
    return {
      key: identity,
      balance: balanceOf.has(identity) ? balanceOf.get(identity)! : null,
      mode: mode
        ? {
            automatic: flag(mode.automatic),
            subscribeAllEditions: flag(mode.subscribe_all_editions),
            updatedAtMs: dbTextToMs(mode.updated_at)
          }
        : null,
      card: card
        ? {
            subscribed: flag(card.subscribed),
            subscribedCount: Number(card.subscribed_count),
            automaticSubscription: flag(card.automatic_subscription),
            updatedAtMs: dbTextToMs(card.updated_at)
          }
        : null,
      eligibility:
        eligibility.get(keyOf(identity).toLowerCase()) ??
        MINIMUM_SUBSCRIPTION_ELIGIBILITY
    };
  });
  const build = buildFinalList({
    contract: MEMES_CONTRACT,
    tokenId,
    buildAtMs,
    subscribers,
    resolveAirdrop: (identity) =>
      airdrops.get(identity) ?? { airdropAddress: null, tdhWallet: null }
  });

  const logs: Array<BuildEffects['logs'][number]> = [];
  for (const populated of build.autoPopulated) {
    const mode = modeOf.get(populated.key);
    const eligibilityCount =
      eligibility.get(keyOf(populated.key).toLowerCase()) ??
      MINIMUM_SUBSCRIPTION_ELIGIBILITY;
    logs.push({
      identityKey: populated.key,
      consolidationKey: keyOf(populated.key),
      log: `Auto-Subscribed to Meme #${tokenId}`,
      additionalInfo: `Edition Preference: ${mode && flag(mode.subscribe_all_editions) ? 'All eligible' : 'One edition'} - Eligibility: x${eligibilityCount} - Subscription Count: x${populated.subscribedCount}`
    });
  }
  for (const decision of build.decisions) {
    const text = decisionLog(decision, tokenId, dateStr);
    logs.push({
      identityKey: decision.key,
      consolidationKey: keyOf(decision.key),
      log: text.log,
      additionalInfo: text.additional_info
    });
  }
  // Rows that share a legacy id go in first, so a row that takes the
  // table's next id can't take one a later row must share.
  const withIds = build.rows.map((row) => ({
    id: params.idOf?.(row.key),
    identityKey: row.key,
    consolidationKey: keyOf(row.key),
    contract: row.contract,
    tokenId: row.tokenId,
    subscribedCount: row.subscribedCount,
    airdropAddress: row.airdropAddress ?? '',
    balance: row.balance,
    subscribedAt: row.subscribedAt
  }));
  // In shadow the legacy side allocates ids. A row only the identity side
  // has (for example a wide identity the legacy tables hold back) takes an
  // id from SHADOW_ONLY_ID_FROM up, a range the legacy table never reaches;
  // the go-live load replaces every row with the legacy ids anyway.
  if (params.idOf) {
    const [highest] = await sqlExecutor.execute<{ id: number | null }>(
      `SELECT MAX(id) AS id FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE id >= :from`,
      { from: SHADOW_ONLY_ID_FROM }
    );
    let next = Math.max(Number(highest?.id ?? 0), SHADOW_ONLY_ID_FROM - 1) + 1;
    for (const row of withIds) {
      if (row.id === undefined) {
        row.id = next++;
      }
    }
  } else {
    // After the switch the identity table hands out ids and the legacy
    // table copies them. They go on from the highest id below the shadow
    // range in either table, whatever a shadow build left the identity
    // table's counter at.
    const [highest] = await sqlExecutor.execute<{ id: number | null }>(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE id < :from), 0),
         COALESCE((SELECT MAX(id) FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} WHERE id < :from), 0)
       ) AS id`,
      { from: SHADOW_ONLY_ID_FROM }
    );
    let next = Number(highest?.id ?? 0) + 1;
    for (const row of withIds) {
      row.id = next++;
    }
  }
  const effects: BuildEffects = {
    contract: MEMES_CONTRACT,
    tokenId,
    buildAtMs,
    autoPopulated: build.autoPopulated.map((p) => ({
      identityKey: p.key,
      subscribedCount: p.subscribedCount
    })),
    queuePushed: build.queuePushedKeys,
    logs,
    rows: [
      ...withIds.filter((r) => r.id !== undefined),
      ...withIds.filter((r) => r.id === undefined)
    ]
  };
  const rows = await applyBuildEffects(effects);
  return {
    tokenId,
    rows,
    decisions: build.decisions,
    effects: { ...effects, rows }
  };
}

/**
 * What a daily build writes to the identity tables: automatic rows for
 * automatic subscribers with none, the queue push for automatic
 * subscribers short of balance, the build's log lines, and the card's
 * final rows. The build's journal entry holds what it wrote, with a
 * checkpoint of the whole tables.
 */
export interface BuildEffects {
  readonly contract: string;
  readonly tokenId: number;
  readonly buildAtMs: number;
  readonly autoPopulated: ReadonlyArray<{
    readonly identityKey: string;
    readonly subscribedCount: number;
  }>;
  readonly queuePushed: readonly string[];
  readonly logs: ReadonlyArray<{
    readonly identityKey: string;
    readonly consolidationKey: string;
    readonly log: string;
    readonly additionalInfo: string | null;
  }>;
  /** A row without an id takes the table's next one. */
  readonly rows: ReadonlyArray<
    Omit<IdentityListRow, 'id'> & { readonly id?: number }
  >;
}

/**
 * Writes a build's effects and its journal entry in one transaction;
 * returns the rows with ids.
 */
export async function applyBuildEffects(
  effects: BuildEffects
): Promise<IdentityListRow[]> {
  const buildText = msToDbText(effects.buildAtMs);
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const q = <T>(sql: string, p: Record<string, unknown>) =>
      sqlExecutor.execute<T>(sql, p, options);
    // The rows the build changes, as they are before it: the queue-pushed
    // identities' mode rows and the card's final rows (replaced whole).
    const before = await journalBefore(
      {
        rows: [
          {
            table: 'mode',
            keys: effects.queuePushed.map((key) => ({ identity_key: key }))
          },
          {
            table: 'final',
            keys: [{ contract: effects.contract, token_id: effects.tokenId }]
          }
        ]
      },
      options
    );
    for (const populated of effects.autoPopulated) {
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
          (identity_key, contract, token_id, subscribed, subscribed_count, automatic_subscription,
           created_at, updated_at)
          VALUES (:identityKey, :contract, :tokenId, true, :count, true, :buildText, :buildText)`,
        {
          identityKey: populated.identityKey,
          contract: effects.contract,
          tokenId: effects.tokenId,
          count: populated.subscribedCount,
          buildText
        }
      );
    }
    if (effects.queuePushed.length > 0) {
      await q(
        `UPDATE ${SUBSCRIPTIONS_ID_MODE_TABLE} SET updated_at = :buildText
          WHERE identity_key IN (:keys)`,
        { buildText, keys: effects.queuePushed }
      );
    }
    const logIds: number[] = [];
    for (const line of effects.logs) {
      logIds.push(
        await insertIdentityLog(
          {
            identityKey: line.identityKey,
            consolidationKey: line.consolidationKey,
            log: line.log,
            additionalInfo: line.additionalInfo,
            atText: buildText
          },
          options
        )
      );
    }
    await q(
      `DELETE FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE contract = :contract AND token_id = :tokenId`,
      { contract: effects.contract, tokenId: effects.tokenId }
    );
    const rows: IdentityListRow[] = [];
    for (const row of effects.rows) {
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          (${row.id === undefined ? '' : 'id, '}identity_key, consolidation_key, contract, token_id,
           subscribed_count, airdrop_address, balance, subscribed_at, created_at, updated_at)
          VALUES (${row.id === undefined ? '' : ':id, '}:identityKey, :key, :contract, :tokenId,
           :count, :airdrop, :balance, :subscribedAt, :buildText, :buildText)`,
        {
          id: row.id,
          identityKey: row.identityKey,
          key: row.consolidationKey,
          contract: row.contract,
          tokenId: row.tokenId,
          count: row.subscribedCount,
          airdrop: row.airdropAddress,
          balance: row.balance,
          subscribedAt: row.subscribedAt,
          buildText
        }
      );
      const [inserted] = await q<{ id: number }>(
        `SELECT id FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          WHERE identity_key = :identityKey AND contract = :contract AND token_id = :tokenId`,
        {
          identityKey: row.identityKey,
          contract: row.contract,
          tokenId: row.tokenId
        }
      );
      rows.push({ ...row, id: Number(inserted.id) });
    }
    await journal(
      {
        kind: 'build',
        inputs: {
          contract: effects.contract,
          token_id: effects.tokenId,
          build_at_ms: effects.buildAtMs
        },
        before,
        rows: [
          {
            table: 'choices',
            keys: effects.autoPopulated.map((p) => ({
              identity_key: p.identityKey,
              contract: effects.contract,
              token_id: effects.tokenId
            })),
            inserted: true
          },
          {
            table: 'logs',
            keys: logIds.map((id) => ({ id })),
            inserted: true
          }
        ],
        atMs: effects.buildAtMs
      },
      options
    );
    return rows;
  });
}

/** Records the published file for the card, and journals it. */
export async function recordIdentityUpload(upload: {
  readonly contract: string;
  readonly token_id: number;
  readonly date?: string;
  readonly upload_url: string;
}): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const before = await journalBefore(
      {
        rows: [
          {
            table: 'upload',
            keys: [{ contract: upload.contract, token_id: upload.token_id }]
          }
        ]
      },
      options
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE} (contract, token_id, date, upload_url)
        VALUES (:contract, :tokenId, :date, :url)
        ON DUPLICATE KEY UPDATE date = VALUES(date), upload_url = VALUES(upload_url)`,
      {
        contract: upload.contract,
        tokenId: upload.token_id,
        date: upload.date ?? '',
        url: upload.upload_url
      },
      options
    );
    await journal(
      {
        kind: 'upload',
        inputs: { ...upload, date: upload.date ?? '' },
        before
      },
      options
    );
  });
}

import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE
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

  const modes = await sqlExecutor.execute<{
    identity_key: string;
    automatic: number;
    subscribe_all_editions: number;
    updated_at: string;
  }>(
    `SELECT identity_key, automatic, subscribe_all_editions, ${AS_TEXT('updated_at')} AS updated_at
       FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}`
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
    { contract: MEMES_CONTRACT, tokenId }
  );
  const balances = await sqlExecutor.execute<{
    identity_key: string;
    balance: number;
  }>(`SELECT identity_key, balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}`);

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

  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    const q = <T>(sql: string, p: Record<string, unknown>) =>
      sqlExecutor.execute<T>(sql, p, options);
    const log = async (
      identityKey: string,
      text: { log: string; additional_info: string | null }
    ) =>
      q(
        `INSERT INTO ${SUBSCRIPTIONS_ID_LOGS_TABLE}
          (identity_key, consolidation_key, log, additional_info)
          VALUES (:identityKey, :key, :log, :info)`,
        {
          identityKey,
          key: keyOf(identityKey),
          log: text.log,
          info: text.additional_info
        }
      );
    for (const populated of build.autoPopulated) {
      const mode = modeOf.get(populated.key);
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
          (identity_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
          VALUES (:identityKey, :contract, :tokenId, true, :count, true)`,
        {
          identityKey: populated.key,
          contract: MEMES_CONTRACT,
          tokenId,
          count: populated.subscribedCount
        }
      );
      const eligibilityCount =
        eligibility.get(keyOf(populated.key).toLowerCase()) ??
        MINIMUM_SUBSCRIPTION_ELIGIBILITY;
      await log(populated.key, {
        log: `Auto-Subscribed to Meme #${tokenId}`,
        additional_info: `Edition Preference: ${mode && flag(mode.subscribe_all_editions) ? 'All eligible' : 'One edition'} - Eligibility: x${eligibilityCount} - Subscription Count: x${populated.subscribedCount}`
      });
    }
    if (build.queuePushedKeys.length > 0) {
      await q(
        `UPDATE ${SUBSCRIPTIONS_ID_MODE_TABLE} SET updated_at = :buildText
          WHERE identity_key IN (:keys)`,
        { buildText, keys: build.queuePushedKeys }
      );
    }
    for (const decision of build.decisions) {
      await log(decision.key, decisionLog(decision, tokenId, dateStr));
    }
    await q(
      `DELETE FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE contract = :contract AND token_id = :tokenId`,
      { contract: MEMES_CONTRACT, tokenId }
    );
    const rows: IdentityListRow[] = [];
    // Rows that share a legacy id go in first, so a row that takes the
    // table's next id can't take one a later row must share.
    const ordered = [
      ...build.rows.filter((r) => params.idOf?.(r.key) !== undefined),
      ...build.rows.filter((r) => params.idOf?.(r.key) === undefined)
    ];
    for (const row of ordered) {
      const sharedId = params.idOf?.(row.key);
      await q(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          (${sharedId === undefined ? '' : 'id, '}identity_key, consolidation_key, contract, token_id,
           subscribed_count, airdrop_address, balance, subscribed_at)
          VALUES (${sharedId === undefined ? '' : ':id, '}:identityKey, :key, :contract, :tokenId,
           :count, :airdrop, :balance, :subscribedAt)`,
        {
          id: sharedId,
          identityKey: row.key,
          key: keyOf(row.key),
          contract: row.contract,
          tokenId: row.tokenId,
          count: row.subscribedCount,
          airdrop: row.airdropAddress,
          balance: row.balance,
          subscribedAt: row.subscribedAt
        }
      );
      const [inserted] = await q<{ id: number }>(
        `SELECT id FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          WHERE identity_key = :identityKey AND contract = :contract AND token_id = :tokenId`,
        { identityKey: row.key, contract: row.contract, tokenId: row.tokenId }
      );
      rows.push({
        id: Number(inserted.id),
        identityKey: row.key,
        consolidationKey: keyOf(row.key),
        contract: row.contract,
        tokenId: row.tokenId,
        subscribedCount: row.subscribedCount,
        airdropAddress: row.airdropAddress ?? '',
        balance: row.balance,
        subscribedAt: row.subscribedAt
      });
    }
    return { tokenId, rows, decisions: build.decisions };
  });
}

/** Records the published file for the card in the identity tables. */
export async function recordIdentityUpload(upload: {
  readonly contract: string;
  readonly token_id: number;
  readonly date?: string;
  readonly upload_url: string;
}): Promise<void> {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE} (contract, token_id, date, upload_url)
      VALUES (:contract, :tokenId, :date, :url)
      ON DUPLICATE KEY UPDATE date = VALUES(date), upload_url = VALUES(upload_url)`,
    {
      contract: upload.contract,
      tokenId: upload.token_id,
      date: upload.date ?? '',
      url: upload.upload_url
    }
  );
}

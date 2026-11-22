import { hasMinimumBalanceForAutomaticMode } from '@/api/subscriptions/insufficient-subscription-balance.exception';
import { getSubscriptionCutoffMemeId } from '@/api/subscriptions/subscription-cutoff';
import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { RecordRuleError } from '@/signed-records/record-index';
import { sqlExecutor } from '@/sql-executor';
import { fetchSubscriptionEligibilityForKeys } from '@/subscriptionsDaily/db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from '@/subscriptionsDaily/subscription-eligibility';
import { flag, Flag } from '../opening/legacy-tables';
import type { SubscriptionChange } from '../records/subscription-records';
import { insertIdentityLog } from '../timeline/journal';

/*
 * A person's choices in the identity tables, as the legacy routes and the
 * first top-up make them in the legacy tables: the same checks, the same
 * rows and the same log lines. A change is first worked out as effects
 * (plain data), then written; the caller journals what it wrote
 * (timeline/journal.ts), and a rebuild writes that back.
 */

/** One card row a change writes. */
export interface CardEffect {
  readonly contract: string;
  readonly tokenId: number;
  /**
   * 'upsert' adds the row if it is missing (a person's choice); 'update'
   * changes a row that exists (a mode change's flip, a count sync).
   */
  readonly op: 'upsert' | 'update';
  readonly subscribed?: boolean;
  readonly subscribedCount?: number;
  readonly automaticSubscription?: boolean;
  /**
   * Whether the row's time moves when a value changes, as the legacy
   * table's on-update time does, or stays (the legacy count sync keeps it:
   * it orders the list).
   */
  readonly touch: boolean;
}

export interface ChoiceEffects {
  readonly identityKey: string;
  /** The identity's consolidation key, which log rows are written under. */
  readonly consolidationKey: string;
  /** The database's datetime text, written as the rows' time. */
  readonly atText: string;
  readonly mode: {
    readonly automatic?: boolean;
    readonly subscribeAllEditions?: boolean;
  } | null;
  readonly cards: readonly CardEffect[];
  readonly logs: ReadonlyArray<{
    readonly log: string;
    readonly additionalInfo: string | null;
  }>;
}

export interface ChoiceScope {
  readonly identityKey: string;
  readonly consolidationKey: string;
  readonly atText: string;
  /** The caller's transaction. */
  readonly options: DbQueryOptions;
  /**
   * Today's checks (balance, cutoff, eligibility), refused with a
   * RecordRuleError in the legacy route's words. Off for a change the
   * caller has already checked (a first top-up).
   */
  readonly rules: boolean;
}

interface CardRow {
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
}

function q<T>(
  scope: ChoiceScope,
  sql: string,
  params: Record<string, unknown>
): Promise<T[]> {
  return sqlExecutor.execute<T>(sql, params, scope.options);
}

/**
 * The identity's rows are read with FOR UPDATE: a locking read sees the
 * latest committed row, not the transaction's snapshot, and holds it, so
 * the rules and the effects are worked out from the rows the write changes.
 */
const LOCKED = ' FOR UPDATE';

async function balanceOf(scope: ChoiceScope): Promise<number | null> {
  const [row] = await q<{ balance: number | string }>(
    scope,
    `SELECT balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :identityKey${LOCKED}`,
    { identityKey: scope.identityKey }
  );
  return row ? Number(row.balance) : null;
}

async function modeOf(
  scope: ChoiceScope
): Promise<{ automatic: boolean; subscribeAllEditions: boolean } | null> {
  const [row] = await q<{ automatic: Flag; subscribe_all_editions: Flag }>(
    scope,
    `SELECT automatic, subscribe_all_editions FROM ${SUBSCRIPTIONS_ID_MODE_TABLE}
      WHERE identity_key = :identityKey${LOCKED}`,
    { identityKey: scope.identityKey }
  );
  return row
    ? {
        automatic: flag(row.automatic),
        subscribeAllEditions: flag(row.subscribe_all_editions)
      }
    : null;
}

async function eligibilityOf(scope: ChoiceScope): Promise<number> {
  const key = scope.consolidationKey.toLowerCase();
  return (
    (await fetchSubscriptionEligibilityForKeys([key], scope.options)).get(
      key
    ) ?? MINIMUM_SUBSCRIPTION_ELIGIBILITY
  );
}

async function cardRowsAfter(
  scope: ChoiceScope,
  tokenId: number
): Promise<CardRow[]> {
  const rows = await q<{
    token_id: number | string;
    subscribed: Flag;
    subscribed_count: number | string;
    automatic_subscription: Flag;
  }>(
    scope,
    `SELECT token_id, subscribed, subscribed_count, automatic_subscription
       FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE}
      WHERE identity_key = :identityKey AND contract = :contract AND token_id > :tokenId
      ORDER BY token_id${LOCKED}`,
    { identityKey: scope.identityKey, contract: MEMES_CONTRACT, tokenId }
  );
  return rows.map((row) => ({
    tokenId: Number(row.token_id),
    subscribed: flag(row.subscribed),
    subscribedCount: Number(row.subscribed_count),
    automaticSubscription: flag(row.automatic_subscription)
  }));
}

async function assertOpen(scope: ChoiceScope, tokenId: number): Promise<void> {
  if (tokenId <= (await getSubscriptionCutoffMemeId(scope.options))) {
    throw new RecordRuleError(
      `Subscriptions are closed for Meme #${tokenId}.`,
      'CLOSED'
    );
  }
}

/**
 * The legacy quantity sync for one identity: with automatic mode and all
 * editions on, its automatic rows for cards after the last one ingested
 * take the eligibility as their count, keeping their time.
 */
function countSync(
  rows: readonly CardRow[],
  mode: { automatic: boolean; subscribeAllEditions: boolean },
  eligibility: number,
  maxMemeId: number
): CardEffect[] {
  if (!mode.automatic || !mode.subscribeAllEditions) {
    return [];
  }
  return rows
    .filter(
      (row) =>
        row.tokenId > maxMemeId &&
        row.subscribed &&
        row.automaticSubscription &&
        row.subscribedCount !== eligibility
    )
    .map((row) => ({
      contract: MEMES_CONTRACT,
      tokenId: row.tokenId,
      op: 'update' as const,
      subscribedCount: eligibility,
      touch: false
    }));
}

function effects(
  scope: ChoiceScope,
  parts: Pick<ChoiceEffects, 'mode' | 'cards' | 'logs'>
): ChoiceEffects {
  return {
    identityKey: scope.identityKey,
    consolidationKey: scope.consolidationKey,
    atText: scope.atText,
    ...parts
  };
}

/**
 * updateSubscriptionMode's change: the mode row, its log line, each card
 * after the cutoff turned to the new mode (subscribed back for automatic,
 * unsubscribed for manual) with a line each, then the count sync.
 */
async function modeEffects(
  scope: ChoiceScope,
  automatic: boolean
): Promise<ChoiceEffects> {
  if (automatic && scope.rules) {
    if (!hasMinimumBalanceForAutomaticMode(await balanceOf(scope))) {
      throw new RecordRuleError(
        `Not enough balance to set Subscription to Automatic. Need at least ${MEMES_MINT_PRICE} ETH.`,
        'BALANCE'
      );
    }
  }
  const cutoff = await getSubscriptionCutoffMemeId(scope.options);
  const maxMemeId = await getMaxMemeId(true, scope.options);
  const rows = await cardRowsAfter(scope, Math.min(cutoff, maxMemeId));
  const flips = rows.filter(
    (row) => row.tokenId > cutoff && row.subscribed !== automatic
  );
  const after = rows.map((row) =>
    flips.includes(row) ? { ...row, subscribed: automatic } : row
  );
  const current = await modeOf(scope);
  const sync = countSync(
    after,
    { automatic, subscribeAllEditions: current?.subscribeAllEditions ?? false },
    await eligibilityOf(scope),
    maxMemeId
  );
  const line = automatic ? 'Subscribed to' : 'Unsubscribed from';
  return effects(scope, {
    mode: { automatic },
    cards: [
      ...flips.map(
        (row): CardEffect => ({
          contract: MEMES_CONTRACT,
          tokenId: row.tokenId,
          op: 'update',
          subscribed: automatic,
          touch: true
        })
      ),
      ...sync
    ],
    logs: [
      {
        log: `Subscription Mode set to ${automatic ? 'Automatic' : 'Manual'}`,
        additionalInfo: null
      },
      ...flips.map((row) => ({
        log: `${line} Meme #${row.tokenId}`,
        additionalInfo: null
      }))
    ]
  });
}

/** updateSubscribeAllEditions's change: the preference, its line, the sync. */
async function allEditionsEffects(
  scope: ChoiceScope,
  all: boolean
): Promise<ChoiceEffects> {
  const maxMemeId = await getMaxMemeId(true, scope.options);
  const current = await modeOf(scope);
  const sync = countSync(
    await cardRowsAfter(scope, maxMemeId),
    { automatic: current?.automatic ?? false, subscribeAllEditions: all },
    await eligibilityOf(scope),
    maxMemeId
  );
  return effects(scope, {
    mode: { subscribeAllEditions: all },
    cards: sync,
    logs: [
      {
        log: `Edition preference set to ${all ? 'All eligible editions' : 'One edition'}`,
        additionalInfo: null
      }
    ]
  });
}

/** updateSubscription's change: one card subscribed or not, one line. */
async function cardEffects(
  scope: ChoiceScope,
  change: Extract<SubscriptionChange, { type: 'subs.card' }>
): Promise<ChoiceEffects> {
  const { tokenId, subscribed } = change;
  if (scope.rules) {
    if (subscribed) {
      const balance = await balanceOf(scope);
      if (balance === null || balance < MEMES_MINT_PRICE) {
        throw new RecordRuleError(
          `Not enough balance to subscribe. Need at least ${MEMES_MINT_PRICE} ETH.`,
          'BALANCE'
        );
      }
    }
    await assertOpen(scope, tokenId);
  }
  const mode = await modeOf(scope);
  const eligibility = await eligibilityOf(scope);
  const count = mode?.subscribeAllEditions ? eligibility : 1;
  return effects(scope, {
    mode: null,
    cards: [
      {
        contract: change.contract,
        tokenId,
        op: 'upsert',
        subscribed,
        subscribedCount: count,
        automaticSubscription: false,
        touch: true
      }
    ],
    logs: [
      subscribed
        ? {
            log: `Subscribed for Meme #${tokenId}`,
            additionalInfo: `Edition Preference: ${mode?.subscribeAllEditions ? 'All eligible' : 'One edition'} - Eligibility: x${eligibility} - Subscription Count: x${count}`
          }
        : { log: `Unsubscribed from Meme #${tokenId}`, additionalInfo: '' }
    ]
  });
}

/** updateSubscriptionCount's change: one card's count, one line. */
async function countEffects(
  scope: ChoiceScope,
  change: Extract<SubscriptionChange, { type: 'subs.count' }>
): Promise<ChoiceEffects> {
  const { tokenId, count } = change;
  const eligibility = await eligibilityOf(scope);
  if (scope.rules) {
    await assertOpen(scope, tokenId);
    const [row] = await q<{ subscribed: Flag }>(
      scope,
      `SELECT subscribed FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE}
        WHERE identity_key = :identityKey AND contract = :contract AND token_id = :tokenId${LOCKED}`,
      { identityKey: scope.identityKey, contract: change.contract, tokenId }
    );
    if (row && !flag(row.subscribed)) {
      throw new RecordRuleError(
        `You are not currently subscribed for Meme #${tokenId}`,
        'NOT_SUBSCRIBED'
      );
    }
    if (count > eligibility) {
      throw new RecordRuleError(
        `Eligibility count for Meme #${tokenId} is ${eligibility}. You cannot increase the subscription count beyond this limit.`,
        'OVER_ELIGIBILITY'
      );
    }
    const balance = await balanceOf(scope);
    const requiredBalance = count * MEMES_MINT_PRICE;
    if (balance === null || balance < requiredBalance) {
      throw new RecordRuleError(
        `Not enough balance to subscribe for ${count} editions. Need at least ${requiredBalance} ETH.`,
        'BALANCE'
      );
    }
  }
  return effects(scope, {
    mode: null,
    cards: [
      {
        contract: change.contract,
        tokenId,
        op: 'upsert',
        subscribedCount: count,
        automaticSubscription: false,
        touch: true
      }
    ],
    logs: [
      {
        log: `Updated subscription count for Meme #${tokenId} to x${count}`,
        additionalInfo: `Eligibility: x${eligibility}`
      }
    ]
  });
}

/** Works out a change's effects; with rules on, refuses as the routes do. */
async function choiceEffects(
  scope: ChoiceScope,
  change: SubscriptionChange
): Promise<ChoiceEffects> {
  switch (change.type) {
    case 'subs.mode':
      return modeEffects(scope, change.automatic);
    case 'subs.all-editions':
      return allEditionsEffects(scope, change.all);
    case 'subs.card':
      return cardEffects(scope, change);
    case 'subs.count':
      return countEffects(scope, change);
  }
}

/**
 * The legacy card and count writes check the cutoff again in their
 * transaction after writing, so a change that crossed the cutoff while it
 * ran rolls back.
 */
async function assertChoiceStillOpen(
  scope: ChoiceScope,
  change: SubscriptionChange
): Promise<void> {
  if (
    scope.rules &&
    (change.type === 'subs.card' || change.type === 'subs.count')
  ) {
    await assertOpen(scope, change.tokenId);
  }
}

const MODE_COLUMNS = {
  automatic: 'automatic',
  subscribeAllEditions: 'subscribe_all_editions'
} as const;

const CARD_COLUMNS = {
  subscribed: 'subscribed',
  subscribedCount: 'subscribed_count',
  automaticSubscription: 'automatic_subscription'
} as const;

interface ColumnSet {
  readonly column: string;
  readonly param: string;
  readonly value: unknown;
}

/** The columns an effect sets: the fields it carries, in the columns' order. */
function setColumns(
  values: object,
  columns: Readonly<Record<string, string>>
): ColumnSet[] {
  const fields = values as Record<string, unknown>;
  const sets = Object.entries(columns)
    .filter(([field]) => fields[field] !== undefined)
    .map(([field, column]) => ({ column, param: field, value: fields[field] }));
  if (sets.length === 0) {
    throw new Error('A subscription effect sets no column');
  }
  return sets;
}

/**
 * The time a write gives the row: unchanged when every value it sets is
 * already there (MySQL's on-update rule), else the change's time. It is
 * assigned first, so it compares the old values.
 */
function movedTime(
  sets: readonly ColumnSet[],
  newValue: (set: ColumnSet) => string
): string {
  const same = sets
    .map((set) => `${set.column} <=> ${newValue(set)}`)
    .join(' AND ');
  return `IF(${same}, updated_at, :atText)`;
}

const paramsOf = (sets: readonly ColumnSet[]) =>
  Object.fromEntries(sets.map((s) => [s.param, s.value]));

/**
 * Writes a change's effects in the caller's transaction; returns the ids
 * of the log lines, which the caller's journal entry holds.
 */
async function applyChoiceEffects(
  effects: ChoiceEffects,
  options: DbQueryOptions
): Promise<number[]> {
  const { identityKey, atText } = effects;
  const run = (sql: string, params: Record<string, unknown>) =>
    sqlExecutor.execute(sql, { identityKey, atText, ...params }, options);
  if (effects.mode) {
    const sets = setColumns(effects.mode, MODE_COLUMNS);
    await run(
      `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE}
        (identity_key, ${sets.map((s) => s.column).join(', ')}, created_at, updated_at)
        VALUES (:identityKey, ${sets.map((s) => `:${s.param}`).join(', ')}, :atText, :atText)
        ON DUPLICATE KEY UPDATE
          updated_at = ${movedTime(sets, (s) => `VALUES(${s.column})`)},
          ${sets.map((s) => `${s.column} = VALUES(${s.column})`).join(', ')}`,
      paramsOf(sets)
    );
  }
  for (const card of effects.cards) {
    const sets = setColumns(card, CARD_COLUMNS);
    const params = {
      contract: card.contract,
      tokenId: card.tokenId,
      ...paramsOf(sets)
    };
    if (card.op === 'upsert') {
      const time = card.touch
        ? movedTime(sets, (s) => `VALUES(${s.column})`)
        : 'updated_at';
      await run(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
          (identity_key, contract, token_id, ${sets.map((s) => s.column).join(', ')}, created_at, updated_at)
          VALUES (:identityKey, :contract, :tokenId, ${sets.map((s) => `:${s.param}`).join(', ')}, :atText, :atText)
          ON DUPLICATE KEY UPDATE
            updated_at = ${time},
            ${sets.map((s) => `${s.column} = VALUES(${s.column})`).join(', ')}`,
        params
      );
    } else {
      const time = card.touch
        ? movedTime(sets, (s) => `:${s.param}`)
        : 'updated_at';
      await run(
        `UPDATE ${SUBSCRIPTIONS_ID_NFTS_TABLE}
            SET updated_at = ${time},
                ${sets.map((s) => `${s.column} = :${s.param}`).join(', ')}
          WHERE identity_key = :identityKey AND contract = :contract AND token_id = :tokenId`,
        params
      );
    }
  }
  const logIds: number[] = [];
  for (const line of effects.logs) {
    logIds.push(
      await insertIdentityLog(
        {
          identityKey,
          consolidationKey: effects.consolidationKey,
          log: line.log,
          additionalInfo: line.additionalInfo,
          atText
        },
        options
      )
    );
  }
  return logIds;
}

/** What a change wrote: its effects and the ids of its log lines. */
export interface MadeChoice {
  readonly effects: ChoiceEffects;
  readonly logIds: number[];
}

/**
 * Makes a change in the identity tables, in the caller's transaction: works
 * it out (with rules on, refused as the legacy route refuses it), writes
 * it, and with rules on checks the cutoff again as the legacy card and
 * count writes do. The caller journals it.
 */
export async function makeChoice(
  scope: ChoiceScope,
  change: SubscriptionChange
): Promise<MadeChoice> {
  const effects = await choiceEffects(scope, change);
  const logIds = await applyChoiceEffects(effects, scope.options);
  await assertChoiceStillOpen(scope, change);
  return { effects, logIds };
}

import { json2csv } from 'json-2-csv';
import { arweaveFileUploader } from '../arweave';
import { collections } from '../collections';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import {
  fetchAllProfiles,
  fetchWalletConsolidationKeysViewForWallet,
  getDataSource
} from '../db';
import { fetchAirdropAddressForConsolidationKey } from '../delegationsLoop/db.delegations';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTFinalSubscriptionUploadFields,
  NFTSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Logger } from '../logging';
import { getMaxMemeId } from '../nftsLoop/db.nfts';
import { sendDiscordUpdate } from '../notifier-discord';
import { sendDailySubscriptionsWaveUpdate } from '../subscription-wave-notifier';
import { sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';
import {
  IdentityWriteMode,
  subscriptionsIdentitySwitch
} from '@/subscriptions-identity/identity/identity-switch';
import {
  buildIdentityList,
  IdentityListBuild,
  IdentityListRow,
  recordIdentityUpload
} from '@/subscriptions-identity/writers/identity-daily-build';
import {
  compareKeyed,
  saveFailedReport,
  saveReport
} from '@/subscriptions-identity/writers/identity-reports';
import { journalCheckpoint } from '@/subscriptions-identity/timeline/journal';
import type { FileUploader } from '@/subscriptions-identity/opening/published-chain';
import { verifyPostedJournal } from '@/subscriptions-identity/opening/rebuild';
import { mirrorIdentityDirectory } from '@/subscriptions-identity/identity/identity-directory';
import { identityOfLegacyKeys } from '@/subscriptions-identity/writers/legacy-key-identities';
import {
  claimDeferredWrite,
  deferralReason,
  deferSubscriptionWrites
} from '@/subscription-key-width/subscription-deferred-writes';
import {
  fetchAllAutoSubscriptions,
  fetchAllNftSubscriptionBalances,
  fetchAllNftSubscriptions,
  fetchSubscriptionEligibilityForKeys,
  persistNFTFinalSubscriptions,
  splitFinalList,
  persistSubscriptions
} from './db.subscriptions';
import { MINIMUM_SUBSCRIPTION_ELIGIBILITY } from './subscription-eligibility';
import {
  mergeUpcomingSubscriptions,
  UpcomingSubscriptionState
} from './subscription-merge';
import { markSubscriptionCoverageDirty } from '../subscription-coverage/subscription-coverage-dirty';
import {
  resolveFinalSubscriptionCount,
  resolveRequestedSubscriptionCount
} from './subscription-final-count';

const logger = Logger.get('SUBSCRIPTIONS');

export interface UpdateSubscriptionsOptions {
  /** Where the list is published. Arweave unless told otherwise. */
  readonly uploader?: FileUploader;
}

export async function updateSubscriptions(
  options: UpdateSubscriptionsOptions = {}
) {
  const uploader = options.uploader ?? arweaveFileUploader;
  // A cold run that can't read the switch fails (Lambda retries it) rather
  // than publish the legacy list after the switch.
  const writeMode = await subscriptionsIdentitySwitch.writeModeOrFail();
  const buildAtMs = Time.now().toMillis();
  const autoSubscriptions = await fetchAllAutoSubscriptions();
  logger.info(`[FOUND ${autoSubscriptions.length} AUTO SUBSCRIPTIONS]`);

  const maxMemeId = await getMaxMemeId();
  const nextMemeId = maxMemeId + 1;

  logger.info(
    `[MAX CURRENT MEME ${maxMemeId}] [IDENTITY WRITERS ${writeMode}]`
  );

  // After the identity switch the identity tables build and publish the
  // list; the legacy tables are written the same rows, with the same ids.
  let identityList: IdentityListBuild | null = null;
  let identityUpload: NFTFinalSubscriptionUpload | null = null;
  if (writeMode === 'TRUTH') {
    identityList = await buildIdentityList({ tokenId: nextMemeId, buildAtMs });
    identityUpload = await uploadFinalSubscriptions(
      uploader,
      MEMES_CONTRACT,
      nextMemeId,
      identityList.rows.map(identityRowAsFinal),
      new Map(identityList.rows.map((r) => [r.id, r.identityKey]))
    );
    await recordIdentityUpload(identityUpload);
  }

  let legacy: LegacyBuild = {
    unwrittenRows: [],
    uploadLink: '',
    affectedConsolidationKeys: [],
    legacyRows: [],
    notes: []
  };
  try {
    await populateAutoSubscriptionsForMemeId(nextMemeId, autoSubscriptions);
    legacy = await buildFinalSubscription(
      nextMemeId,
      autoSubscriptions,
      identityList && identityUpload
        ? { list: identityList, upload: identityUpload }
        : null,
      uploader
    );
  } catch (error) {
    // After the switch the legacy tables are the rollback copy: the list
    // is already published from the identity tables, so a failed dual
    // write is reported and the run goes on to the notices.
    if (writeMode !== 'TRUTH') {
      throw error;
    }
    logger.error('[LEGACY DUAL WRITE OF THE LIST FAILED]', error);
    legacy = { ...legacy, notes: ['the legacy dual write failed'] };
  }
  const uploadLink = identityUpload?.upload_url ?? legacy.uploadLink;
  const { affectedConsolidationKeys, legacyRows } = legacy;
  await markSubscriptionCoverageDirty(
    affectedConsolidationKeys,
    'DAILY_FINALIZATION'
  );

  const seizeDomain =
    process.env.NODE_ENV === 'development' ? 'staging.6529' : '6529';
  let discordMessage = `📋 Published provisional list of Subscriptions for The Memes #${nextMemeId}`;
  discordMessage += ` \n\nView on [6529.io](https://${seizeDomain}.io/open-data/meme-subscriptions) | [Arweave](${uploadLink})`;
  await sendDiscordUpdate(
    process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
    discordMessage,
    'Subscriptions',
    'info'
  );
  await sendDailySubscriptionsWaveUpdate({
    memeId: nextMemeId,
    seizeDomain,
    uploadLink
  });

  // The comparisons come last: nothing the identity side does can hold up
  // or fail the published list's notices.
  if (writeMode === 'SHADOW') {
    await shadowIdentityList(nextMemeId, buildAtMs, legacy);
  } else if (identityList) {
    try {
      await reportListComparison(writeMode, identityList, legacy);
    } catch (error) {
      logger.error('[LIST COMPARISON FAILED]', error);
    }
  }
  // The day's checkpoint of the identity tables, for a rebuild to compare.
  if (writeMode !== 'OFF') {
    try {
      const checkpoint = await journalCheckpoint();
      logger.info(
        `[JOURNAL CHECKPOINT] through n=${checkpoint.through_n} ${checkpoint.state_sha256}`
      );
    } catch (error) {
      // Without checkpoints a rebuild can't go live: find out now.
      logger.errorWithCode(
        'SUBSCRIPTIONS_JOURNAL_CHECKPOINT_FAILED',
        `[JOURNAL CHECKPOINT FAILED] ${(error as Error).message}`
      );
    }
    // The day's check of the posted journal (once the records wave can be
    // read): money, Ethereum and signed records. Failures alert.
    try {
      const verified = await verifyPostedJournal();
      logger.info(`[JOURNAL VERIFY] ${verified}`);
    } catch (error) {
      logger.errorWithCode(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        `[JOURNAL VERIFY FAILED] the posted journal could not be checked: ${(error as Error).message}`
      );
    }
  }
}

async function populateAutoSubscriptionsForMemeId(
  newMeme: number,
  autoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );
  logger.info(
    `[NEW MEME ID ${newMeme}] : [SUBSCRIPTIONS ${newMemeSubscriptions.length}]`
  );

  const newMemeSubscriptionKeys = new Set<string>();
  newMemeSubscriptions.forEach((n) => {
    if (n.consolidation_key) {
      newMemeSubscriptionKeys.add(n.consolidation_key.toLowerCase());
    }
  });
  const autoSubscriptionsDelta = autoSubscriptions.filter(
    (s) =>
      !s.consolidation_key ||
      !newMemeSubscriptionKeys.has(s.consolidation_key.toLowerCase())
  );

  if (autoSubscriptionsDelta.length === 0) {
    logger.info(`[NO AUTO SUBSCRIPTIONS TO ADD...SKIPPING]`);
  } else {
    logger.info(
      `[FOUND ${autoSubscriptionsDelta.length} AUTO SUBSCRIPTIONS FOR NEW MEME]`
    );

    const newSubscriptions: NFTSubscription[] = [];
    const newSubscriptionLogs: SubscriptionLog[] = [];

    const eligibilityByKey = await fetchSubscriptionEligibilityForKeys(
      autoSubscriptionsDelta.map((s) => s.consolidation_key)
    );
    autoSubscriptionsDelta.forEach((s) => {
      let subscribedCount = 1;
      const eligibilityCount = s.consolidation_key
        ? (eligibilityByKey.get(s.consolidation_key.toLowerCase()) ??
          MINIMUM_SUBSCRIPTION_ELIGIBILITY)
        : MINIMUM_SUBSCRIPTION_ELIGIBILITY;
      if (s.subscribe_all_editions) {
        subscribedCount = eligibilityCount;
      }
      const sub: NFTSubscription = {
        consolidation_key: s.consolidation_key,
        contract: MEMES_CONTRACT,
        token_id: newMeme,
        subscribed: true,
        subscribed_count: subscribedCount,
        automatic_subscription: true
      };
      newSubscriptions.push(sub);
      const logText = `Auto-Subscribed to Meme #${newMeme}`;
      const additionalInfo = `Edition Preference: ${s.subscribe_all_editions ? 'All eligible' : 'One edition'} - Eligibility: x${eligibilityCount} - Subscription Count: x${subscribedCount}`;
      newSubscriptionLogs.push({
        consolidation_key: s.consolidation_key,
        log: logText,
        additional_info: additionalInfo
      });
    });
    await persistSubscriptions(newSubscriptions, newSubscriptionLogs);
    logger.info(
      `[NEW MEME ID ${newMeme}] : [CREATED ${newSubscriptions.length} AUTO SUBSCRIPTIONS]`
    );
  }
}

/**
 * After the identity switch: the identity tables' list for the card and its
 * published file. The legacy rows take the identity rows' ids, so each final
 * row has one id in both tables; a legacy row with no identity row is not
 * written (the list report names it).
 */
interface IdentityTruth {
  readonly list: IdentityListBuild;
  readonly upload: NFTFinalSubscriptionUpload;
}

function identityRowAsFinal(row: IdentityListRow): NFTFinalSubscription {
  return {
    id: row.id,
    consolidation_key: row.consolidationKey,
    contract: row.contract,
    token_id: row.tokenId,
    subscribed_count: row.subscribedCount,
    airdrop_address: row.airdropAddress,
    balance: row.balance,
    subscribed_at: row.subscribedAt,
    phase: null,
    phase_subscriptions: -1,
    phase_position: -1,
    redeemed_count: 0
  };
}

/**
 * The legacy rows written after the switch, each with its identity row's
 * id. Two legacy keys of one identity (a re-key the key-width guard held
 * back, merged at the cut) can't share one id: the first in list order
 * takes it, and the others are not written. A legacy row with no identity
 * row is not written either. Each skipped row is named in the notes.
 */
async function sharedIdRows(
  rows: NFTFinalSubscription[],
  identity: IdentityTruth
): Promise<{
  rows: NFTFinalSubscription[];
  skipped: NFTFinalSubscription[];
}> {
  const identities = await identityOfLegacyKeys(
    rows.map((r) => r.consolidation_key)
  );
  const idOf = new Map(identity.list.rows.map((r) => [r.identityKey, r.id]));
  const taken = new Set<number>();
  const shared: NFTFinalSubscription[] = [];
  const notes: string[] = [];
  const skipped: NFTFinalSubscription[] = [];
  for (const row of rows) {
    const identityKey = identities.get(row.consolidation_key.toLowerCase());
    const id = identityKey ? idOf.get(identityKey) : undefined;
    if (id === undefined) {
      notes.push(
        `legacy row without an identity row, not written: ${row.consolidation_key}`
      );
      skipped.push(row);
      continue;
    }
    if (taken.has(id)) {
      notes.push(
        `second legacy row of one identity, not written: ${row.consolidation_key}`
      );
      skipped.push(row);
      continue;
    }
    taken.add(id);
    shared.push({ ...row, id });
  }
  for (const note of notes) {
    logger.warn(`[LEGACY DUAL WRITE] [MEME #${identity.list.tokenId}] ${note}`);
  }
  return { rows: shared, skipped };
}

/**
 * Before the switch the legacy list is the truth and is already published.
 * The identity list is built from the identity tables, its rows sharing the
 * legacy rows' ids, and compared with it. A shadow failure is logged and
 * never fails the run (a retry would publish the legacy list again).
 */
async function shadowIdentityList(
  tokenId: number,
  buildAtMs: number,
  legacy: LegacyBuild
): Promise<IdentityListBuild | null> {
  const { legacyRows } = legacy;
  try {
    const identities = await identityOfLegacyKeys(
      legacyRows.map((r) => r.consolidation_key)
    );
    const legacyIdOf = new Map<string, number>();
    for (const row of legacyRows) {
      const identity = identities.get(row.consolidation_key.toLowerCase());
      if (identity && row.id !== undefined) {
        legacyIdOf.set(identity, row.id);
      }
    }
    const list = await buildIdentityList({
      tokenId,
      buildAtMs,
      idOf: (identity) => legacyIdOf.get(identity)
    });
    await reportListComparison('SHADOW', list, legacy);
    return list;
  } catch (error) {
    logger.error('[SHADOW IDENTITY LIST FAILED]', error);
    await saveFailedReport(
      'LIST',
      { contract: MEMES_CONTRACT, tokenId },
      error
    ).catch((reportError) =>
      logger.error('[FAILED REPORT NOT SAVED]', reportError)
    );
    return null;
  }
}

async function reportListComparison(
  mode: IdentityWriteMode,
  identityList: IdentityListBuild,
  legacy: Pick<LegacyBuild, 'legacyRows' | 'unwrittenRows' | 'notes'>
): Promise<void> {
  // Every row the legacy build made, written or not, by identity.
  const legacyAll = [...legacy.legacyRows, ...legacy.unwrittenRows];
  const identities = await identityOfLegacyKeys(
    legacyAll.map((r) => r.consolidation_key)
  );
  const text = (airdrop: string, count: number, balance: number) =>
    `${airdrop.toLowerCase()} x${count} balance ${balance}`;
  const notes: string[] = [];
  const legacyOf = new Map<string, NFTFinalSubscription[]>();
  const spanning: string[] = [];
  for (const row of legacyAll) {
    const identity = identities.get(row.consolidation_key.toLowerCase());
    if (!identity) {
      spanning.push(row.consolidation_key.toLowerCase());
      continue;
    }
    legacyOf.set(identity, [...(legacyOf.get(identity) ?? []), row]);
  }
  // A legacy key whose wallets now belong to several identities (a split
  // the legacy re-key hasn't made) has one row for all of them: those
  // identities can't be compared row by row.
  const spanned = new Set(
    (
      await mirrorIdentityDirectory.identitiesOf(
        spanning.flatMap((key) => key.split('-'))
      )
    ).values()
  );
  for (const key of spanning) {
    notes.push(`legacy key spans identities: ${key}`);
  }
  const identityRows = new Map(
    identityList.rows.map((r) => [r.identityKey, r])
  );
  const legacyText = new Map<string, string>();
  const identityText = new Map<string, string>();
  const keys = new Set([
    ...Array.from(legacyOf.keys()),
    ...Array.from(identityRows.keys())
  ]);
  for (const key of Array.from(keys)) {
    if (spanned.has(key)) {
      continue;
    }
    const rows = legacyOf.get(key) ?? [];
    const own = identityRows.get(key);
    const ownText = own
      ? text(own.airdropAddress, own.subscribedCount, own.balance)
      : null;
    if (rows.length >= 2 && own) {
      // One identity, several legacy keys (a re-key held back): its row
      // must go to one of their airdrop addresses, for no more than they
      // ask for together.
      const sum = rows.reduce(
        (total, r) => total + Number(r.subscribed_count),
        0
      );
      const fits =
        rows.some(
          (r) =>
            r.airdrop_address.toLowerCase() === own.airdropAddress.toLowerCase()
        ) && own.subscribedCount <= sum;
      if (fits) {
        notes.push(
          `second legacy row of one identity ${key}: ${rows.length} legacy rows, the identity row fits them`
        );
        continue;
      }
      legacyText.set(
        key,
        rows
          .map((r) => text(r.airdrop_address, r.subscribed_count, r.balance))
          .join(' + ')
      );
      identityText.set(key, ownText!);
      continue;
    }
    if (rows.length >= 1) {
      legacyText.set(
        key,
        rows
          .map((r) => text(r.airdrop_address, r.subscribed_count, r.balance))
          .join(' + ')
      );
    }
    if (ownText) {
      identityText.set(key, ownText);
    }
  }
  const diffs = compareKeyed(legacyText, identityText);
  // Spanning keys and merged identities are known causes; a difference
  // left, or a failed legacy write, is not.
  const unexplained = diffs.length + legacy.notes.length;
  await saveReport({
    kind: 'LIST',
    mode,
    contract: MEMES_CONTRACT,
    tokenId: identityList.tokenId,
    verdict:
      diffs.length === 0 && notes.length === 0 && legacy.notes.length === 0
        ? 'MATCH'
        : 'DIFF',
    legacyRows: legacyAll.length,
    identityRows: identityList.rows.length,
    diffs,
    notes: [...legacy.notes, ...notes],
    unexplained
  });
}

interface LegacyBuild {
  readonly uploadLink: string;
  readonly affectedConsolidationKeys: string[];
  /** The rows written to the legacy table, with their ids. */
  readonly legacyRows: NFTFinalSubscription[];
  /** What went wrong with the legacy write (after the switch: the dual write). */
  readonly notes: string[];
  /**
   * Rows the legacy build made but did not write: after the switch the dual
   * write's left-out rows, and the rows the key-width guard held back. The
   * list comparison still compares them.
   */
  readonly unwrittenRows: NFTFinalSubscription[];
}

async function buildFinalSubscription(
  newMeme: number,
  autoSubscriptions: SubscriptionMode[],
  identity: IdentityTruth | null,
  uploader: FileUploader
): Promise<LegacyBuild> {
  logger.info(`[BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}]`);

  const now = Time.now();
  const dateStr = now.toIsoDateString();

  const { finalSubscriptions, newSubscriptionLogs } =
    await createFinalSubscriptions(newMeme, dateStr, autoSubscriptions);

  // Split before publishing, so the published list and the final rows hold
  // the same subscribers; a key that must wait is on neither.
  const split = await splitFinalList(finalSubscriptions, newSubscriptionLogs);

  // After the switch the identity list is the published one, and the legacy
  // rows share its ids.
  const { rows, skipped } = identity
    ? await sharedIdRows(split.rows, identity)
    : { rows: split.rows, skipped: [] };
  const upload: NFTFinalSubscriptionUpload = identity
    ? identity.upload
    : await uploadFinalSubscriptions(uploader, MEMES_CONTRACT, newMeme, rows);

  const legacyRows = await persistNFTFinalSubscriptions(
    MEMES_CONTRACT,
    newMeme,
    upload,
    { ...split, rows }
  );

  return {
    legacyRows,
    notes: [],
    unwrittenRows: [
      ...skipped,
      ...split.deferred
        .filter((d) => d.kind === 'FINAL_ROW')
        .map((d) => d.payload as NFTFinalSubscription)
    ],
    uploadLink: upload.upload_url,
    affectedConsolidationKeys: Array.from(
      new Set(
        newSubscriptionLogs.map((subscription) =>
          subscription.consolidation_key.toLowerCase()
        )
      )
    )
  };
}

async function createFinalSubscriptions(
  newMeme: number,
  dateStr: string,
  autoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );

  const filteredSubscriptions = newMemeSubscriptions.filter(
    (sub) => sub.subscribed
  );

  logger.info(
    `[DATE ${dateStr}] : [BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${filteredSubscriptions.length} SUBSCRIPTIONS]`
  );

  const balances = await fetchAllNftSubscriptionBalances();
  const newSubscriptionLogs: SubscriptionLog[] = [];
  const finalSubscriptions: NFTFinalSubscription[] = [];

  const balanceByKey = new Map<string, SubscriptionBalance>();
  balances.forEach((b) => {
    if (b.consolidation_key) {
      const key = b.consolidation_key.toLowerCase();
      if (!balanceByKey.has(key)) {
        balanceByKey.set(key, b);
      }
    }
  });
  const autoSubscriptionByKey = new Map<string, SubscriptionMode>();
  autoSubscriptions.forEach((a) => {
    if (a.consolidation_key) {
      const key = a.consolidation_key.toLowerCase();
      if (!autoSubscriptionByKey.has(key)) {
        autoSubscriptionByKey.set(key, a);
      }
    }
  });
  const eligibilityByKey = await fetchSubscriptionEligibilityForKeys(
    filteredSubscriptions.map((sub) => sub.consolidation_key)
  );

  const subscriptionPromises = filteredSubscriptions.map(async (sub) => {
    const balance = sub.consolidation_key
      ? balanceByKey.get(sub.consolidation_key.toLowerCase())
      : undefined;

    const autoSub = sub.consolidation_key
      ? autoSubscriptionByKey.get(sub.consolidation_key.toLowerCase())
      : undefined;

    if (balance) {
      if (balance.balance >= MEMES_MINT_PRICE) {
        const { finalSub, subscriptionLog } = await addFundedFinalSubscription(
          sub,
          balance,
          autoSub,
          eligibilityByKey,
          newMeme,
          dateStr
        );
        if (finalSub) {
          finalSubscriptions.push(finalSub);
        }
        newSubscriptionLogs.push(subscriptionLog);
      } else {
        logger.info(
          `[INSUFFICIENT BALANCE FOR ${sub.consolidation_key}] : [SKIPPING]`
        );
        if (autoSub) {
          autoSub.updated_at = new Date();
          await getDataSource().getRepository(SubscriptionMode).save(autoSub);
        }
        newSubscriptionLogs.push({
          consolidation_key: sub.consolidation_key,
          log: `Insufficient Balance for Meme #${newMeme} on ${dateStr} - Not Added to Final Subscription`,
          additional_info: `Balance: ${balance.balance} ETH`
        });
      }
    } else {
      logger.info(`[NO BALANCE FOR ${sub.consolidation_key}] : [SKIPPING]`);
      newSubscriptionLogs.push({
        consolidation_key: sub.consolidation_key,
        log: `No Balance for Meme #${newMeme} on ${dateStr}`
      });
    }
  });

  await Promise.all(subscriptionPromises);

  finalSubscriptions.sort((a, d) => {
    // order subscriptions by created_at asc and then by balance
    if (a.subscribed_at === d.subscribed_at) {
      return d.balance - a.balance;
    }
    return a.subscribed_at < d.subscribed_at ? -1 : 1;
  });

  return { finalSubscriptions, newSubscriptionLogs };
}

async function addFundedFinalSubscription(
  sub: NFTSubscription,
  balance: SubscriptionBalance,
  autoSub: SubscriptionMode | undefined,
  eligibilityByKey: Map<string, number>,
  newMeme: number,
  dateStr: string
): Promise<{
  finalSub: NFTFinalSubscription | null;
  subscriptionLog: SubscriptionLog;
}> {
  let createdAt = sub.updated_at?.getTime() ?? Time.now().toMillis();
  if (autoSub) {
    createdAt = autoSub.updated_at?.getTime() ?? Time.now().toMillis();
  }
  const subscribedAt = Time.millis(createdAt).toIsoString();
  const eligibilityCount = sub.consolidation_key
    ? (eligibilityByKey.get(sub.consolidation_key.toLowerCase()) ??
      MINIMUM_SUBSCRIPTION_ELIGIBILITY)
    : MINIMUM_SUBSCRIPTION_ELIGIBILITY;
  const airdropAddress = await fetchAirdropAddressForConsolidationKey(
    sub.consolidation_key
  );
  const affordableCount = Math.floor(balance.balance / MEMES_MINT_PRICE);
  const requestedCount = resolveRequestedSubscriptionCount(
    sub,
    autoSub,
    eligibilityCount
  );
  const subscribedCount = resolveFinalSubscriptionCount(
    eligibilityCount,
    requestedCount,
    affordableCount
  );
  if (affordableCount < requestedCount) {
    logger.info(
      `[CAPPED BY BALANCE] ${sub.consolidation_key} requested x${requestedCount}, affordable x${affordableCount}, final x${subscribedCount}`
    );
  }
  if (subscribedCount === null) {
    logger.warn(
      `[NON-POSITIVE COUNT FOR ${sub.consolidation_key}] requested x${requestedCount}, eligibility x${eligibilityCount} : [SKIPPING]`
    );
    return {
      finalSub: null,
      subscriptionLog: {
        consolidation_key: sub.consolidation_key,
        log: `No Subscription Count for Meme #${newMeme} on ${dateStr} - Not Added to Final Subscription`,
        additional_info: `Subscription Count: x${requestedCount} - Eligibility: x${eligibilityCount}`
      }
    };
  }
  const finalSub: NFTFinalSubscription = {
    subscribed_at: subscribedAt,
    consolidation_key: sub.consolidation_key,
    contract: sub.contract,
    token_id: sub.token_id,
    subscribed_count: subscribedCount,
    airdrop_address: airdropAddress.airdrop_address,
    balance: balance.balance,
    phase: null,
    phase_subscriptions: -1,
    phase_position: -1,
    redeemed_count: 0
  };
  const logText = `Added to Final Subscription for Meme #${newMeme} on ${dateStr}`;
  const additionalInfo = `Airdrop Address: ${finalSub.airdrop_address} - Subscription Count: x${subscribedCount} - Balance: ${finalSub.balance} ETH`;

  const subscriptionLog: SubscriptionLog = {
    consolidation_key: sub.consolidation_key,
    log: logText,
    additional_info: additionalInfo
  };

  return { finalSub, subscriptionLog };
}

async function uploadFinalSubscriptions(
  uploader: FileUploader,
  contract: string,
  newMeme: number,
  finalSubscriptions: NFTFinalSubscription[],
  /** After the switch: the identity of each row, by row id, as a column. */
  identityById?: ReadonlyMap<number, string>
): Promise<NFTFinalSubscriptionUpload> {
  logger.info(
    `[UPLOADING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${finalSubscriptions.length} SUBSCRIPTIONS]`
  );
  const profiles = await fetchAllProfiles();
  const finalUpload: NFTFinalSubscriptionUploadFields[] =
    finalSubscriptions.map((sub) => {
      const profile = profiles.find((p) =>
        sub.consolidation_key
          .split('-')
          .some((key) => equalIgnoreCase(p.primary_wallet, key))
      );
      return {
        date: Time.now().toIsoDateString(),
        contract: contract,
        token_id: newMeme,
        count: sub.subscribed_count,
        profile: profile?.handle ?? '-',
        airdrop_address: sub.airdrop_address,
        consolidation_key: sub.consolidation_key,
        balance: sub.balance,
        subscribed_at: sub.subscribed_at,
        ...(identityById && sub.id !== undefined
          ? { identity: identityById.get(sub.id) ?? '' }
          : {})
      };
    });
  const csv = json2csv(finalUpload);
  const { url } = await uploader.uploadFile(Buffer.from(csv), 'text/csv');

  return {
    date: Time.now().toIsoDateString(),
    contract: contract,
    token_id: newMeme,
    upload_url: url
  };
}

const CONSOLIDATION_LOOKUP_CHUNK_SIZE = 5000;

async function fetchAffectedSubscriptions(
  addressList: string[]
): Promise<SubscriptionBalance[]> {
  const addressesFilter = addressList
    .map(
      (_, i) =>
        `${SUBSCRIPTIONS_BALANCES_TABLE}.consolidation_key LIKE :addressPattern${i}`
    )
    .join(' OR ');
  const addressesFilterParams = addressList.reduce(
    (acc, address, i) => {
      acc[`addressPattern${i}`] = `%${address}%`;
      return acc;
    },
    {} as Record<string, string>
  );

  return await sqlExecutor.execute(
    `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
    WHERE (${addressesFilter})`,
    addressesFilterParams
  );
}

async function buildViewKeyByWallet(
  walletPartsList: string[]
): Promise<Map<string, string>> {
  const viewKeyByWallet = new Map<string, string>();
  for (
    let i = 0;
    i < walletPartsList.length;
    i += CONSOLIDATION_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = walletPartsList.slice(i, i + CONSOLIDATION_LOOKUP_CHUNK_SIZE);
    const rows = await fetchWalletConsolidationKeysViewForWallet(chunk);
    rows.forEach((row) => {
      // the view's row shape is { address, consolidation_key }
      const rowAddress = (row as unknown as { address: string }).address;
      if (rowAddress && !viewKeyByWallet.has(rowAddress.toLowerCase())) {
        viewKeyByWallet.set(rowAddress.toLowerCase(), row.consolidation_key);
      }
    });
  }
  return viewKeyByWallet;
}

async function buildTdhByKey(
  candidateKeysList: string[]
): Promise<Map<string, number>> {
  const tdhByKey = new Map<string, number>();
  for (
    let i = 0;
    i < candidateKeysList.length;
    i += CONSOLIDATION_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = candidateKeysList.slice(
      i,
      i + CONSOLIDATION_LOOKUP_CHUNK_SIZE
    );
    const rows: { consolidation_key: string; boosted_tdh: number }[] =
      await sqlExecutor.execute(
        `SELECT consolidation_key, boosted_tdh FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE consolidation_key IN (:chunk)`,
        { chunk }
      );
    rows.forEach((row) => {
      if (row.consolidation_key && !tdhByKey.has(row.consolidation_key)) {
        tdhByKey.set(row.consolidation_key, row.boosted_tdh ?? 0);
      }
    });
  }
  return tdhByKey;
}

type QueryRunner = {
  query: (sql: string, params?: unknown[]) => Promise<any>;
};

interface UpcomingSubscriptionConflict {
  readonly surviving_id: number;
  readonly surviving_subscribed: unknown;
  readonly surviving_automatic_subscription: unknown;
  readonly surviving_subscribed_count: unknown;
  readonly surviving_updated_at: unknown;
  readonly merged_id: number;
  readonly merged_subscribed: unknown;
  readonly merged_automatic_subscription: unknown;
  readonly merged_subscribed_count: unknown;
  readonly merged_updated_at: unknown;
}

function upcomingSubscriptionState(
  conflict: UpcomingSubscriptionConflict,
  side: 'surviving' | 'merged'
): UpcomingSubscriptionState {
  return {
    subscribed: Boolean(Number(conflict[`${side}_subscribed`])),
    automatic_subscription: Boolean(
      Number(conflict[`${side}_automatic_subscription`])
    ),
    subscribed_count: Number(conflict[`${side}_subscribed_count`]),
    updated_at: new Date(conflict[`${side}_updated_at`] as string | Date)
  };
}

// Upcoming subscriptions are unique per (consolidation_key, contract,
// token_id). Rows of oldKey that newKey already has for the same card are
// combined into newKey's row; the rest are re-keyed. `updated_at` orders
// subscription priority, so re-keying keeps it. The conflicting rows are
// read FOR UPDATE: a plain read takes no locks, so a user's change between
// the read and the merge would be overwritten without an error. The unique
// key gives each merged row at most one surviving row, so no DISTINCT.
async function moveUpcomingSubscriptions(
  manager: QueryRunner,
  oldKey: string,
  newKey: string
) {
  const conflicts: UpcomingSubscriptionConflict[] = await manager.query(
    `SELECT
        surviving.id AS surviving_id,
        surviving.subscribed AS surviving_subscribed,
        surviving.automatic_subscription AS surviving_automatic_subscription,
        surviving.subscribed_count AS surviving_subscribed_count,
        surviving.updated_at AS surviving_updated_at,
        merged.id AS merged_id,
        merged.subscribed AS merged_subscribed,
        merged.automatic_subscription AS merged_automatic_subscription,
        merged.subscribed_count AS merged_subscribed_count,
        merged.updated_at AS merged_updated_at
      FROM ${SUBSCRIPTIONS_NFTS_TABLE} merged
      JOIN ${SUBSCRIPTIONS_NFTS_TABLE} surviving
        ON surviving.contract = merged.contract
        AND surviving.token_id = merged.token_id
        AND surviving.consolidation_key = ?
      WHERE merged.consolidation_key = ?
      FOR UPDATE`,
    [newKey, oldKey]
  );
  for (const conflict of conflicts) {
    const combined = mergeUpcomingSubscriptions(
      upcomingSubscriptionState(conflict, 'surviving'),
      upcomingSubscriptionState(conflict, 'merged')
    );
    await manager.query(
      `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE}
        SET subscribed = ?, automatic_subscription = ?,
          subscribed_count = ?, updated_at = ?
        WHERE id = ?`,
      [
        combined.subscribed,
        combined.automatic_subscription,
        combined.subscribed_count,
        combined.updated_at,
        conflict.surviving_id
      ]
    );
    await manager.query(
      `DELETE FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE id = ?`,
      [conflict.merged_id]
    );
  }
  await manager.query(
    `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE}
      SET consolidation_key = ?, updated_at = updated_at
      WHERE consolidation_key = ?`,
    [newKey, oldKey]
  );
}

// Final subscriptions are per-drop allocations that already carry an airdrop
// address, phase and position, so two of them for the same card are not
// combined automatically. The non-conflicting rows are re-keyed; conflicting
// ones stay under oldKey and are logged for manual reconciliation.
async function moveFinalSubscriptions(
  manager: QueryRunner,
  oldKey: string,
  newKey: string
) {
  const conflicts: { id: number; contract: string; token_id: number }[] =
    await manager.query(
      `SELECT DISTINCT merged.id AS id, merged.contract AS contract,
          merged.token_id AS token_id
        FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} merged
        JOIN ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} surviving
          ON surviving.contract = merged.contract
          AND surviving.token_id = merged.token_id
          AND surviving.consolidation_key = ?
        WHERE merged.consolidation_key = ?`,
      [newKey, oldKey]
    );
  if (conflicts.length) {
    logger.error(
      `[FINAL SUBSCRIPTION MERGE CONFLICT] [KEPT UNDER ${oldKey}] [${newKey} ALREADY HAS] [${conflicts
        .map((it) => `${it.contract}#${it.token_id}`)
        .join(', ')}]`
    );
  }
  const conflictIds = conflicts.map((it) => it.id);
  const excludeConflicts = conflictIds.length
    ? ` AND id NOT IN (${conflictIds.map(() => '?').join(',')})`
    : '';
  await manager.query(
    `UPDATE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      SET consolidation_key = ?, updated_at = updated_at
      WHERE consolidation_key = ?${excludeConflicts}`,
    [newKey, oldKey, ...conflictIds]
  );
}

function compareKeys(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Re-keys subscriptions after consolidation changes. With `replaySequence`
 * it replays a queued consolidation: the queue entry is claimed in the same
 * transaction, and false is returned when another run had claimed it.
 */
export async function consolidateSubscriptions(
  addresses: Set<string>,
  options: { readonly replaySequence?: number } = {}
): Promise<boolean> {
  const affectedSubscriptions = await fetchAffectedSubscriptions(
    Array.from(addresses)
  );

  logger.info(
    `[CONSOLIDATING SUBSCRIPTIONS] : [FOUND ${affectedSubscriptions.length} AFFECTED SUBSCRIPTIONS]`
  );

  // prefetch view keys for every wallet part and TDH for every candidate key,
  // instead of querying per wallet part inside the loop below
  const allWalletParts = new Set<string>();
  affectedSubscriptions.forEach((sub) => {
    sub.consolidation_key.split('-').forEach((wallet) => {
      if (wallet) {
        allWalletParts.add(wallet);
      }
    });
  });
  const walletPartsList = Array.from(allWalletParts);
  const viewKeyByWallet = await buildViewKeyByWallet(walletPartsList);

  const candidateKeys = new Set<string>();
  walletPartsList.forEach((wallet) => {
    candidateKeys.add(viewKeyByWallet.get(wallet.toLowerCase()) ?? wallet);
  });
  const tdhByKey = await buildTdhByKey(Array.from(candidateKeys));

  const replaceConsolidations = new Map<string, string>();

  for (const sub of affectedSubscriptions) {
    const walletParts = sub.consolidation_key.split('-');
    for (const wallet of walletParts) {
      const newConsolidationKey = wallet
        ? (viewKeyByWallet.get(wallet.toLowerCase()) ?? wallet)
        : wallet;

      const replaceConsolidation = replaceConsolidations.get(
        sub.consolidation_key
      );

      if (replaceConsolidation) {
        const replaceTdh = tdhByKey.get(replaceConsolidation) ?? 0;
        const newTdh = tdhByKey.get(newConsolidationKey) ?? 0;
        if (newTdh > replaceTdh) {
          replaceConsolidations.set(sub.consolidation_key, newConsolidationKey);
        } else {
          replaceConsolidations.set(
            sub.consolidation_key,
            replaceConsolidation
          );
        }
      } else {
        replaceConsolidations.set(sub.consolidation_key, newConsolidationKey);
      }
    }
  }

  // Each merged consolidation is all-or-nothing: if any of its moves fails,
  // its own changes are rolled back to the savepoint and logged, and the
  // other consolidations still commit, so one bad key cannot leave half-moved
  // rows or stop the delegations loop. A deadlock or lock-wait timeout rolls
  // back the whole transaction, savepoints included; then the run aborts with
  // the original error rather than continue outside a transaction.
  let claimed = true;
  await getDataSource().transaction(async (manager) => {
    if (options.replaySequence !== undefined) {
      claimed = await claimDeferredWrite(
        options.replaySequence,
        'DONE',
        manager
      );
      if (!claimed) {
        return;
      }
    }
    const uniqueValuesWithKeys = collections.getMapWithKeysAndValuesSwitched(
      replaceConsolidations
    );
    const newKeys = Array.from(uniqueValuesWithKeys.keys());
    for (let index = 0; index < newKeys.length; index++) {
      const newKey = newKeys[index];
      const oldKeys = uniqueValuesWithKeys.get(newKey);
      if (!oldKeys) {
        logger.error(`No keys found for value: ${newKey}`);
        continue;
      }
      // A new key the subscription tables can't hold yet is queued, not
      // merged; the old keys keep their rows until it is replayed.
      const reason = await deferralReason(
        newKey,
        manager,
        options.replaySequence,
        { locking: true }
      );
      if (reason) {
        await deferSubscriptionWrites(
          [
            {
              kind: 'CONSOLIDATION',
              consolidationKey: newKey,
              dedupe: `${newKey}|${oldKeys.slice().sort(compareKeys).join(',')}`,
              payload: { newKey, oldKeys },
              reason
            }
          ],
          manager
        );
        continue;
      }
      const savepoint = `consolidate_subscriptions_${index}`;
      await manager.query(`SAVEPOINT ${savepoint}`);
      try {
        await mergeSubscriptionsIntoKey(manager, newKey, oldKeys);
        await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (e) {
        logger.error(
          `[SUBSCRIPTION MERGE FAILED] [${oldKeys.join(', ')} -> ${newKey}]`,
          e
        );
        try {
          await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          logger.error(
            `[SUBSCRIPTION MERGE ABORTED] [${savepoint} is gone; the transaction was rolled back]`,
            rollbackError
          );
          throw e;
        }
        logger.warn(
          `[SUBSCRIPTION MERGE ROLLED BACK] [${oldKeys.join(', ')} -> ${newKey}]`
        );
      }
    }
  });
  return claimed;
}

async function mergeSubscriptionsIntoKey(
  manager: QueryRunner,
  newKey: string,
  oldKeys: string[]
) {
  for (const oldKey of oldKeys.filter((key) => key !== newKey)) {
    await moveUpcomingSubscriptions(manager, oldKey, newKey);
    await moveFinalSubscriptions(manager, oldKey, newKey);
    for (const table of [
      SUBSCRIPTIONS_LOGS_TABLE,
      SUBSCRIPTIONS_REDEEMED_TABLE
    ]) {
      await manager.query(
        `UPDATE ${table}
          SET consolidation_key = ?
          WHERE consolidation_key = ?`,
        [newKey, oldKey]
      );
    }
  }

  // newKey may already hold balance and mode rows of its own (both keyed by
  // consolidation_key), so they are folded in and replaced too.
  const balanceAndModeKeys = Array.from(new Set([...oldKeys, newKey]));
  const placeholders = balanceAndModeKeys.map(() => '?').join(',');
  const balanceResult = await manager.query(
    `SELECT SUM(balance) as total_balance
      FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
      WHERE consolidation_key IN (${placeholders})`,
    balanceAndModeKeys
  );
  const totalBalance = balanceResult[0]?.total_balance;

  const modeResult = await manager.query(
    `SELECT SUM(automatic = true) AS automatic_count,
      SUM(subscribe_all_editions = true) AS all_editions_count
      FROM ${SUBSCRIPTIONS_MODE_TABLE}
      WHERE consolidation_key IN (${placeholders})`,
    balanceAndModeKeys
  );
  // SUM over no rows is NULL, and MySQL returns DECIMAL sums as strings.
  const isSubscribed = Number(modeResult[0]?.automatic_count ?? 0) > 0;
  // Preserve All eligible if any source or existing destination selected it,
  // including when the preference was saved while that group was in Manual mode.
  const subscribeAllEditions =
    Number(modeResult[0]?.all_editions_count ?? 0) > 0;

  for (const key of balanceAndModeKeys) {
    await manager.query(
      `DELETE FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
        WHERE consolidation_key = ?`,
      [key]
    );
    await manager.query(
      `DELETE FROM ${SUBSCRIPTIONS_MODE_TABLE}
        WHERE consolidation_key = ?`,
      [key]
    );
  }

  await manager.query(
    `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance)
      VALUES (?, ?)`,
    [newKey, totalBalance]
  );
  await manager.query(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE}
      (consolidation_key, automatic, subscribe_all_editions)
      VALUES (?, ?, ?)`,
    [newKey, isSubscribed, subscribeAllEditions]
  );
}

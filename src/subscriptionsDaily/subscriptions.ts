import { arweaveFileUploader } from '../arweave';
import { MEMES_CONTRACT, MEMES_MINT_PRICE } from '../constants';
import { fetchAllProfiles } from '../db';
import { fetchPrimaryWallet } from '../db-api';
import { fetchAirdropAddressForDelegators } from '../delegationsLoop/db.delegations';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTFinalSubscriptionWithDateAndProfile,
  NFTSubscription,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { areEqualAddresses } from '../helpers';
import { Logger } from '../logging';
import { getMaxMemeId } from '../nftsLoop/db.nfts';
import { sendDiscordUpdate } from '../notifier-discord';
import { Time } from '../time';
import {
  fetchAllAutoSubscriptions,
  fetchAllNftSubscriptionBalances,
  fetchAllNftSubscriptions,
  persistNFTFinalSubscriptions,
  persistSubscriptions
} from './db.subscriptions';
import converter from 'json-2-csv';

const logger = Logger.get('SUBSCRIPTIONS');

export async function updateSubscriptions(reset?: boolean) {
  const currentAutoSubscriptions = await fetchAllAutoSubscriptions();
  logger.info(`[FOUND ${currentAutoSubscriptions.length} AUTO SUBSCRIPTIONS]`);

  const maxMemeId = await getMaxMemeId();
  const nextMemeId = maxMemeId + 1;

  logger.info(`[MAX CURRENT MEME ${maxMemeId}]`);

  for (let i = 0; i <= 2; i++) {
    await createForMemeId(nextMemeId + i, currentAutoSubscriptions);
  }

  const uploadLink = await buildFinalSubscription(nextMemeId);
  const seizeDomain =
    process.env.NODE_ENV === 'development' ? 'staging.seize' : 'seize';
  let discordMessage = `📋 Published provisional list of Subscriptions for The Memes Card #${nextMemeId}`;
  discordMessage += ` \n\n[View on Seize] \nhttps://${seizeDomain}.io/open-data/meme-subscriptions`;
  discordMessage += ` \n\n[View on Arweave] \n${uploadLink}`;
  await sendDiscordUpdate(
    process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
    discordMessage,
    'Subscriptions',
    'info'
  );
}

async function createForMemeId(
  newMeme: number,
  currentAutoSubscriptions: SubscriptionMode[]
) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );
  logger.info(
    `[NEW MEME ID ${newMeme}] : [SUBSCRIPTIONS ${newMemeSubscriptions.length}]`
  );

  if (newMemeSubscriptions.length > 0) {
    logger.info(`[SUBSCRIPTIONS FOR NEW MEME ALREADY EXIST...SKIPPING]`);
  } else {
    logger.info(`[POPULATING AUTOMATIC SUBSCRIPTIONS FOR NEW MEME]`);

    const newSubscriptions: NFTSubscription[] = [];
    const newSubscriptionLogs: SubscriptionLog[] = [];

    currentAutoSubscriptions.forEach((s) => {
      const sub: NFTSubscription = {
        consolidation_key: s.consolidation_key,
        contract: MEMES_CONTRACT,
        token_id: newMeme
      };
      newSubscriptions.push(sub);
      newSubscriptionLogs.push({
        consolidation_key: s.consolidation_key,
        log: `Auto-Subscribed to Meme #${newMeme}`
      });
    });
    await persistSubscriptions(newSubscriptions, newSubscriptionLogs);
    logger.info(
      `[NEW MEME ID ${newMeme}] : [CREATED ${newSubscriptions.length} AUTO SUBSCRIPTIONS]`
    );
  }
}

async function buildFinalSubscription(newMeme: number): Promise<string> {
  const now = Time.now();
  const dateStr = now.toIsoDateString();
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );

  logger.info(
    `[DATE ${dateStr}] : [BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${newMemeSubscriptions.length} SUBSCRIPTIONS]`
  );

  const { finalSubscriptions, newSubscriptionLogs } =
    await createFinalSubscriptions(newMeme, dateStr);

  const upload: NFTFinalSubscriptionUpload = await uploadFinalSubscriptions(
    MEMES_CONTRACT,
    newMeme,
    finalSubscriptions
  );

  await persistNFTFinalSubscriptions(
    MEMES_CONTRACT,
    newMeme,
    upload,
    finalSubscriptions,
    newSubscriptionLogs
  );

  return upload.upload_url;
}

async function createFinalSubscriptions(newMeme: number, dateStr: string) {
  const newMemeSubscriptions = await fetchAllNftSubscriptions(
    MEMES_CONTRACT,
    newMeme
  );

  logger.info(
    `[DATE ${dateStr}] : [BUILDING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${newMemeSubscriptions.length} SUBSCRIPTIONS]`
  );

  const balances = await fetchAllNftSubscriptionBalances();
  const newSubscriptionLogs: SubscriptionLog[] = [];
  const finalSubscriptions: NFTFinalSubscription[] = [];

  const subscriptionPromises = newMemeSubscriptions.map(async (sub) => {
    const balance = balances.find((b) =>
      areEqualAddresses(b.consolidation_key, sub.consolidation_key)
    );

    const consolidationWallets = sub.consolidation_key.split('-');
    let airdropAddress = await fetchAirdropAddressForDelegators(
      consolidationWallets
    );

    if (!airdropAddress) {
      airdropAddress = await fetchPrimaryWallet(consolidationWallets);
    }

    if (balance) {
      if (balance.balance >= MEMES_MINT_PRICE) {
        const finalSub: NFTFinalSubscription = {
          consolidation_key: sub.consolidation_key,
          contract: sub.contract,
          token_id: sub.token_id,
          airdrop_address: airdropAddress ?? consolidationWallets[0]
        };
        finalSubscriptions.push(finalSub);
        newSubscriptionLogs.push({
          consolidation_key: sub.consolidation_key,
          log: `Added to Final Subscription for Meme #${newMeme} on ${dateStr}`
        });
      } else {
        logger.info(
          `[INSUFFICIENT BALANCE FOR ${sub.consolidation_key}] : [SKIPPING]`
        );
        newSubscriptionLogs.push({
          consolidation_key: sub.consolidation_key,
          log: `Insufficient Balance for Meme #${newMeme} on ${dateStr}`
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

  return { finalSubscriptions, newSubscriptionLogs };
}

async function uploadFinalSubscriptions(
  contract: string,
  newMeme: number,
  finalSubscriptions: NFTFinalSubscription[]
): Promise<NFTFinalSubscriptionUpload> {
  logger.info(
    `[UPLOADING FINAL SUBSCRIPTION FOR MEME #${newMeme}] : [FOUND ${finalSubscriptions.length} SUBSCRIPTIONS]`
  );
  const profiles = await fetchAllProfiles();
  const finalUpload: NFTFinalSubscriptionWithDateAndProfile[] =
    finalSubscriptions.map((sub) => {
      const profile = profiles.find((p) =>
        sub.consolidation_key
          .split('-')
          .some((key) => areEqualAddresses(p.primary_wallet, key))
      );
      return {
        date: Time.now().toIsoDateString(),
        contract: contract,
        token_id: newMeme,
        profile: profile?.handle ?? '-',
        consolidation_key: sub.consolidation_key,
        airdrop_address: sub.airdrop_address
      };
    });
  const csv = await converter.json2csvAsync(finalUpload);
  const { url } = await arweaveFileUploader.uploadFile(
    Buffer.from(csv),
    'text/csv'
  );

  return {
    date: Time.now().toIsoDateString(),
    contract: contract,
    token_id: newMeme,
    upload_url: url
  };
}

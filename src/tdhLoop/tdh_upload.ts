import { json2csv } from 'json-2-csv';
import { CLOUDFRONT_LINK } from '@/constants';
import { s3ObjectExists, s3UploadObject } from '@/helpers/s3_helpers';
import { persistConsolidatedTdhUpload, persistTdhUpload } from '../db';
import {
  ConsolidatedOwnerBalances,
  OwnerBalances
} from '../entities/IOwnerBalances';
import { ConsolidatedTDH, TDH } from '../entities/ITDH';
import {
  UploadFieldsConsolidation,
  UploadFieldsWallet
} from '../entities/IUpload';
import { Logger } from '../logging';
import { fetchAllOwnerBalances } from '../ownersBalancesLoop/db.owners_balances';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';
import { uploadTdhCsvToArweave } from '@/tdhLoop/tdh-arweave-upload';

let logger: Logger;

type TDHUpload = (UploadFieldsWallet | UploadFieldsConsolidation)[];

export async function uploadTDH(
  block: number,
  blockTimestamp: Date,
  tdh: TDH[] | ConsolidatedTDH[],
  isConsolidation: boolean,
  useOwnerBalances: boolean
): Promise<string> {
  logger = Logger.get(
    isConsolidation ? 'CONSOLIDATED_TDH_UPLOAD' : 'TDH_UPLOAD'
  );

  const ownerBalances = useOwnerBalances
    ? await fetchAllOwnerBalances()
    : undefined;

  logger.info(
    `[${isConsolidation ? 'CONSOLIDATED' : 'WALLETS'}_TDH] [BLOCK ${block}] [TDH ${tdh.length}] [OWNER BALANCES ${ownerBalances?.length ?? 'Not used'}]`
  );

  const { dateString, tdhUpload } = buildUpload(
    blockTimestamp,
    tdh,
    isConsolidation,
    ownerBalances
  );
  return await persistUpload(tdhUpload, block, dateString, isConsolidation);
}

function buildUpload(
  blockTimestamp: Date,
  tdh: TDH[] | ConsolidatedTDH[],
  isConsolidation: boolean,
  ownerBalances?: OwnerBalances[] | ConsolidatedOwnerBalances[]
): {
  dateString: string;
  tdhUpload: TDHUpload;
} {
  const dateString = Time.fromDate(blockTimestamp)
    .plusDays(1)
    .toIsoDateString()
    .replace(/-/g, '');

  const tdhUpload: TDHUpload = tdh.map((tdh) => {
    let balance: OwnerBalances | ConsolidatedOwnerBalances | undefined;
    const uniqueFields: any = {};
    if (isConsolidation) {
      balance = ownerBalances?.find((om) =>
        equalIgnoreCase(
          (om as ConsolidatedOwnerBalances).consolidation_key,
          (tdh as ConsolidatedTDH).consolidation_key
        )
      );
      uniqueFields.consolidation_key = (
        tdh as ConsolidatedTDH
      ).consolidation_key;
      uniqueFields.consolidation_display = (
        tdh as ConsolidatedTDH
      ).consolidation_display;
      uniqueFields.wallets = (tdh as ConsolidatedTDH).wallets;
    } else {
      balance = ownerBalances?.find((om) =>
        equalIgnoreCase((om as OwnerBalances).wallet, (tdh as TDH).wallet)
      );
      uniqueFields.wallet = (tdh as TDH).wallet;
    }

    const memes = tdh.memes.map((meme) => {
      const rank = tdh.memes_ranks.find((mr) => mr.id == meme.id);
      return { ...meme, rank: rank?.rank ?? -1 };
    });
    const gradients = tdh.gradients.map((gradient) => {
      const rank = tdh.gradients_ranks.find((gr) => gr.id == gradient.id);
      return { ...gradient, rank: rank?.rank ?? -1 };
    });
    const nextgen = tdh.nextgen.map((nextgen) => {
      const rank = tdh.nextgen_ranks.find((nr) => nr.id == nextgen.id);
      return { ...nextgen, rank: rank?.rank ?? -1 };
    });

    let totalBalance = tdh.balance;
    if (balance) {
      totalBalance = balance.total_balance - balance.memelab_balance;
    }

    const entry: UploadFieldsWallet | UploadFieldsConsolidation = {
      ...uniqueFields,
      block: tdh.block,
      date: dateString,
      total_balance: totalBalance,
      boosted_tdh: tdh.boosted_tdh,
      tdh_rank: tdh.tdh_rank,
      tdh: tdh.tdh,
      tdh__raw: tdh.tdh__raw,
      boost: tdh.boost,
      memes_balance: balance?.memes_balance ?? tdh.memes_balance,
      unique_memes: balance?.unique_memes ?? tdh.unique_memes,
      memes_cards_sets: balance?.memes_cards_sets ?? tdh.memes_cards_sets,
      memes_cards_sets_minus1: balance?.memes_cards_sets_minus1 ?? 0,
      memes_cards_sets_minus2: balance?.memes_cards_sets_minus2 ?? 0,
      genesis: balance?.genesis ?? tdh.genesis,
      nakamoto: balance?.nakamoto ?? tdh.nakamoto,
      boosted_memes_tdh: tdh.boosted_memes_tdh,
      memes_tdh: tdh.memes_tdh,
      memes_tdh__raw: tdh.memes_tdh__raw,
      tdh_rank_memes: tdh.tdh_rank_memes,
      memes: JSON.stringify(memes),
      gradients_balance: balance?.gradients_balance ?? tdh.gradients_balance,
      boosted_gradients_tdh: tdh.boosted_gradients_tdh,
      gradients_tdh: tdh.gradients_tdh,
      gradients_tdh__raw: tdh.gradients_tdh__raw,
      tdh_rank_gradients: tdh.tdh_rank_gradients,
      gradients: JSON.stringify(gradients),
      nextgen_balance: balance?.nextgen_balance ?? tdh.nextgen_balance,
      boosted_nextgen_tdh: tdh.boosted_nextgen_tdh,
      nextgen_tdh: tdh.nextgen_tdh,
      nextgen_tdh__raw: tdh.nextgen_tdh__raw,
      nextgen: JSON.stringify(nextgen),
      boost_breakdown: JSON.stringify(tdh.boost_breakdown)
    };
    return entry;
  });

  tdhUpload.sort((a, b) => a.tdh_rank - b.tdh_rank);
  return { dateString, tdhUpload };
}

async function persistUpload(
  tdhUpload: TDHUpload,
  block: number,
  dateString: string,
  isConsolidation: boolean
) {
  logger.info(`[CREATING CSV]`);

  const csv = json2csv(tdhUpload);

  const size = csv.length / (1024 * 1024);
  logger.info(`[CSV CREATED - SIZE ${size.toFixed(2)} MB]`);

  if (!process.env.ARWEAVE_KEY) throw new Error('ARWEAVE_KEY not set');
  const arweaveKey = JSON.parse(process.env.ARWEAVE_KEY);
  const { url, transactionId } = await uploadTdhCsvToArweave(
    csv,
    arweaveKey,
    logger
  );
  const cloudfrontUrl = `${CLOUDFRONT_LINK}/arweave/${transactionId}`;

  if (isConsolidation) {
    await persistConsolidatedTdhUpload(block, dateString, url);
  } else {
    await persistTdhUpload(block, dateString, url);
  }

  await persistCsvToS3(csv, transactionId);

  logger.info(`[ARWEAVE LINK ${url}]`);
  logger.info(`[ARWEAVE S3 MIRROR ${cloudfrontUrl}]`);
  return url;
}

async function persistCsvToS3(csv: string, txId: string): Promise<void> {
  const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME;
  if (!myBucket) {
    logger.warn(
      `[ARWEAVE S3 MIRROR SKIPPED] Missing AWS_6529_IMAGES_BUCKET_NAME env var`
    );
    return;
  }

  const key = `arweave/${txId}`;
  const csvBuffer = Buffer.from(csv);

  try {
    const existing = await s3ObjectExists(myBucket, key, txId);
    if (existing.exists) {
      logger.info(`[ARWEAVE S3 MIRROR EXISTS] [KEY ${key}]`);
      return;
    }

    const uploaded = await s3UploadObject({
      bucket: myBucket,
      key,
      body: csvBuffer,
      contentType: 'text/csv',
      txId
    });

    logger.info(
      `[ARWEAVE S3 MIRROR STORED] [KEY ${key}] [ETAG ${uploaded.ETag}]`
    );
  } catch (error) {
    const errorDetails =
      error instanceof Error ? `${error.name}: ${error.message}` : `${error}`;
    logger.error(
      `[ARWEAVE S3 MIRROR FAILED] [TX ${txId}] [ERROR ${errorDetails}]`,
      error
    );
  }
}

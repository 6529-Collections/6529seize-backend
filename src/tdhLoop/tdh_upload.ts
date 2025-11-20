import converter from 'json-2-csv';
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

let logger: Logger;

const Arweave = require('arweave');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

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

  const csv = await converter.json2csvAsync(tdhUpload);

  const size = csv.length / (1024 * 1024);
  logger.info(`[CSV CREATED - SIZE ${size.toFixed(2)} MB]`);

  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  const transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  logger.info(`[SIGNING ARWEAVE TRANSACTION]`);

  await myarweave.transactions.sign(transaction, arweaveKey);

  const uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    logger.info(
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;

  if (isConsolidation) {
    await persistConsolidatedTdhUpload(
      block,
      dateString,
      `https://arweave.net/${transaction.id}`
    );
  } else {
    await persistTdhUpload(
      block,
      dateString,
      `https://arweave.net/${transaction.id}`
    );
  }

  logger.info(`[ARWEAVE LINK ${url}]`);
  return url;
}

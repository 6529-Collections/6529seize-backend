import { MEMES_CONTRACT } from '@/constants';
import { getDataSource } from '@/db';
import { NFT } from '@/entities/INFT';
import { numbers } from '@/numbers';
import { getRpcProvider } from '@/rpc-provider';
import { ethers } from 'ethers';
import pLimit from 'p-limit';
import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { withRetry } from './retry';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

const MEMES_SUPPLY_ABI = [
  'function totalSupply(uint256 tokenId) view returns (uint256)'
];
const MEME_SUPPLY_CHECK_CONCURRENCY = 10;

type MemeNftSupplyRow = Pick<NFT, 'id' | 'name' | 'supply'>;

type MemeSupplyContract = {
  totalSupply(tokenId: number): Promise<unknown>;
};

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    { logger, entities: [NFT], syncEntities: false }
  );
});

async function replay() {
  const memes = await fetchMemeNfts();
  const contract = getMemesSupplyContract(getRpcProvider());
  const limit = pLimit(MEME_SUPPLY_CHECK_CONCURRENCY);

  await Promise.all(
    memes.map((meme) =>
      limit(async () => {
        await printMemeSupplyMismatch(meme, contract);
      })
    )
  );
}

async function fetchMemeNfts(): Promise<MemeNftSupplyRow[]> {
  return getDataSource()
    .getRepository(NFT)
    .createQueryBuilder('nft')
    .select(['nft.id', 'nft.name', 'nft.supply'])
    .where('nft.contract = :contract', { contract: MEMES_CONTRACT })
    .orderBy('nft.id', 'ASC')
    .getMany();
}

function getMemesSupplyContract(provider: ethers.Provider): MemeSupplyContract {
  return new ethers.Contract(
    MEMES_CONTRACT,
    MEMES_SUPPLY_ABI,
    provider
  ) as unknown as MemeSupplyContract;
}

async function printMemeSupplyMismatch(
  meme: MemeNftSupplyRow,
  contract: MemeSupplyContract
): Promise<void> {
  const onChainSupply = await fetchOnChainMemeSupply(contract, meme.id);
  const dbSupply = numbers.parseIntOrThrow(meme.supply);

  if (onChainSupply !== dbSupply) {
    const nameSuffix = meme.name ? ` [${meme.name}]` : '';
    logger.info(
      `[MISMATCH] Meme #${meme.id}${nameSuffix} [db_supply=${dbSupply}] [onchain_supply=${onChainSupply}]`
    );
  }
}

async function fetchOnChainMemeSupply(
  contract: MemeSupplyContract,
  tokenId: number
): Promise<number> {
  const rawSupply = await withRetry(() => contract.totalSupply(tokenId), {
    attempts: 5,
    minDelayMs: 500
  });
  const supply = numbers.parseIntOrNull(rawSupply);
  if (supply === null) {
    throw new Error(`Invalid on-chain supply for Meme #${tokenId}`);
  }
  return supply;
}

import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  NULL_ADDRESS_DEAD
} from '@/constants';
import { getDataSource } from '@/db';
import { NFT } from '@/entities/INFT';
import { ConsolidatedNFTOwner, NFTOwner } from '@/entities/INFTOwner';
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
  'function totalSupply(uint256 tokenId) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])'
];
const MEME_SUPPLY_CHECK_CONCURRENCY = 10;
const MEME_OWNER_BALANCE_CHECK_CHUNK_SIZE = 500;

type MemeNftSupplyRow = Pick<NFT, 'id' | 'contract' | 'name' | 'supply'>;

type OwnerSupplyRow = {
  tokenId: unknown;
  supply: unknown;
};

type MismatchReport = {
  meme: MemeNftSupplyRow;
  onChainSupply: number;
  nftsSupply: SupplyComparisonGroup;
  nftOwnersSupply: SupplyComparisonGroup;
  consolidatedNftOwnersSupply: SupplyComparisonGroup;
};

type SupplyComparisonGroup = {
  burnt: number;
  withBurnt: SupplyComparison;
  withoutBurnt: SupplyComparison;
};

type SupplyComparison = {
  actual: number;
  expected: number;
};

type OwnerBalanceMismatch = {
  owner: string;
  dbBalance: number;
  onChainBalance: number;
};

type MemeSupplyContract = {
  totalSupply(tokenId: number): Promise<unknown>;
  balanceOfBatch(owners: string[], tokenIds: number[]): Promise<unknown[]>;
};

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      logger,
      entities: [NFT, NFTOwner, ConsolidatedNFTOwner],
      syncEntities: false
    }
  );
});

async function replay() {
  const [
    memes,
    nftOwnerSupplies,
    consolidatedNftOwnerSupplies,
    nftOwnerBurntSupplies,
    consolidatedNftOwnerBurntSupplies
  ] =
    await Promise.all([
      fetchMemeNfts(),
      fetchNftOwnerSupplies(),
      fetchConsolidatedNftOwnerSupplies(),
      fetchNftOwnerBurntSupplies(),
      fetchConsolidatedNftOwnerBurntSupplies()
    ]);
  const contract = getMemesSupplyContract(getRpcProvider());
  const limit = pLimit(MEME_SUPPLY_CHECK_CONCURRENCY);

  await Promise.all(
    memes.map((meme) =>
      limit(async () => {
        await printMemeSupplyMismatch(
          meme,
          contract,
          nftOwnerSupplies,
          consolidatedNftOwnerSupplies,
          nftOwnerBurntSupplies,
          consolidatedNftOwnerBurntSupplies
        );
      })
    )
  );
}

async function fetchMemeNfts(): Promise<MemeNftSupplyRow[]> {
  return getDataSource()
    .getRepository(NFT)
    .createQueryBuilder('nft')
    .select(['nft.id', 'nft.contract', 'nft.name', 'nft.supply'])
    .where('nft.contract = :contract', { contract: MEMES_CONTRACT })
    .orderBy('nft.id', 'ASC')
    .getMany();
}

async function fetchNftOwnerSupplies(): Promise<Map<number, number>> {
  return fetchOwnerSupplies(NFTOwner);
}

async function fetchConsolidatedNftOwnerSupplies(): Promise<Map<number, number>> {
  return fetchOwnerSupplies(ConsolidatedNFTOwner);
}

async function fetchNftOwnerBurntSupplies(): Promise<Map<number, number>> {
  return fetchBurntSupplies(NFTOwner, 'wallet');
}

async function fetchConsolidatedNftOwnerBurntSupplies(): Promise<
  Map<number, number>
> {
  return fetchBurntSupplies(ConsolidatedNFTOwner, 'consolidation_key');
}

async function fetchBurntSupplies(
  EntityClass: typeof NFTOwner | typeof ConsolidatedNFTOwner,
  ownerColumn: 'wallet' | 'consolidation_key'
): Promise<Map<number, number>> {
  const rows = await getDataSource()
    .getRepository(EntityClass)
    .createQueryBuilder('owner')
    .select('owner.token_id', 'tokenId')
    .addSelect('SUM(owner.balance)', 'supply')
    .where('owner.contract = :contract', { contract: MEMES_CONTRACT })
    .andWhere(`LOWER(owner.${ownerColumn}) IN (:...burnAddresses)`, {
      burnAddresses: getBurnAddresses()
    })
    .groupBy('owner.token_id')
    .getRawMany<OwnerSupplyRow>();

  return new Map(
    rows.map((row) => [
      numbers.parseIntOrThrow(row.tokenId),
      numbers.parseIntOrThrow(row.supply)
    ])
  );
}

async function fetchOwnerSupplies(
  EntityClass: typeof NFTOwner | typeof ConsolidatedNFTOwner
): Promise<Map<number, number>> {
  const rows = await getDataSource()
    .getRepository(EntityClass)
    .createQueryBuilder('owner')
    .select('owner.token_id', 'tokenId')
    .addSelect('SUM(owner.balance)', 'supply')
    .where('owner.contract = :contract', { contract: MEMES_CONTRACT })
    .groupBy('owner.token_id')
    .getRawMany<OwnerSupplyRow>();

  return new Map(
    rows.map((row) => [
      numbers.parseIntOrThrow(row.tokenId),
      numbers.parseIntOrThrow(row.supply)
    ])
  );
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
  contract: MemeSupplyContract,
  nftOwnerSupplies: Map<number, number>,
  consolidatedNftOwnerSupplies: Map<number, number>,
  nftOwnerBurntSupplies: Map<number, number>,
  consolidatedNftOwnerBurntSupplies: Map<number, number>
): Promise<void> {
  const onChainSupply = await fetchOnChainMemeSupply(contract, meme.id);
  const nftOwnerBurntSupply = nftOwnerBurntSupplies.get(meme.id) ?? 0;
  const nftsBurntSupply = adjustNftsBurntSupply(meme.id, nftOwnerBurntSupply);
  const consolidatedNftOwnerBurntSupply =
    consolidatedNftOwnerBurntSupplies.get(meme.id) ?? 0;
  const dbSupply = numbers.parseIntOrThrow(meme.supply);
  const nftOwnersSupply = nftOwnerSupplies.get(meme.id) ?? 0;
  const consolidatedNftOwnersSupply =
    consolidatedNftOwnerSupplies.get(meme.id) ?? 0;
  const report: MismatchReport = {
    meme,
    onChainSupply,
    nftsSupply: buildComparisonGroup({
      withBurntActual: dbSupply,
      burnt: nftsBurntSupply,
      onChainSupply
    }),
    nftOwnersSupply: buildComparisonGroup({
      withBurntActual: nftOwnersSupply,
      burnt: nftOwnerBurntSupply,
      onChainSupply
    }),
    consolidatedNftOwnersSupply: buildComparisonGroup({
      withBurntActual: consolidatedNftOwnersSupply,
      burnt: consolidatedNftOwnerBurntSupply,
      onChainSupply
    })
  };

  if (hasMismatch(report)) {
    logger.info(formatMismatchReport(report));
    await printOwnerBalanceMismatches(meme, contract);
  }
}

async function printOwnerBalanceMismatches(
  meme: MemeNftSupplyRow,
  contract: MemeSupplyContract
): Promise<void> {
  const nftOwnerMismatches = await findNftOwnerBalanceMismatches(
    meme,
    contract
  );

  if (nftOwnerMismatches.length > 0) {
    logger.info(
      formatOwnerBalanceMismatchReport({
        meme,
        label: 'nft_owners wallet balance mismatches',
        mismatches: nftOwnerMismatches
      })
    );
  }
}

async function findNftOwnerBalanceMismatches(
  meme: MemeNftSupplyRow,
  contract: MemeSupplyContract
): Promise<OwnerBalanceMismatch[]> {
  const owners = await getDataSource().getRepository(NFTOwner).find({
    where: {
      contract: MEMES_CONTRACT,
      token_id: meme.id
    }
  });
  const activeOwners = owners.filter((owner) => !isBurnAddress(owner.wallet));
  const onChainBalances = await fetchOnChainMemeBalances(
    contract,
    activeOwners.map((owner) => owner.wallet),
    meme.id
  );

  return activeOwners
    .map((owner, index) =>
      buildOwnerBalanceMismatch({
        owner: owner.wallet,
        dbBalance: owner.balance,
        onChainBalance: onChainBalances[index]
      })
    )
    .filter(
      (mismatch): mismatch is OwnerBalanceMismatch => mismatch !== null
    );
}

function buildOwnerBalanceMismatch({
  owner,
  dbBalance,
  onChainBalance
}: {
  owner: string;
  dbBalance: number;
  onChainBalance: number;
}): OwnerBalanceMismatch | null {
  if (dbBalance === onChainBalance) {
    return null;
  }
  return {
    owner,
    dbBalance,
    onChainBalance
  };
}

function getBurnAddresses(): string[] {
  return [NULL_ADDRESS, NULL_ADDRESS_DEAD].map((address) =>
    address.toLowerCase()
  );
}

function isBurnAddress(address: string): boolean {
  return getBurnAddresses().includes(address.toLowerCase());
}

function adjustNftsBurntSupply(tokenId: number, supply: number): number {
  if (tokenId === 8) {
    return supply + MEME_8_EDITION_BURN_ADJUSTMENT;
  }
  return supply;
}

function buildComparisonGroup({
  withBurntActual,
  burnt,
  onChainSupply
}: {
  withBurntActual: number;
  burnt: number;
  onChainSupply: number;
}): SupplyComparisonGroup {
  return {
    burnt,
    withBurnt: {
      actual: withBurntActual,
      expected: onChainSupply
    },
    withoutBurnt: {
      actual: withBurntActual - burnt,
      expected: onChainSupply
    }
  };
}

function hasMismatch(report: MismatchReport): boolean {
  return [
    report.nftsSupply,
    report.nftOwnersSupply,
    report.consolidatedNftOwnersSupply
  ].some((group) => !matchesOnChain(group));
}

function matchesOnChain(group: SupplyComparisonGroup): boolean {
  return !isMismatch(group.withBurnt) || !isMismatch(group.withoutBurnt);
}

function isMismatch(comparison: SupplyComparison): boolean {
  return comparison.actual !== comparison.expected;
}

function formatMismatchReport(report: MismatchReport): string {
  const name = report.meme.name ? ` - ${report.meme.name}` : '';
  return [
    `[MISMATCH] Meme #${report.meme.id}${name}`,
    `  onchain_supply: ${report.onChainSupply}`,
    formatSupplyGroup('nfts.supply', report.nftsSupply),
    formatSupplyGroup('nft_owners balance sum', report.nftOwnersSupply),
    formatSupplyGroup(
      'nft_owners_consolidation balance sum',
      report.consolidatedNftOwnersSupply
    )
  ].join('\n');
}

function formatOwnerBalanceMismatchReport({
  meme,
  label,
  mismatches
}: {
  meme: MemeNftSupplyRow;
  label: string;
  mismatches: OwnerBalanceMismatch[];
}): string {
  const name = meme.name ? ` - ${meme.name}` : '';
  return [
    `[OWNER MISMATCH] Meme #${meme.id}${name}`,
    `  ${label}:`,
    ...mismatches.map(
      (mismatch) =>
        `    ${mismatch.owner}: db=${mismatch.dbBalance} onchain=${
          mismatch.onChainBalance
        } delta=${mismatch.dbBalance - mismatch.onChainBalance}`
    )
  ].join('\n');
}

function formatSupplyGroup(
  label: string,
  group: SupplyComparisonGroup
): string {
  return [
    `  ${label}:`,
    `    including_burnt: ${formatSupplyComparison(group.withBurnt)} (burnt ${group.burnt})`,
    `    excluding_burnt: ${formatSupplyComparison(group.withoutBurnt)}`
  ].join('\n');
}

function formatSupplyComparison(comparison: SupplyComparison): string {
  const { actual, expected } = comparison;
  if (actual === expected) {
    return `${actual} OK matches_onchain`;
  }
  return `${actual} differs_from_onchain expected=${expected} delta=${
    actual - expected
  }`;
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

async function fetchOnChainMemeBalances(
  contract: MemeSupplyContract,
  owners: string[],
  tokenId: number
): Promise<number[]> {
  const balances: number[] = [];
  for (
    let start = 0;
    start < owners.length;
    start += MEME_OWNER_BALANCE_CHECK_CHUNK_SIZE
  ) {
    const ownerChunk = owners.slice(
      start,
      start + MEME_OWNER_BALANCE_CHECK_CHUNK_SIZE
    );
    const tokenIdChunk = ownerChunk.map(() => tokenId);
    const rawBalances = await withRetry(
      () => contract.balanceOfBatch(ownerChunk, tokenIdChunk),
      {
        attempts: 5,
        minDelayMs: 500
      }
    );
    balances.push(
      ...rawBalances.map((rawBalance) => {
        const balance = numbers.parseIntOrNull(rawBalance);
        if (balance === null) {
          throw new Error(`Invalid on-chain balance for Meme #${tokenId}`);
        }
        return balance;
      })
    );
  }
  return balances;
}

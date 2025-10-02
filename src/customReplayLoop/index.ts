import fetch from 'node-fetch';
import { MEMES_CONTRACT } from '../constants';
import { fetchMaxTransactionsBlockNumber, getDataSource } from '../db';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { Logger } from '../logging';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { insertWithoutUpdate } from '../orm_helpers';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { Time } from '../time';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

const MAX_RETRIES = 3;

type OwnersForNftOwner =
  | string
  | {
      ownerAddress?: string;
      address?: string;
      tokenBalances?: TokenBalance[];
      balance?: string;
      tokenCount?: string;
      [key: string]: unknown;
    };

interface TokenBalance {
  tokenId?: string;
  balance?: string;
}

interface OwnersForNftApiResponse {
  owners?: OwnersForNftOwner[];
  ownerAddresses?: OwnersForNftOwner[];
  pageKey?: string;
}

interface OwnedTokenBalance {
  wallet: string;
  balance: number;
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    { logger, entities: [NFTOwner, ConsolidatedNFTOwner] }
  );
});

async function replay() {
  const tokenIds = [43, 60, 116, 320, 401, 405];
  for (const tokenId of tokenIds) {
    await replayForToken(tokenId);
  }
}

async function replayForToken(tokenId: number) {
  const contract = MEMES_CONTRACT.toLowerCase();

  logger.info(`[REPLAY #${tokenId}] Starting refresh`);

  const owners = await fetchOwnersForToken(contract, tokenId);
  const totalBalance = owners.reduce((acc, owner) => acc + owner.balance, 0);
  logger.info(
    `[REPLAY #${tokenId}] Retrieved ${owners.length} owner balances, total balance: ${totalBalance}`
  );

  const blockReference = await fetchMaxTransactionsBlockNumber();
  logger.info(`[REPLAY #${tokenId}] Using block reference ${blockReference}`);

  const addresses = new Set<string>();
  owners.forEach((owner) => addresses.add(owner.wallet.toLowerCase()));

  const existingOwners = await getDataSource()
    .getRepository(NFTOwner)
    .createQueryBuilder('nftowner')
    .where('nftowner.contract = :contract', { contract })
    .andWhere('nftowner.token_id = :tokenId', { tokenId })
    .getMany();

  existingOwners.forEach((owner) => addresses.add(owner.wallet.toLowerCase()));

  await persistTokenOwners(contract, tokenId, owners, blockReference);

  logger.info(
    `[REPLAY #${tokenId}] Persisted owners. Consolidating for ${addresses.size} wallets`
  );
  await consolidateNftOwners(addresses);
  logger.info(`[REPLAY #${tokenId}] Completed refresh`);
}

async function fetchOwnersForToken(
  contract: string,
  tokenId: number
): Promise<OwnedTokenBalance[]> {
  const ownersMap = new Map<string, number>();
  let pageKey: string | undefined;

  do {
    const response = await fetchOwnersForTokenPage(contract, tokenId, pageKey);
    response.owners.forEach((owner) => {
      const address = extractOwnerAddress(owner);
      if (!address) {
        return;
      }

      const balance = extractBalance(owner, tokenId);
      if (balance <= 0) {
        return;
      }

      const normalizedAddress = address.toLowerCase();
      ownersMap.set(
        normalizedAddress,
        (ownersMap.get(normalizedAddress) ?? 0) + balance
      );
    });
    pageKey = response.pageKey;
  } while (pageKey);

  return Array.from(ownersMap.entries()).map(([wallet, balance]) => ({
    wallet,
    balance
  }));
}

async function fetchOwnersForTokenPage(
  contract: string,
  tokenId: number,
  pageKey?: string
): Promise<{ owners: OwnersForNftOwner[]; pageKey?: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const baseUrl = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getOwnersForContract`;
    const params = new URLSearchParams({
      contractAddress: contract,
      withTokenBalances: 'true'
    });
    if (pageKey) {
      params.append('pageKey', pageKey);
    }

    const url = `${baseUrl}?${params.toString()}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as OwnersForNftApiResponse;
      const owners = (data.owners ?? data.ownerAddresses ?? []).filter(
        (owner) => {
          if (!owner || typeof owner === 'string') {
            return false;
          }

          const tokenBalances = Array.isArray(owner.tokenBalances)
            ? owner.tokenBalances
            : [];

          return tokenBalances.some((tokenBalance) =>
            matchesToken(tokenBalance?.tokenId, tokenId)
          );
        }
      );
      return {
        owners,
        pageKey: data.pageKey
      };
    } catch (error: any) {
      const delay = Time.seconds(attempt * 10).toMillis();
      const message = `Failed to load owners for ${contract}/${tokenId} (attempt ${attempt}) - ${
        error?.message ?? error
      }`;
      if (attempt === MAX_RETRIES) {
        logger.error(message);
        throw error;
      }
      logger.error(`${message}. Retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable');
}

function extractOwnerAddress(owner: OwnersForNftOwner): string | undefined {
  if (!owner) {
    return undefined;
  }
  if (typeof owner === 'string') {
    return owner;
  }
  return (
    (typeof owner.ownerAddress === 'string' && owner.ownerAddress) ||
    (typeof owner.address === 'string' && owner.address) ||
    undefined
  );
}

function extractBalance(owner: OwnersForNftOwner, tokenId: number): number {
  if (!owner) {
    return 0;
  }

  const tokenBalances =
    typeof owner === 'string'
      ? undefined
      : owner.tokenBalances && Array.isArray(owner.tokenBalances)
        ? owner.tokenBalances
        : undefined;

  if (!tokenBalances || tokenBalances.length === 0) {
    return typeof owner === 'string'
      ? 1
      : parseOptionalNumber(owner.balance, 1);
  }

  let total = 0;
  tokenBalances.forEach((balance) => {
    if (!balance) {
      return;
    }
    const matches = matchesToken(balance.tokenId, tokenId);
    if (!matches) {
      return;
    }
    total += parseOptionalNumber(balance.balance, 0);
  });

  return total;
}

function matchesToken(
  tokenIdValue: string | undefined,
  tokenId: number
): boolean {
  if (!tokenIdValue) {
    return false;
  }

  const normalized = tokenIdValue.startsWith('0x')
    ? parseInt(tokenIdValue, 16)
    : parseInt(tokenIdValue, 10);

  return normalized === tokenId;
}

function parseOptionalNumber(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }
  const normalized = value.startsWith('0x')
    ? parseInt(value, 16)
    : parseInt(value, 10);
  return Number.isNaN(normalized) ? fallback : normalized;
}

async function persistTokenOwners(
  contract: string,
  tokenId: number,
  owners: OwnedTokenBalance[],
  blockReference: number
) {
  await getDataSource().transaction(async (manager) => {
    const repo = manager.getRepository(NFTOwner);
    await repo
      .createQueryBuilder()
      .delete()
      .from(NFTOwner)
      .where('contract = :contract AND token_id = :tokenId', {
        contract,
        tokenId
      })
      .execute();

    if (owners.length === 0) {
      logger.info('[REPLAY] No owners returned; deletion complete.');
      return;
    }

    const rows: NFTOwner[] = owners.map((owner) => ({
      wallet: owner.wallet,
      contract,
      token_id: tokenId,
      balance: owner.balance,
      block_reference: blockReference
    }));

    await insertWithoutUpdate(repo, rows);
    logger.info(
      `[REPLAY] Inserted ${rows.length} owner rows for ${contract} token ${tokenId}`
    );
  });
}

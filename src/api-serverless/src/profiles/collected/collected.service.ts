import {
  CardSeizedStatus,
  CollectedCard,
  CollectedQuery,
  CollectionType
} from './collected.types';
import { emptyPage, Page, PageSortDirection } from '../../page-request';
import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  NULL_ADDRESS,
  WALLET_REGEX
} from '@/constants';
import {
  collectedDb,
  CollectedDb,
  MemesAndGradientsOwnershipData,
  NftData,
  NftsCollectionOwnershipData
} from './collected.db';
import { assertUnreachable } from '../../../../assertions';
import {
  identityFetcher,
  IdentityFetcher
} from '../../identities/identity.fetcher';
import { equalIgnoreCase } from '../../../../strings';
import { numbers } from '../../../../numbers';
import { collections } from '../../../../collections';

export class CollectedService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly collectedDb: CollectedDb
  ) {}

  private async getWalletsToSearchBy(query: CollectedQuery): Promise<string[]> {
    if (
      query.collection &&
      ![CollectionType.MEMES, CollectionType.NEXTGEN].includes(
        query.collection
      ) &&
      query.szn
    ) {
      return [];
    }
    const identity = query.identity;
    const identityResponse =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        {
          identityKey: identity
        },
        {}
      );
    if (!identityResponse) {
      return [];
    } else if (query.account_for_consolidations) {
      return identityResponse.wallets!.map((w) => w.wallet.toLowerCase());
    } else if (WALLET_REGEX.exec(identity)) {
      return [identity.toLowerCase()];
    } else if (identity.endsWith('.eth')) {
      const walletAddress = identityResponse
        .wallets!.find(
          (w) => w.display.toLowerCase() === identity.toLowerCase()
        )
        ?.wallet?.toLowerCase();
      return walletAddress ? [walletAddress.toLowerCase()] : [];
    } else {
      const primaryWallet = identityResponse.primary_wallet;
      return primaryWallet ? [primaryWallet] : [];
    }
  }

  public async getCollectedCards(
    query: CollectedQuery
  ): Promise<Page<CollectedCard>> {
    const walletsToSearchBy = await this.getWalletsToSearchBy(query);
    if (walletsToSearchBy.length === 0) {
      return emptyPage();
    }
    const {
      nfts,
      memesAndGradientsStats,
      nextgenStats,
      memeLabOwnerBalancesByTokenIds
    } = await this.getDataFromDb(walletsToSearchBy);
    const cards = await this.mergeNftsWithOwnersipData(
      nfts,
      memesAndGradientsStats,
      memeLabOwnerBalancesByTokenIds,
      nextgenStats,
      walletsToSearchBy
    ).then((cards) => this.filterCards(query, cards));
    const pageOfCards = this.getPageData(cards, query);
    const count = cards.length;
    const next = count > query.page_size * query.page;
    return {
      count,
      page: query.page,
      next,
      data: pageOfCards
    };
  }

  private getPageData(
    cards: CollectedCard[],
    query: CollectedQuery
  ): CollectedCard[] {
    const pageSize = query.page_size;
    const pageNo = query.page;
    return [...cards]
      .sort((a, b) => {
        const val1 = a[query.sort] ?? 0;
        const val2 = b[query.sort] ?? 0;
        switch (query.sort_direction) {
          case PageSortDirection.DESC: {
            return val2 - val1;
          }
          case PageSortDirection.ASC: {
            return val1 - val2;
          }
          default: {
            return assertUnreachable(query.sort_direction);
          }
        }
      })
      .slice(pageSize * (pageNo - 1), pageSize * (pageNo - 1) + pageSize);
  }

  private filterCards(
    query: CollectedQuery,
    cards: CollectedCard[]
  ): CollectedCard[] {
    if (query.collection) {
      cards = cards.filter((card) => card.collection === query.collection);
    }
    if (query.szn) {
      cards = cards.filter((card) => card.szn === query.szn);
    }
    if (query.seized === CardSeizedStatus.SEIZED) {
      cards = cards.filter(
        (card) => card.seized_count !== null && card.seized_count > 0
      );
    } else if (query.seized === CardSeizedStatus.NOT_SEIZED) {
      cards = cards.filter((card) => !card.seized_count);
    }
    return cards;
  }

  private async mergeNftsWithOwnersipData(
    nfts: NftData[],
    memesAndGradientsStats: MemesAndGradientsOwnershipData,
    memeLabOwnerBalancesByTokenIds: Record<number, number>,
    nextgenStats: NftsCollectionOwnershipData,
    walletsToSearchBy: string[]
  ): Promise<CollectedCard[]> {
    return nfts.map<CollectedCard>((nft) => {
      let tdh = null;
      let rank = null;
      let seized = null;
      switch (nft.collection) {
        case CollectionType.MEMELAB: {
          seized = memeLabOwnerBalancesByTokenIds[nft.token_id] ?? null;
          break;
        }
        case CollectionType.MEMES: {
          tdh =
            memesAndGradientsStats.memes.tdhsAndBalances[nft.token_id]?.tdh ??
            null;
          rank = memesAndGradientsStats.memes.ranks[nft.token_id] ?? null;
          seized =
            memesAndGradientsStats.memes.tdhsAndBalances[nft.token_id]
              ?.balance ?? null;
          if (
            nft.token_id === 8 &&
            walletsToSearchBy.some((w) => equalIgnoreCase(w, NULL_ADDRESS))
          ) {
            seized += MEME_8_EDITION_BURN_ADJUSTMENT;
          }
          break;
        }
        case CollectionType.GRADIENTS: {
          tdh =
            memesAndGradientsStats.gradients.tdhsAndBalances[nft.token_id]
              ?.tdh ?? null;
          rank = memesAndGradientsStats.gradients.ranks[nft.token_id] ?? null;
          seized =
            memesAndGradientsStats.gradients.tdhsAndBalances[nft.token_id]
              ?.balance ?? null;
          break;
        }
        case CollectionType.NEXTGEN: {
          tdh = nextgenStats.tdhsAndBalances[nft.token_id]?.tdh ?? null;
          rank = nextgenStats.ranks[nft.token_id] ?? null;
          seized = nextgenStats.tdhsAndBalances[nft.token_id]?.balance ?? null;
          break;
        }
        default: {
          assertUnreachable(nft.collection);
        }
      }
      return {
        collection: nft.collection,
        token_id: nft.token_id,
        token_name: nft.name,
        img: nft.thumbnail,
        szn: nft.season,
        tdh: tdh,
        rank: rank,
        seized_count: seized
      };
    });
  }

  private async getDataFromDb(walletsToSearchBy: string[]): Promise<{
    nfts: NftData[];
    memesAndGradientsStats: MemesAndGradientsOwnershipData;
    nextgenStats: NftsCollectionOwnershipData;
    memeLabOwnerBalancesByTokenIds: Record<number, number>;
  }> {
    const data = await Promise.all([
      this.collectedDb.getAllNfts(),
      this.getMemesAndGradientsOwnershipData(walletsToSearchBy),
      this.getNextgenOwnershipData(walletsToSearchBy),
      this.collectedDb.getWalletsMemeLabsBalancesByTokens(walletsToSearchBy)
    ]);
    const nfts = data[0];
    const memesAndGradients = data[1];
    const nextgenStats = data[2];
    const memeLabsBalances = data[3];
    await this.adjustBalancesWithLiveData(
      walletsToSearchBy,
      memesAndGradients,
      nextgenStats
    );
    return {
      nfts: nfts,
      memesAndGradientsStats: memesAndGradients,
      nextgenStats: nextgenStats,
      memeLabOwnerBalancesByTokenIds: memeLabsBalances
    };
  }

  private async adjustBalancesWithLiveData(
    walletsToSearchBy: string[],
    memesAndGradients: MemesAndGradientsOwnershipData,
    nextgenStats: NftsCollectionOwnershipData
  ) {
    const nextgenLiveBalances =
      await this.collectedDb.getNextgenLiveBalances(walletsToSearchBy);
    const { gradients: gradientsLiveBalances, memes: memesLiveBalances } =
      await this.collectedDb.getGradientsAndMemesLiveBalancesByTokenIds(
        walletsToSearchBy
      );
    collections
      .distinct([
        ...Object.keys(memesAndGradients.memes.tdhsAndBalances),
        ...Object.keys(memesLiveBalances)
      ])
      .forEach((id) => {
        const tokenId = numbers.parseIntOrNull(id);
        if (tokenId !== null) {
          const liveBalance = memesLiveBalances[tokenId] ?? 0;
          if (liveBalance === 0) {
            delete memesAndGradients.memes.tdhsAndBalances[tokenId];
          } else {
            memesAndGradients.memes.tdhsAndBalances[tokenId] = {
              balance: liveBalance,
              tdh: memesAndGradients.memes.tdhsAndBalances[tokenId]?.tdh ?? 0
            };
          }
        }
      });
    collections
      .distinct([
        ...Object.keys(memesAndGradients.gradients.tdhsAndBalances),
        ...Object.keys(gradientsLiveBalances)
      ])
      .forEach((id) => {
        const tokenId = numbers.parseIntOrNull(id);
        if (tokenId !== null) {
          const liveBalance = gradientsLiveBalances[tokenId] ?? 0;
          if (liveBalance === 0) {
            delete memesAndGradients.gradients.tdhsAndBalances[tokenId];
          } else {
            memesAndGradients.gradients.tdhsAndBalances[tokenId] = {
              balance: liveBalance,
              tdh:
                memesAndGradients.gradients.tdhsAndBalances[tokenId]?.tdh ?? 0
            };
          }
        }
      });
    collections
      .distinct([
        ...Object.keys(nextgenStats.tdhsAndBalances),
        ...Object.keys(nextgenLiveBalances)
      ])
      .forEach((id) => {
        const tokenId = numbers.parseIntOrNull(id);
        if (tokenId !== null) {
          const liveBalance = nextgenLiveBalances[tokenId] ?? 0;
          if (liveBalance === 0) {
            delete nextgenStats.tdhsAndBalances[tokenId];
          } else {
            nextgenStats.tdhsAndBalances[tokenId] = {
              balance: liveBalance,
              tdh: nextgenStats.tdhsAndBalances[tokenId]?.tdh ?? 0
            };
          }
        }
      });
  }

  private getMemesAndGradientsOwnershipData(
    walletsToSearchBy: string[]
  ): Promise<MemesAndGradientsOwnershipData> {
    return walletsToSearchBy.length > 1
      ? this.collectedDb.getWalletConsolidatedMemesAndGradientsMetrics(
          walletsToSearchBy[0]
        )
      : this.collectedDb.getWalletMemesAndGradientsMetrics(
          walletsToSearchBy[0]
        );
  }

  private async getNextgenOwnershipData(
    walletsToSearchBy: string[]
  ): Promise<NftsCollectionOwnershipData> {
    return walletsToSearchBy.length > 1
      ? this.collectedDb.getConsolidatedNextgenMetrics(walletsToSearchBy)
      : this.collectedDb.getWalletNextgenMetrics(walletsToSearchBy[0]);
  }
}

export const collectedService = new CollectedService(
  identityFetcher,
  collectedDb
);

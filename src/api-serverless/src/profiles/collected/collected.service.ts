import {
  CardSeizedStatus,
  CollectedCard,
  CollectedQuery,
  CollectionType
} from './collected.types';
import { emptyPage, Page, PageSortDirection } from '../../page-request';
import {
  profilesService,
  ProfilesService
} from '../../../../profiles/profiles.service';
import { WALLET_REGEX } from '../../../../constants';
import {
  collectedDb,
  CollectedDb,
  NftData,
  NftsOwnershipData
} from './collected.db';
import { parseNumberOrNull } from '../../api-helpers';
import { assertUnreachable, distinct } from '../../../../helpers';

export class CollectedService {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly collectedDb: CollectedDb
  ) {}

  private async getWalletsToSearchBy(query: CollectedQuery): Promise<string[]> {
    if (
      query.collection &&
      query.collection !== CollectionType.MEMES &&
      query.szn
    ) {
      return [];
    }
    const handleOrEnsOrWalletAddress = query.handle_or_wallet;
    const profileAndConsolidations =
      await this.profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrEnsOrWalletAddress
      );
    const consolidation = profileAndConsolidations?.consolidation;
    if (!consolidation) {
      return [];
    } else if (query.account_for_consolidations) {
      return consolidation.wallets.map((w) => w.wallet.address.toLowerCase());
    } else if (WALLET_REGEX.exec(handleOrEnsOrWalletAddress)) {
      return [handleOrEnsOrWalletAddress.toLowerCase()];
    } else if (handleOrEnsOrWalletAddress.endsWith('.eth')) {
      const walletAddress = consolidation.wallets
        .find((w) => w.wallet.ens === handleOrEnsOrWalletAddress.toLowerCase())
        ?.wallet?.address?.toLowerCase();
      return walletAddress ? [walletAddress.toLowerCase()] : [];
    } else {
      const primaryWallet =
        profileAndConsolidations?.profile?.primary_wallet?.toLowerCase();
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
    const { nfts, memesAndGradientsStats, memeLabOwnerBalancesByTokenIds } =
      await this.getDataFromDb(walletsToSearchBy);
    const cards = await this.mergeNftsWithOwnersipData(
      nfts,
      memesAndGradientsStats,
      memeLabOwnerBalancesByTokenIds
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
        const val1 = parseNumberOrNull(a[query.sort]) ?? 0;
        const val2 = parseNumberOrNull(b[query.sort]) ?? 0;
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
    memesAndGradientsStats: NftsOwnershipData,
    memeLabOwnerBalancesByTokenIds: Record<number, number>
  ): Promise<CollectedCard[]> {
    return nfts.map<CollectedCard>((nft) => {
      let tdh = null;
      let rank = null;
      let seized = null;
      if (nft.collection === CollectionType.MEMELAB) {
        seized = memeLabOwnerBalancesByTokenIds[nft.token_id] ?? null;
      } else if (nft.collection === CollectionType.MEMES) {
        tdh = memesAndGradientsStats.memes[nft.token_id]?.tdh ?? null;
        rank = memesAndGradientsStats.memes_ranks[nft.token_id] ?? null;
        seized = memesAndGradientsStats.memes[nft.token_id]?.balance ?? null;
      } else if (nft.collection === CollectionType.GRADIENTS) {
        tdh = memesAndGradientsStats.gradients[nft.token_id]?.tdh ?? null;
        rank = memesAndGradientsStats.gradients_ranks[nft.token_id] ?? null;
        seized =
          memesAndGradientsStats.gradients[nft.token_id]?.balance ?? null;
      }
      return {
        collection: nft.collection,
        token_id: nft.token_id,
        token_name: nft.name,
        img: nft.thumbnail,
        szn: parseNumberOrNull(nft.season),
        tdh: tdh,
        rank: rank,
        seized_count: seized
      };
    });
  }

  private async getDataFromDb(walletsToSearchBy: string[]): Promise<{
    nfts: NftData[];
    memesAndGradientsStats: NftsOwnershipData;
    memeLabOwnerBalancesByTokenIds: Record<number, number>;
  }> {
    const data = await Promise.all([
      this.collectedDb.getAllNfts(),
      walletsToSearchBy.length > 1
        ? this.collectedDb.getWalletConsolidatedMemesAndGradientsMetrics(
            walletsToSearchBy[0]
          )
        : this.collectedDb.getWalletMemesAndGradientsMetrics(
            walletsToSearchBy[0]
          ),
      this.collectedDb.getWalletsMemeLabsBalancesByTokens(walletsToSearchBy)
    ]);
    const nfts = data[0];
    const memesAndGradients = data[1];
    const memeLabsBalances = data[2];
    await this.adjustBalancesWithLiveData(walletsToSearchBy, memesAndGradients);
    return {
      nfts: nfts,
      memesAndGradientsStats: memesAndGradients,
      memeLabOwnerBalancesByTokenIds: memeLabsBalances
    };
  }

  private async adjustBalancesWithLiveData(
    walletsToSearchBy: string[],
    memesAndGradients: NftsOwnershipData
  ) {
    const { gradients: gradientsLiveBalances, memes: memesLiveBalances } =
      await this.collectedDb.getGradientsAndMemesLiveBalancesByTokenIds(
        walletsToSearchBy
      );
    distinct([
      ...Object.keys(memesAndGradients.memes),
      ...Object.keys(memesLiveBalances)
    ]).forEach((id) => {
      const tokenId = parseNumberOrNull(id);
      if (tokenId !== null) {
        const liveBalance = memesLiveBalances[tokenId] ?? 0;
        if (liveBalance === 0) {
          delete memesAndGradients.memes[tokenId];
        } else {
          memesAndGradients.memes[tokenId] = {
            balance: liveBalance,
            tdh: memesAndGradients.memes[tokenId]?.tdh ?? 0
          };
        }
      }
    });
    distinct([
      ...Object.keys(memesAndGradients.gradients),
      ...Object.keys(gradientsLiveBalances)
    ]).forEach((id) => {
      const tokenId = parseNumberOrNull(id);
      if (tokenId !== null) {
        const liveBalance = gradientsLiveBalances[tokenId] ?? 0;
        if (liveBalance === 0) {
          delete memesAndGradients.gradients[tokenId];
        } else {
          memesAndGradients.gradients[tokenId] = {
            balance: liveBalance,
            tdh: memesAndGradients.gradients[tokenId]?.tdh ?? 0
          };
        }
      }
    });
  }
}

export const collectedService = new CollectedService(
  profilesService,
  collectedDb
);

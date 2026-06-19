import {
  ENS_TABLE,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NFT_OWNERS_TABLE
} from '@/constants';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_TOKENS_TABLE
} from '@/nextgen/nextgen_constants';
import {
  WalletGalleryCollectionKey,
  WalletGalleryOwnershipRow
} from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.types';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';

export class WalletGallerySnapshotDb extends LazyDbAccessCompatibleService {
  constructor(sqlExecutorGetter: () => SqlExecutor) {
    super(sqlExecutorGetter);
  }

  async findHoldingsByWallets(
    wallets: string[],
    ctx: RequestContext
  ): Promise<WalletGalleryOwnershipRow[]> {
    if (!wallets.length) {
      return [];
    }
    const timerName = `${this.constructor.name}->findHoldingsByWallets`;
    try {
      ctx.timer?.start(timerName);
      return await this.db.execute<WalletGalleryOwnershipRow>(
        `
          SELECT *
          FROM (
            ${this.coreNftSelect(
              WalletGalleryCollectionKey.MEMES,
              'memesContract',
              1,
              NFTS_TABLE
            )}
            UNION ALL
            ${this.coreNftSelect(
              WalletGalleryCollectionKey.GRADIENTS,
              'gradientContract',
              2,
              NFTS_TABLE
            )}
            UNION ALL
            ${this.coreNftSelect(
              WalletGalleryCollectionKey.MEMELAB,
              'memeLabContract',
              3,
              NFTS_MEME_LAB_TABLE
            )}
            UNION ALL
            ${this.nextgenSelect(4)}
          ) gallery_holdings
          ORDER BY
            collection_order ASC,
            lower(contract) ASC,
            token_id ASC,
            lower(owner_wallet) ASC
        `,
        {
          wallets,
          memesContract: MEMES_CONTRACT.toLowerCase(),
          gradientContract: GRADIENT_CONTRACT.toLowerCase(),
          memeLabContract: MEMELAB_CONTRACT.toLowerCase(),
          nextgenContract:
            NEXTGEN_CORE_CONTRACT[getNextgenNetwork()].toLowerCase()
        },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private coreNftSelect(
    collectionKey: WalletGalleryCollectionKey,
    contractParam: string,
    collectionOrder: number,
    nftTable: string
  ): string {
    return `
      SELECT
        o.wallet as owner_wallet,
        e.display as owner_display,
        lower(o.contract) as contract,
        o.token_id,
        o.balance,
        o.block_reference,
        n.name,
        n.collection,
        '${collectionKey}' as collection_key,
        n.token_type,
        n.description,
        n.artist,
        n.artist_seize_handle,
        n.thumbnail,
        n.image,
        n.scaled,
        n.animation,
        n.compressed_animation,
        n.icon,
        n.metadata,
        ${collectionOrder} as collection_order
      FROM ${NFT_OWNERS_TABLE} o
      INNER JOIN ${nftTable} n
        ON lower(n.contract) = lower(o.contract)
       AND n.id = o.token_id
      LEFT JOIN ${ENS_TABLE} e ON lower(e.wallet) = lower(o.wallet)
      WHERE lower(o.wallet) IN (:wallets)
        AND lower(o.contract) = :${contractParam}
        AND o.balance > 0
    `;
  }

  private nextgenSelect(collectionOrder: number): string {
    return `
      SELECT
        ng.owner as owner_wallet,
        e.display as owner_display,
        :nextgenContract as contract,
        ng.id as token_id,
        COALESCE(o.balance, 1) as balance,
        COALESCE(o.block_reference, 0) as block_reference,
        ng.name,
        ng.collection_name as collection,
        '${WalletGalleryCollectionKey.NEXTGEN}' as collection_key,
        'ERC721' as token_type,
        NULL as description,
        NULL as artist,
        NULL as artist_seize_handle,
        ng.thumbnail_url as thumbnail,
        ng.image_url as image,
        ng.image_url as scaled,
        ng.animation_url as animation,
        NULL as compressed_animation,
        ng.icon_url as icon,
        ng.generator as metadata,
        ${collectionOrder} as collection_order
      FROM ${NEXTGEN_TOKENS_TABLE} ng
      LEFT JOIN ${NFT_OWNERS_TABLE} o
        ON lower(o.contract) = :nextgenContract
       AND o.token_id = ng.id
       AND lower(o.wallet) = lower(ng.owner)
       AND o.balance > 0
      LEFT JOIN ${ENS_TABLE} e ON lower(e.wallet) = lower(ng.owner)
      WHERE lower(ng.owner) IN (:wallets)
        AND ng.burnt = false
    `;
  }
}

export const walletGallerySnapshotDb = new WalletGallerySnapshotDb(dbSupplier);

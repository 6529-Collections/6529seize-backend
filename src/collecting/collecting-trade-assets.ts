import { MEMELAB_CONTRACT, NFTS_MEME_LAB_TABLE } from '@/constants';
import {
  collectingAssetKey,
  collectingHash
} from '@/collecting/collecting-analysis';
import {
  CollectingAsset,
  CollectingCatalog
} from '@/collecting/collecting.types';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dbSupplier, SqlExecutor } from '@/sql-executor';

const MAX_LAB_ASSETS = 50000;
const MAX_EXPLICIT_ASSETS = 2000;
const LAB_PREFIX = `1:${MEMELAB_CONTRACT.toLowerCase()}:`;
// BaseNFT.id (inherited by LabNFT) is a signed MySQL INT. Larger on-chain IDs
// cannot be present in this index and must never enter a coercing SQL comparison.
const MAX_INDEXED_LAB_TOKEN_ID = BigInt(2147483647);

export function memeLabTradeTokenId(key: string): string | null {
  if (!key.startsWith(LAB_PREFIX)) return null;
  const tokenId = key.slice(LAB_PREFIX.length);
  return /^(0|[1-9][0-9]{0,9})$/.test(tokenId) &&
    BigInt(tokenId) <= MAX_INDEXED_LAB_TOKEN_ID
    ? tokenId
    : null;
}

interface LabTradeRow {
  token_id: string;
  name: string | null;
  image_url: string | null;
}

/** Existing indexed artwork only; this does not add Meme Lab to a TDH universe. */
export class CollectingTradeAssetsDb {
  constructor(private readonly getDb: () => SqlExecutor) {}

  async readMemeLabAssets(
    tokenIds?: readonly string[],
    ctx: RequestContext = {}
  ): Promise<CollectingAsset[]> {
    if (tokenIds?.length === 0) return [];
    if (
      tokenIds &&
      (tokenIds.length > MAX_EXPLICIT_ASSETS ||
        tokenIds.some(
          (id) => memeLabTradeTokenId(`${LAB_PREFIX}${id}`) === null
        ))
    )
      throw new BadRequestException('Invalid explicit artwork selection.');
    const timerName = 'CollectingTradeAssetsDb->readMemeLabAssets';
    ctx.timer?.start(timerName);
    try {
      const rows = await this.getDb().execute<LabTradeRow>(
        `SELECT CAST(id AS CHAR) AS token_id, name,
          COALESCE(NULLIF(thumbnail, ''), NULLIF(image, '')) AS image_url
         FROM ${NFTS_MEME_LAB_TABLE}
         WHERE LOWER(contract) = :contract AND mint_date IS NOT NULL
           ${tokenIds ? 'AND id IN (:tokenIds)' : ''}
         ORDER BY id ASC LIMIT ${MAX_LAB_ASSETS + 1}`,
        {
          contract: MEMELAB_CONTRACT.toLowerCase(),
          ...(tokenIds ? { tokenIds } : {})
        },
        { wrappedConnection: ctx.connection }
      );
      if (rows.length > MAX_LAB_ASSETS)
        throw new CustomApiCompliantException(
          503,
          'Artwork catalog exceeds the supported snapshot size.'
        );
      return rows.map((row) => ({
        asset_key: collectingAssetKey(MEMELAB_CONTRACT, row.token_id),
        chain_id: 1,
        contract: MEMELAB_CONTRACT.toLowerCase(),
        token_id: row.token_id,
        family: 'memelab',
        name: row.name ?? `Meme Lab #${row.token_id}`,
        image_url: row.image_url,
        artist_ids: [],
        season: null,
        traits: [],
        hodl_rate: null,
        tdh_eligible: false
      }));
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const collectingTradeAssetsDb = new CollectingTradeAssetsDb(dbSupplier);

/** Extend one explicit trading/ownership request, never the cached planner catalog. */
export async function catalogForTradeAssets(
  catalog: CollectingCatalog,
  keys: readonly string[],
  db: Pick<
    CollectingTradeAssetsDb,
    'readMemeLabAssets'
  > = collectingTradeAssetsDb
): Promise<CollectingCatalog> {
  if (keys.length > MAX_EXPLICIT_ASSETS)
    throw new BadRequestException('Too many explicit artworks.');
  const ids = Array.from(
    new Set(
      keys.map(memeLabTradeTokenId).filter((id): id is string => id !== null)
    )
  );
  if (!ids.length) return catalog;
  const additional = await db.readMemeLabAssets(ids);
  return {
    ...catalog,
    assets: [...catalog.assets, ...additional],
    version: collectingHash({
      catalog: catalog.version,
      trade_assets: additional
    })
  };
}

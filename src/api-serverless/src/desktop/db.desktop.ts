import { MEMES_CONTRACT, NFTS_TABLE } from '../../../constants';
import { sqlExecutor } from '../../../sql-executor';

export async function fetchRandomVerticalImage(): Promise<
  {
    id?: number;
    artist?: string;
    artist_seize_handle?: string;
    season?: number;
    icon?: string;
    thumbnail?: string;
    scaled?: string;
    image?: string;
  }[]
> {
  const sql = `
    SELECT n.id, n.artist, n.artist_seize_handle,
      CAST(jt.value AS UNSIGNED) AS season,
      n.icon, n.thumbnail, n.scaled, n.image
    FROM ${NFTS_TABLE} n
    LEFT JOIN JSON_TABLE(
      n.metadata,
      '$.attributes[*]' COLUMNS (
        trait_type VARCHAR(255) PATH '$.trait_type',
        value VARCHAR(255) PATH '$.value'
      )
    ) AS jt ON jt.trait_type = 'Type - Season'
    WHERE n.contract = :memes_contract
      AND JSON_EXTRACT(n.metadata, '$.image_details.height') IS NOT NULL
      AND JSON_EXTRACT(n.metadata, '$.image_details.width') IS NOT NULL
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(n.metadata, '$.image_details.height')) AS UNSIGNED) > CAST(JSON_UNQUOTE(JSON_EXTRACT(n.metadata, '$.image_details.width')) AS UNSIGNED)
    ORDER BY RAND()
    LIMIT 1
  `;
  return await sqlExecutor.execute(sql, {
    memes_contract: MEMES_CONTRACT
  });
}

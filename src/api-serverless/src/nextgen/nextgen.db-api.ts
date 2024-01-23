import { NextGenCollectionStatus } from '../api-filters';
import { constructFilters } from '../api-helpers';
import { ENS_TABLE } from '../../../constants';
import { getProof } from '../../../merkle_proof';
import { sqlExecutor } from '../../../sql-executor';
import { Time } from '../../../time';
import { fetchPaginated, returnEmpty } from '../../../db-api';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_LOGS_TABLE,
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE,
  NEXTGEN_TRANSACTIONS_TABLE
} from '../../../nextgen/nextgen_constants';

export async function fetchNextGenAllowlistCollection(merkleRoot: string) {
  const sql = `SELECT * FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} LEFT JOIN ${NEXTGEN_BURN_COLLECTIONS_TABLE} ON ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.collection_id=${NEXTGEN_BURN_COLLECTIONS_TABLE}.collection_id WHERE ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.merkle_root=:merkle_root`;
  const collection = (
    await sqlExecutor.execute(sql, {
      merkle_root: merkleRoot
    })
  )[0];
  return collection;
}

export async function fetchNextGenAllowlist(
  merkleRoot: string,
  address: string
) {
  const sql1 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} WHERE merkle_root=:merkle_root`;
  const collection = (
    await sqlExecutor.execute(sql1, {
      merkle_root: merkleRoot
    })
  )[0];

  const sql2 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_TABLE} WHERE merkle_root=:merkle_root AND address=:address ORDER BY spots ASC`;

  const allowlists = await sqlExecutor.execute(sql2, {
    merkle_root: merkleRoot,
    address: address
  });

  if (collection && allowlists.length > 0) {
    const response = [];
    for (const allowlist of allowlists) {
      const proof = getProof(collection.merkle_tree, allowlist.keccak);
      response.push({
        keccak: allowlist.keccak,
        spots: allowlist.spots,
        info: allowlist.info,
        proof: proof
      });
    }
    return response;
  }
  return [];
}

export async function fetchNextGenBurnAllowlist(
  merkleRoot: string,
  tokenId: number
) {
  const collection = await fetchNextGenAllowlistCollection(merkleRoot);

  const sql2 = `SELECT * FROM ${NEXTGEN_ALLOWLIST_BURN_TABLE} WHERE merkle_root=:merkle_root AND token_id=:token_id`;
  const allowlist = (
    await sqlExecutor.execute(sql2, {
      merkle_root: merkleRoot,
      token_id: tokenId
    })
  )[0];

  if (collection && allowlist) {
    const proof = getProof(collection.merkle_tree, allowlist.keccak);
    return {
      keccak: allowlist.keccak,
      info: allowlist.info,
      proof: proof
    };
  }
  return {
    keccak: null,
    data: null,
    proof: []
  };
}

export async function fetchNextGenCollections(
  pageSize: number,
  page: number,
  status: NextGenCollectionStatus | null
) {
  let filters = '';
  let sort = 'id desc';
  if (status) {
    const now = Time.now().toSeconds();
    sort = 'allowlist_start asc, public_start asc, id desc';
    switch (status) {
      case NextGenCollectionStatus.LIVE:
        filters = constructFilters(
          filters,
          `(allowlist_start <= ${now} AND allowlist_end >= ${now}) OR (public_start <= ${now} AND public_end >= ${now})`
        );
        sort = 'allowlist_start asc, public_start asc, id desc';
        break;
      case NextGenCollectionStatus.UPCOMING:
        filters = constructFilters(
          filters,
          `allowlist_start > ${now} OR public_start > ${now}`
        );
        break;
      case NextGenCollectionStatus.COMPLETED:
        filters = constructFilters(
          filters,
          `allowlist_end < ${now} AND public_end < ${now}`
        );
        break;
    }
  }
  return fetchPaginated(
    NEXTGEN_COLLECTIONS_TABLE,
    {},
    sort,
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenCollectionById(id: number) {
  const sql = `SELECT * FROM ${NEXTGEN_COLLECTIONS_TABLE} WHERE id=:id`;
  const results = await sqlExecutor.execute(sql, {
    id: id
  });
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

export async function fetchNextGenCollectionTokens(
  collectionId: number,
  pageSize: number,
  page: number,
  traits: string[]
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_TOKENS_TABLE}.collection_id=:collectionId`
  );
  let params: any = {
    collectionId: collectionId
  };
  if (traits.length > 0) {
    const groupedTraits: {
      [key: string]: string[];
    } = {};
    traits.forEach((trait) => {
      const [key, value] = trait.split(':');
      if (!groupedTraits[key]) {
        groupedTraits[key] = [];
      }
      groupedTraits[key].push(value);
    });
    Object.entries(groupedTraits).forEach(([key, values], index) => {
      const orConditions = values
        .map((value, valueIndex) => {
          const conditionIndex = `${index}_${valueIndex}`;
          params[`trait${conditionIndex}`] = key;
          params[`value${conditionIndex}`] = value;
          return `(${NEXTGEN_TOKEN_TRAITS_TABLE}.trait = :trait${conditionIndex} AND ${NEXTGEN_TOKEN_TRAITS_TABLE}.value = :value${conditionIndex})`;
        })
        .join(' OR ');

      filters = constructFilters(
        filters,
        `EXISTS (
            SELECT 1
            FROM ${NEXTGEN_TOKEN_TRAITS_TABLE}
            WHERE ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id = ${NEXTGEN_TOKENS_TABLE}.id
            AND (${orConditions})
          )`
      );
    });

    Object.entries(groupedTraits).forEach(([key, values], index) => {
      const orConditions = values
        .map((value, valueIndex) => {
          const conditionIndex = `${index}_${valueIndex}`;
          params[`trait${conditionIndex}`] = key;
          params[`value${conditionIndex}`] = value;
          return `(${NEXTGEN_TOKEN_TRAITS_TABLE}.trait = :trait${conditionIndex} AND ${NEXTGEN_TOKEN_TRAITS_TABLE}.value = :value${conditionIndex})`;
        })
        .join(' OR ');

      filters = constructFilters(
        filters,
        `EXISTS (
            SELECT 1
            FROM ${NEXTGEN_TOKEN_TRAITS_TABLE}
            WHERE ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id = ${NEXTGEN_TOKENS_TABLE}.id
            AND (${orConditions})
          )`
      );
    });
  }

  return fetchPaginated(
    NEXTGEN_TOKENS_TABLE,
    params,
    'id asc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenToken(tokendId: number) {
  const sql = `SELECT * FROM ${NEXTGEN_TOKENS_TABLE} WHERE id=:id`;
  const results = await sqlExecutor.execute(sql, {
    id: tokendId
  });
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

export async function fetchNextGenCollectionLogs(
  collectionId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_LOGS_TABLE}.collection_id = :collectionId OR ${NEXTGEN_LOGS_TABLE}.collection_id = 0`
  );
  return fetchPaginated(
    NEXTGEN_LOGS_TABLE,
    {
      collectionId: collectionId
    },
    'block desc, log desc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenTokenTransactions(
  tokenId: number,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_TRANSACTIONS_TABLE}.token_id = :tokenId`
  );

  const fields = `${NEXTGEN_TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${NEXTGEN_TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${NEXTGEN_TRANSACTIONS_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    NEXTGEN_TRANSACTIONS_TABLE,
    {
      tokenId: tokenId
    },
    'block desc, transaction_date desc, token_id desc',
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchNextGenCollectionTraits(collectionId: number) {
  return sqlExecutor.execute(
    `SELECT DISTINCT trait, value
    FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} where collection_id=:collectionId
    ORDER BY 
      trait, 
      CASE 
        WHEN value REGEXP '^[0-9]+$' THEN CAST(value AS UNSIGNED)
        ELSE 9999999 -- A high number to ensure non-numeric values are sorted after numeric values
      END,
      value`,
    {
      collectionId
    }
  );
}

export async function fetchNextGenTokenTraits(tokenId: number) {
  return sqlExecutor.execute(
    `SELECT * FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} WHERE token_id=:tokenId ORDER BY trait ASC`,
    {
      tokenId: tokenId
    }
  );
}

export async function fetchFeaturedCollection() {
  const sql = `SELECT * 
    FROM ${NEXTGEN_COLLECTIONS_TABLE} 
    ORDER BY 
        CASE 
            WHEN now() BETWEEN FROM_UNIXTIME(allowlist_start) AND FROM_UNIXTIME(allowlist_end) 
                OR now() BETWEEN FROM_UNIXTIME(public_start) AND FROM_UNIXTIME(public_end) 
            THEN 0 
            ELSE 1 
        END, 
        CASE 
            WHEN now() < FROM_UNIXTIME(allowlist_start) 
            THEN TIMESTAMPDIFF(SECOND, now(), FROM_UNIXTIME(allowlist_start)) 
            WHEN now() < FROM_UNIXTIME(public_start) 
            THEN TIMESTAMPDIFF(SECOND, now(), FROM_UNIXTIME(public_start)) 
            ELSE 999999999 
        END, 
        RAND() 
    LIMIT 1;
    `;
  const results = await sqlExecutor.execute(sql);
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

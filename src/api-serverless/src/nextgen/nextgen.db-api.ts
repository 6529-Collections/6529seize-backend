import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  ENS_TABLE,
  IDENTITIES_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { fetchPaginated, resolveEns, returnEmpty } from '../../../db-api';
import {
  MINT_TYPE_TRAIT,
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE,
  NEXTGEN_COLLECTIONS_TABLE,
  NEXTGEN_LOGS_TABLE,
  NEXTGEN_TOKEN_LISTINGS_TABLE,
  NEXTGEN_TOKEN_SCORES_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE,
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKENS_TDH_TABLE
} from '../../../nextgen/nextgen_constants';
import { calculateLevel } from '../../../profiles/profile-level';
import { sqlExecutor } from '../../../sql-executor';
import { Time } from '../../../time';
import { NextGenCollectionStatus } from '../api-filters';
import { constructFilters, constructFiltersOR } from '../api-helpers';
import { PageSortDirection } from '../page-request';
import { getNextGenChainId, NEXTGEN_CORE } from './abis';
import { getProof } from './merkle-proof';

export enum TokensSort {
  ID = 'id',
  RARITY_SCORE = 'rarity_score',
  STATISTICAL_SCORE = 'statistical_score',
  SINGLE_TRAIT_RARITY = 'single_trait_rarity',
  RANDOM = 'random',
  LISTED_PRICE = 'listed_price',
  LAST_SALE = 'last_sale',
  HIGHEST_SALE = 'highest_sale'
}

export enum ListedType {
  ALL = 'All',
  LISTED = 'Listed',
  NOT_LISTED = 'Not Listed'
}

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
        merkle_root: allowlist.merkle_root,
        keccak: allowlist.keccak,
        spots: allowlist.spots,
        info: allowlist.info,
        proof: proof,
        address: allowlist.address
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

export async function fetchNextGenCollectionByName(name: string) {
  const sql = `SELECT * FROM ${NEXTGEN_COLLECTIONS_TABLE} WHERE LOWER(name)=:name`;
  const results = await sqlExecutor.execute(sql, {
    name: name.toLocaleLowerCase()
  });
  if (results.length === 1) {
    return results[0];
  }
  return returnEmpty();
}

function getNextGenCollectionTokensSortQuery(
  sort: TokensSort,
  sortDirection: PageSortDirection,
  showNormalised: boolean,
  showTraitCount: boolean
) {
  let sortQuery: string;
  if (sort === TokensSort.RANDOM) {
    sortQuery = `pending, RAND()`;
  } else {
    if (sort === TokensSort.LISTED_PRICE) {
      return `${NEXTGEN_TOKEN_LISTINGS_TABLE}.price ${sortDirection}, ${NEXTGEN_TOKENS_TABLE}.id asc`;
    }
    if (sort === TokensSort.LAST_SALE) {
      return `last_sale.transaction_date ${sortDirection}, last_sale.value ${sortDirection}, ${NEXTGEN_TOKENS_TABLE}.id asc`;
    }
    if (sort === TokensSort.HIGHEST_SALE) {
      return `max_sale.value ${sortDirection}, max_sale.transaction_date ${sortDirection}, ${NEXTGEN_TOKENS_TABLE}.id asc`;
    }
    let sortColumn = '';
    switch (sort) {
      case TokensSort.ID:
        sortColumn = 'id';
        break;
      case TokensSort.RARITY_SCORE:
        if (showNormalised && showTraitCount) {
          sortColumn = 'rarity_score_trait_count_normalised_rank';
        } else if (showNormalised) {
          sortColumn = 'rarity_score_normalised_rank';
        } else if (showTraitCount) {
          sortColumn = 'rarity_score_trait_count_rank';
        } else {
          sortColumn = 'rarity_score_rank';
        }
        break;
      case TokensSort.STATISTICAL_SCORE:
        if (showNormalised && showTraitCount) {
          sortColumn = 'statistical_score_trait_count_normalised_rank';
        } else if (showNormalised) {
          sortColumn = 'statistical_score_normalised_rank';
        } else if (showTraitCount) {
          sortColumn = 'statistical_score_trait_count_rank';
        } else {
          sortColumn = 'statistical_score_rank';
        }
        break;
      case TokensSort.SINGLE_TRAIT_RARITY:
        if (showNormalised && showTraitCount) {
          sortColumn = 'single_trait_rarity_score_trait_count_normalised_rank';
        } else if (showNormalised) {
          sortColumn = 'single_trait_rarity_score_normalised_rank';
        } else if (showTraitCount) {
          sortColumn = 'single_trait_rarity_score_trait_count_rank';
        } else {
          sortColumn = 'single_trait_rarity_score_rank';
        }
        break;
    }
    if (sortColumn.endsWith('rank')) {
      sortDirection =
        sortDirection === PageSortDirection.ASC
          ? PageSortDirection.DESC
          : PageSortDirection.ASC;
    }
    sortQuery = `${NEXTGEN_TOKEN_SCORES_TABLE}.${sortColumn} ${sortDirection}, ${NEXTGEN_TOKEN_SCORES_TABLE}.id asc`;
  }
  return sortQuery;
}

function getNextGenCollectionTokensFilters(
  collectionId: number,
  traits: string[]
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_TOKENS_TABLE}.collection_id=:collectionId`
  );
  const params: any = {
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
  }
  return {
    filters,
    params
  };
}

export async function fetchNextGenCollectionTokens(
  collectionId: number,
  pageSize: number,
  page: number,
  traits: string[],
  sort: TokensSort,
  sortDirection: PageSortDirection,
  showNormalised: boolean,
  showTraitCount: boolean,
  listedType: ListedType
) {
  const filters = getNextGenCollectionTokensFilters(collectionId, traits);
  let joins = `LEFT JOIN ${NEXTGEN_TOKEN_SCORES_TABLE} ON ${NEXTGEN_TOKENS_TABLE}.id = ${NEXTGEN_TOKEN_SCORES_TABLE}.id`;
  joins += ` LEFT JOIN ${NEXTGEN_TOKEN_LISTINGS_TABLE} ON ${NEXTGEN_TOKENS_TABLE}.id = ${NEXTGEN_TOKEN_LISTINGS_TABLE}.id `;
  joins += ` LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} on ${ADDRESS_CONSOLIDATION_KEY}.address = ${NEXTGEN_TOKENS_TABLE}.owner`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} on ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;
  joins += ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;

  if (sort === TokensSort.LAST_SALE) {
    joins += ` LEFT JOIN (
              SELECT token_id, MAX(transaction_date) AS transaction_date, value
              FROM ${TRANSACTIONS_TABLE}
              WHERE value > 0 and contract = :nextgenContract and from_address != :nullAddress
              GROUP BY token_id, value) 
            AS last_sale ON ${NEXTGEN_TOKENS_TABLE}.id = last_sale.token_id`;
    filters.params.nextgenContract = NEXTGEN_CORE[getNextGenChainId()];
    filters.params.nullAddress = NULL_ADDRESS;
  }

  if (sort === TokensSort.HIGHEST_SALE) {
    joins += ` LEFT JOIN (
              SELECT t1.token_id, t1.value, t1.transaction_date
              FROM ${TRANSACTIONS_TABLE} t1
              INNER JOIN (
                  SELECT token_id, MAX(value) AS max_value
                  FROM ${TRANSACTIONS_TABLE}
                  where contract = :nextgenContract and from_address != :nullAddress
                  GROUP BY token_id
              ) t2 ON t1.token_id = t2.token_id AND t1.value = t2.max_value
            ) AS max_sale ON ${NEXTGEN_TOKENS_TABLE}.id = max_sale.token_id`;
    filters.params.nextgenContract = NEXTGEN_CORE[getNextGenChainId()];
    filters.params.nullAddress = NULL_ADDRESS;
  }

  if (listedType === ListedType.LISTED) {
    filters.filters = constructFilters(
      filters.filters,
      `${NEXTGEN_TOKEN_LISTINGS_TABLE}.price > 0`
    );
  } else if (listedType === ListedType.NOT_LISTED) {
    filters.filters = constructFilters(
      filters.filters,
      `${NEXTGEN_TOKEN_LISTINGS_TABLE}.price IS NULL OR ${NEXTGEN_TOKEN_LISTINGS_TABLE}.price = 0`
    );
  }

  const sortQuery: string = getNextGenCollectionTokensSortQuery(
    sort,
    sortDirection,
    showNormalised,
    showTraitCount
  );

  let fields = `
      ${NEXTGEN_TOKENS_TABLE}.*, 
      ${NEXTGEN_TOKEN_SCORES_TABLE}.*, 
      ${NEXTGEN_TOKEN_LISTINGS_TABLE}.*,
      ${IDENTITIES_TABLE}.normalised_handle,
      ${IDENTITIES_TABLE}.handle,
      0 as level,
      ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as tdh,
      ${IDENTITIES_TABLE}.xtdh as xtdh,
      ${IDENTITIES_TABLE}.rep as rep_score`;

  if (sort === TokensSort.LAST_SALE) {
    fields += `,
      last_sale.value AS last_sale_value, 
      last_sale.transaction_date AS last_sale_date`;
  }
  if (sort === TokensSort.HIGHEST_SALE) {
    fields += `,
      max_sale.value AS max_sale_value,
      max_sale.transaction_date AS max_sale_date`;
  }

  const results = await fetchPaginated(
    NEXTGEN_TOKENS_TABLE,
    filters.params,
    sortQuery,
    pageSize,
    page,
    filters.filters,
    fields,
    joins
  );

  results.data.forEach((token: any) => {
    token.generator = JSON.parse(token.generator);
    token.mint_data = JSON.parse(token.mint_data);
    token.level = calculateLevel({
      tdh: (token.tdh ?? 0) + (token.xtdh ?? 0),
      rep: token.rep_score
    });
  });

  return results;
}

export async function fetchNextGenToken(tokenId: number) {
  const sql = `
    SELECT 
      t.*,
      s.*,
      l.*
    FROM ${NEXTGEN_TOKENS_TABLE} t
    LEFT JOIN ${NEXTGEN_TOKEN_SCORES_TABLE} s ON t.id = s.id 
    LEFT JOIN ${NEXTGEN_TOKEN_LISTINGS_TABLE} l ON t.id = l.id 
    WHERE t.id = :id
  `;
  const results = await sqlExecutor.execute(sql, {
    id: tokenId
  });
  if (results.length === 1) {
    const r = results[0];
    r.generator = JSON.parse(r.generator);
    r.mint_data = JSON.parse(r.mint_data);
    return r;
  }
  return returnEmpty();
}

export async function fetchNextGenCollectionLogs(
  collectionId: number,
  pageSize: number,
  page: number
) {
  const filters = constructFilters(
    '',
    `${NEXTGEN_LOGS_TABLE}.collection_id = :collectionId OR ${NEXTGEN_LOGS_TABLE}.collection_id = 0`
  );

  const fields = `
    ${NEXTGEN_LOGS_TABLE}.*, 
    ${TRANSACTIONS_TABLE}.from_address, 
    ${TRANSACTIONS_TABLE}.to_address, 
    ens1.display as from_display, 
    ens2.display as to_display,
    ${TRANSACTIONS_TABLE}.value,
    ${TRANSACTIONS_TABLE}.royalties,
    ${TRANSACTIONS_TABLE}.gas_gwei,
    ${TRANSACTIONS_TABLE}.gas_price,
    ${TRANSACTIONS_TABLE}.gas,
    ${TRANSACTIONS_TABLE}.gas_price_gwei`;

  const joins = `
    LEFT JOIN ${TRANSACTIONS_TABLE}
      ON ${TRANSACTIONS_TABLE}.transaction = ${NEXTGEN_LOGS_TABLE}.transaction
      AND ${TRANSACTIONS_TABLE}.token_id   = ${NEXTGEN_LOGS_TABLE}.token_id
    LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_TABLE}.from_address = ens1.wallet
    LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_TABLE}.to_address   = ens2.wallet
  `;

  return fetchPaginated(
    NEXTGEN_LOGS_TABLE,
    {
      collectionId: collectionId
    },
    `${NEXTGEN_LOGS_TABLE}.block desc, log desc`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}

export async function fetchNextGenCollectionOnlyLogs(
  collectionId: number,
  pageSize: number,
  page: number
) {
  const filters = constructFilters(
    '',
    `(${NEXTGEN_LOGS_TABLE}.collection_id = :collectionId OR ${NEXTGEN_LOGS_TABLE}.collection_id = 0) AND token_id is NULL`
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
    `${TRANSACTIONS_TABLE}.contract = :nextgenContract`
  );
  filters = constructFilters(
    filters,
    `${TRANSACTIONS_TABLE}.token_id = :tokenId`
  );

  const fields = `${TRANSACTIONS_TABLE}.*,ens1.display as from_display, ens2.display as to_display`;
  const joins = `LEFT JOIN ${ENS_TABLE} ens1 ON ${TRANSACTIONS_TABLE}.from_address=ens1.wallet LEFT JOIN ${ENS_TABLE} ens2 ON ${TRANSACTIONS_TABLE}.to_address=ens2.wallet`;

  return fetchPaginated(
    TRANSACTIONS_TABLE,
    {
      nextgenContract: NEXTGEN_CORE[getNextGenChainId()],
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
    `SELECT DISTINCT trait, value, COUNT(*) as count
    FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} where collection_id=:collectionId
    GROUP BY trait, value
    ORDER BY 
      trait, 
      CASE 
        WHEN value REGEXP '^[0-9]+$' THEN CAST(value AS UNSIGNED)
        ELSE 9999999
      END,
      value`,
    {
      collectionId,
      mintTypeTrait: MINT_TYPE_TRAIT
    }
  );
}

export async function fetchNextGenTokenTraits(tokenId: number) {
  return sqlExecutor.execute(
    `SELECT * FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} 
      WHERE token_id=:tokenId 
      ORDER BY 
        CASE 
          WHEN trait LIKE CONCAT(:mintTypeTrait, '%') THEN 0
          ELSE 1
        END,
        trait ASC`,
    {
      tokenId: tokenId,
      mintTypeTrait: MINT_TYPE_TRAIT
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

export async function fetchAllAllowlistPhases(pageSize: number, page: number) {
  const joins = `LEFT JOIN ${NEXTGEN_COLLECTIONS_TABLE} ON ${NEXTGEN_COLLECTIONS_TABLE}.id=${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.collection_id`;
  const fields = `
    ${NEXTGEN_COLLECTIONS_TABLE}.name as collection_name,
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.collection_id, 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.phase,
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.merkle_root,
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.start_time, 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.end_time, 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.al_type, 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.mint_price, 
    ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.added_by
  `;
  return fetchPaginated(
    NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
    {},
    'collection_id asc, phase asc',
    pageSize,
    page,
    '',
    fields,
    joins
  );
}

export async function fetchAllowlistPhasesForCollection(collectionId: number) {
  const sql = `SELECT 
    created_at, merkle_root, collection_id, added_by, al_type, phase, start_time, end_time
  FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} 
  WHERE collection_id=:collectionId`;

  const results = await sqlExecutor.execute(sql, {
    collectionId: collectionId
  });
  return results;
}

export async function fetchNextGenAllowlistByPhase(
  id: number,
  addressesStr: string,
  merkleRoot: string | undefined,
  pageSize: number,
  page: number
) {
  let filters = constructFilters(
    '',
    `${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.collection_id=:id`
  );
  const params: any = {
    id: id
  };
  if (merkleRoot) {
    filters = constructFilters(
      filters,
      `${NEXTGEN_ALLOWLIST_TABLE}.merkle_root=:merkleRoot`
    );
    params.merkleRoot = merkleRoot;
  }

  if (addressesStr) {
    filters = constructFilters(
      filters,
      `${NEXTGEN_ALLOWLIST_TABLE}.address in (:addresses) OR ${ENS_TABLE}.display in (:addresses)`
    );
    params.addresses = addressesStr.toLowerCase().split(',');
  }

  const joins = `LEFT JOIN ${NEXTGEN_ALLOWLIST_TABLE} ON 
    ${NEXTGEN_ALLOWLIST_TABLE}.merkle_root=${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.merkle_root 
  LEFT JOIN ${ENS_TABLE} ens ON ${NEXTGEN_ALLOWLIST_TABLE}.address=ens.wallet`;

  return fetchPaginated(
    NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
    params,
    'phase asc, address asc, spots asc',
    pageSize,
    page,
    filters,
    `${NEXTGEN_ALLOWLIST_TABLE}.*, ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE}.phase, ${ENS_TABLE}.display as wallet_display`,
    joins
  );
}

export async function fetchNextGenProofs(
  addressesStr: string,
  pageSize: number,
  page: number
) {
  let filters = '';
  const params: any = {};
  if (addressesStr) {
    filters = constructFilters(filters, `address in (:addresses)`);
    params.addresses = addressesStr.toLowerCase().split(',');
  }

  return fetchPaginated(
    NEXTGEN_ALLOWLIST_TABLE,
    params,
    'collection_id asc, address asc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenTokenTDH(
  consolidationKeysStr: string,
  tokenIdsStr: string,
  pageSize: number,
  page: number
) {
  let filters = '';
  const params: any = {};
  if (consolidationKeysStr) {
    filters = constructFilters(
      filters,
      `consolidation_key in (:consolidationKeys)`
    );
    params.consolidationKeys = consolidationKeysStr.toLowerCase().split(',');
  }
  if (tokenIdsStr) {
    filters = constructFilters(filters, `id in (:tokenIds)`);
    params.tokenIds = tokenIdsStr.toLowerCase().split(',');
  }

  return fetchPaginated(
    NEXTGEN_TOKENS_TDH_TABLE,
    params,
    'id asc',
    pageSize,
    page,
    filters
  );
}

export async function fetchNextGenCollectionTraitSets(
  collectionId: number,
  trait: string,
  pageSize: number,
  page: number,
  searchStr: string
) {
  const tokenTraits = await sqlExecutor.execute(
    `SELECT token_id, value FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} 
      WHERE trait=:trait`,
    {
      trait: trait
    }
  );

  const fields = `
    ${NEXTGEN_TOKENS_TABLE}.owner, 
    ${IDENTITIES_TABLE}.normalised_handle,
    ${IDENTITIES_TABLE}.handle,
    ${IDENTITIES_TABLE}.xtdh,
    0 as level,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${IDENTITIES_TABLE}.rep as rep_score,
    COUNT(DISTINCT ${NEXTGEN_TOKEN_TRAITS_TABLE}.value) AS distinct_values_count,
    GROUP_CONCAT(DISTINCT ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id ORDER BY ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id) AS token_ids,
    GROUP_CONCAT(DISTINCT ${NEXTGEN_TOKEN_TRAITS_TABLE}.value ORDER BY ${NEXTGEN_TOKEN_TRAITS_TABLE}.value) AS distinct_values`;

  let filters = constructFilters(
    '',
    `${NEXTGEN_TOKENS_TABLE}.collection_id = :collectionId AND LOWER(${NEXTGEN_TOKEN_TRAITS_TABLE}.trait) = :trait`
  );
  const groups = `
    ${NEXTGEN_TOKENS_TABLE}.owner, 
    ${IDENTITIES_TABLE}.normalised_handle, 
    ${IDENTITIES_TABLE}.handle, 
    ${IDENTITIES_TABLE}.xtdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display, 
    ${IDENTITIES_TABLE}.rep`;

  let joins = `JOIN ${NEXTGEN_TOKEN_TRAITS_TABLE} ON ${NEXTGEN_TOKENS_TABLE}.id = ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id`;
  joins += ` LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} on ${ADDRESS_CONSOLIDATION_KEY}.address = ${NEXTGEN_TOKENS_TABLE}.owner`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} on ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;
  joins += ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;

  const props: any = {
    collectionId: collectionId,
    trait: trait.toLowerCase()
  };

  if (searchStr) {
    const resolvedAddresses = await resolveEns(searchStr);
    let walletFilters = constructFiltersOR(
      '',
      `${NEXTGEN_TOKENS_TABLE}.owner in (:addresses)`
    );
    props.addresses = resolvedAddresses.map((a: any) => a.toLowerCase());

    searchStr
      .toLowerCase()
      .split(',')
      .forEach((s: string, index: number) => {
        props[`search${index}`] = `%${s}%`;
        walletFilters = constructFiltersOR(
          walletFilters,
          `${IDENTITIES_TABLE}.normalised_handle like :search${index} or ${IDENTITIES_TABLE}.handle like :search${index}`
        );
      });

    filters = constructFilters(filters, `(${walletFilters})`);
  }

  const results = await fetchPaginated(
    NEXTGEN_TOKENS_TABLE,
    props,
    'distinct_values_count DESC, owner ASC',
    pageSize,
    page,
    filters,
    fields,
    joins,
    groups
  );

  results.data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: (d.tdh ?? 0) + (d.xtdh ?? 0),
      rep: d.rep_score
    });

    const distinctValues = d.distinct_values.split(',');
    const tokenIds = d.token_ids.split(',').map(Number);
    const tokenValues: {
      value: string;
      tokens: number[];
    }[] = distinctValues.map((value: string) => {
      const traitTokens = tokenTraits
        .filter((t: any) => t.value === value && tokenIds.includes(t.token_id))
        .map((t: any) => t.token_id);
      return {
        value: value,
        tokens: traitTokens
      };
    });

    delete d.distinct_values;
    delete d.token_ids;
    d.token_values = tokenValues;
  });

  return results;
}

export async function fetchNextGenCollectionTraitSetsUltimate(
  collectionId: number,
  traitsStr: string,
  pageSize: number,
  page: number
) {
  const traits = traitsStr.split(',');

  const countsPerTrait = await sqlExecutor.execute(
    `SELECT DISTINCT trait, trait_count FROM ${NEXTGEN_TOKEN_TRAITS_TABLE} 
      WHERE trait in (:traits)`,
    {
      traits: traits
    }
  );

  let fields = `
    ${NEXTGEN_TOKENS_TABLE}.owner,
    ${IDENTITIES_TABLE}.normalised_handle,
    ${IDENTITIES_TABLE}.handle,
    0 as level,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${IDENTITIES_TABLE}.rep as rep_score
    ${IDENTITIES_TABLE}.xtdh as xtdh`;

  const params: any = {
    traits: traits,
    collectionId: collectionId
  };
  let filters = constructFilters(
    '',
    `${NEXTGEN_TOKEN_TRAITS_TABLE}.trait in (:traits)`
  );
  filters = constructFilters(
    filters,
    `${NEXTGEN_TOKENS_TABLE}.collection_id = :collectionId`
  );
  let havingQuery = ``;
  countsPerTrait.forEach((ct: any, index: number) => {
    const field = `${ct.trait.toLowerCase()}_sets`;
    const paramName = `trait_${index}`;
    fields += `, COUNT(DISTINCT CASE WHEN ${NEXTGEN_TOKEN_TRAITS_TABLE}.trait = :${paramName} THEN ${NEXTGEN_TOKEN_TRAITS_TABLE}.value ELSE NULL END) AS ${field}`;
    params[paramName] = ct.trait;
    params[field] = ct.trait_count;
    havingQuery += ` ${index > 0 ? 'AND' : ''} ${field} = :${field}`;
  });

  let joins = `JOIN ${NEXTGEN_TOKEN_TRAITS_TABLE} ON ${NEXTGEN_TOKENS_TABLE}.id = ${NEXTGEN_TOKEN_TRAITS_TABLE}.token_id`;
  joins += ` LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} on ${ADDRESS_CONSOLIDATION_KEY}.address = ${NEXTGEN_TOKENS_TABLE}.owner`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} on ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;
  joins += ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${ADDRESS_CONSOLIDATION_KEY}.consolidation_key`;

  const groups = `
    ${NEXTGEN_TOKENS_TABLE}.owner, 
    ${IDENTITIES_TABLE}.normalised_handle, 
    ${IDENTITIES_TABLE}.handle, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display, 
    ${IDENTITIES_TABLE}.rep
    ${IDENTITIES_TABLE}.xtdh`;

  const limit = `LIMIT ${pageSize}`;
  const offset = page > 1 ? `OFFSET ${pageSize * (page - 1)}` : '';
  const sqlQuery = `SELECT ${fields} FROM ${NEXTGEN_TOKENS_TABLE} ${joins} ${filters} GROUP BY ${groups} HAVING ${havingQuery}`;
  const countSql = `SELECT COUNT(1) as count FROM (${sqlQuery}) inner_q`;

  const [count, data] = await Promise.all([
    sqlExecutor.execute(countSql, params).then((r) => r[0].count),
    sqlExecutor.execute(`${sqlQuery} ${limit} ${offset}`, params)
  ]);

  data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: (d.tdh ?? 0) + (d.xtdh ?? 0),
      rep: d.rep_score
    });
  });

  return {
    count,
    page,
    next: count > pageSize * page,
    data
  };
}

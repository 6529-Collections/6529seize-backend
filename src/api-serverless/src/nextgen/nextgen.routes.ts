import {
  NextGenAllowlistType,
  validateNextgen,
  validateNextgenBurn
} from './validation';
import { sqlExecutor } from '../../../sql-executor';
import {
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenAllowlistCollection,
  NextGenCollectionBurn,
  extractNextGenAllowlistBurnInsert,
  extractNextGenAllowlistInsert,
  extractNextGenCollectionBurnInsert,
  extractNextGenCollectionInsert
} from '../../../entities/INextGen';
import * as db from './nextgen.db-api';
import { asyncRouter } from '../async.router';
import { initMulterSingleMiddleware } from '../multer-middleware';
import { Logger } from '../../../logging';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  corsOptions,
  DEFAULT_PAGE_SIZE,
  DISTRIBUTION_PAGE_SIZE
} from '../api-constants';
import { returnPaginatedResult, returnJsonResult } from '../api-helpers';
import { NextGenCollectionStatus } from '../api-filters';
import {
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_ALLOWLIST_BURN_TABLE
} from '../../../nextgen/nextgen_constants';
import { PageSortDirection } from '../page-request';

const logger = Logger.get('NEXTGEN_API');

const router = asyncRouter();

interface TokenValueCount {
  key: string;
  count: number;
}
interface TokenTraitWithCount {
  trait: string;
  values: string[];
  value_counts: TokenValueCount[];
}

router.post(
  '/create_allowlist',
  initMulterSingleMiddleware('allowlist'),
  validateNextgen,
  async (req: any, res: any) => {
    const body = req.validatedBody;
    logger.info({
      valid: body.valid,
      added_by: body.added_by
    });
    const valid = body.valid;
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(
      ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
      corsOptions.allowedHeaders
    );
    if (valid) {
      await persistAllowlist(body);
      res
        .status(200)
        .send(JSON.stringify({ merkle_root: body.merkle.merkle_root }));
      res.end();
    } else {
      res.status(400).send(JSON.stringify(body));
      res.end();
    }
  }
);

router.post(
  '/register_burn_collection',
  validateNextgenBurn,
  async (req: any, res: any) => {
    const body = req.validatedBody;
    const valid = body.valid;

    logger.info(`[VALID ${valid}]`);

    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(
      ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
      corsOptions.allowedHeaders
    );
    if (valid) {
      await persistCollectionBurn(body);
      res.status(200).send(JSON.stringify({ body }));
      res.end();
    } else {
      res.status(400).send(JSON.stringify(body));
      res.end();
    }
  }
);

router.get(
  `/merkle_roots/:merkle_root`,
  async function (req: any, res: any, next: any) {
    const merkleRoot = req.params.merkle_root;

    db.fetchNextGenAllowlistCollection(merkleRoot).then((result) => {
      if (result) {
        result.merkle_tree = JSON.parse(result.merkle_tree);
      } else {
        result = null;
      }
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(
        ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
        corsOptions.allowedHeaders
      );
      res.end(JSON.stringify(result));
    });
  }
);

router.get(
  `/:collection_id/allowlist_merkle/:merkle_root?`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.collection_id);
    if (!isNaN(id)) {
      const addresses = req.query.address;
      const merkleRoot = req.params.merkle_root;

      const pageSize: number =
        req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DISTRIBUTION_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      db.fetchNextGenAllowlistByPhase(
        id,
        addresses,
        merkleRoot,
        pageSize,
        page
      ).then((result) => {
        res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
        res.setHeader(
          ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
          corsOptions.allowedHeaders
        );
        res.end(JSON.stringify(result));
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(`/proofs`, async function (req: any, res: any, next: any) {
  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;
  const addresses = req.query.address;

  db.fetchNextGenProofs(addresses, pageSize, page).then((result) => {
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(
      ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
      corsOptions.allowedHeaders
    );
    res.end(JSON.stringify(result));
  });
});

router.get(
  `/proofs/:merkle_root/:address`,
  async function (req: any, res: any, next: any) {
    const merkleRoot = req.params.merkle_root;
    const address = req.params.address;

    db.fetchNextGenAllowlist(merkleRoot, address).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(
        ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
        corsOptions.allowedHeaders
      );
      res.end(JSON.stringify(result));
    });
  }
);

router.get(
  `/burn_proofs/:merkle_root/:tokenId`,
  async function (req: any, res: any, next: any) {
    const merkleRoot = req.params.merkle_root;
    const tokenId = parseInt(req.params.tokenId);

    db.fetchNextGenBurnAllowlist(merkleRoot, tokenId).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(
        ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
        corsOptions.allowedHeaders
      );
      res.end(JSON.stringify(result));
    });
  }
);

router.get(`/allowlist_phases`, async function (req: any, res: any, next: any) {
  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;

  logger.info(
    `[FETCHING ALLOWLIST PHASES FOR ALL COLLECTIONS] : [PAGE SIZE ${pageSize}] : [PAGE ${page}]`
  );
  db.fetchAllAllowlistPhases(pageSize, page).then((result) => {
    return returnPaginatedResult(result, req, res);
  });
});

router.get(
  `/allowlist_phases/:collection_id`,
  async function (req: any, res: any, next: any) {
    let id: number = parseInt(req.params.collection_id);
    if (!isNaN(id)) {
      logger.info(`[FETCHING ALLOWLIST PHASES COLLECTION ID ${id}]`);
      db.fetchAllowlistPhasesForCollection(id).then((result) => {
        return returnPaginatedResult(result, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(`/featured`, async function (req: any, res: any, next: any) {
  logger.info(`[FETCHING FEATURED COLLECTION]`);
  db.fetchFeaturedCollection().then((result) => {
    return returnJsonResult(result, req, res);
  });
});

router.get(`/collections`, async function (req: any, res: any, next: any) {
  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;
  const statusKey =
    req.query.status?.toUpperCase() as keyof typeof NextGenCollectionStatus;
  const status =
    statusKey in NextGenCollectionStatus
      ? NextGenCollectionStatus[statusKey]
      : null;
  logger.info(
    `[FETCHING ALL COLLECTIONS] : [PAGE SIZE ${pageSize}] : [PAGE ${page}] : [STATUS ${status}]`
  );
  db.fetchNextGenCollections(pageSize, page, status).then((result) => {
    return returnPaginatedResult(result, req, res);
  });
});

router.get(`/collections/:id`, async function (req: any, res: any, next: any) {
  const id: number = parseInt(req.params.id);
  let result: any;
  if (!isNaN(id)) {
    logger.info(`[FETCHING COLLECTION ID ${id}]`);
    result = await db.fetchNextGenCollectionById(id);
  } else {
    const name = req.params.id.replace(/-/g, ' ');
    logger.info(`[FETCHING COLLECTION NAME ${name}]`);
    result = await db.fetchNextGenCollectionByName(name);
  }
  if (result?.id) {
    return returnJsonResult(result, req, res);
  } else {
    return res.status(404).send({});
  }
});

router.get(
  `/collections/:id/tokens`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);

    if (!isNaN(id)) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;
      const traits = req.query.traits ? req.query.traits.split(',') : [];
      const sortDir: PageSortDirection =
        PageSortDirection[
          req.query.sort_direction?.toUpperCase() as keyof typeof PageSortDirection
        ] || PageSortDirection.ASC;

      const sort: db.TokensSort =
        db.TokensSort[
          req.query.sort?.toUpperCase() as keyof typeof db.TokensSort
        ] || db.TokensSort.ID;

      const showNormalised = req.query.show_normalised === 'true';
      const showTraitCount = req.query.show_trait_count === 'true';

      let listed: db.ListedType = db.ListedType.ALL;
      if (req.query.listed === 'true') {
        listed = db.ListedType.LISTED;
      } else if (req.query.listed === 'false') {
        listed = db.ListedType.NOT_LISTED;
      }

      logger.info(`[FETCHING TOKENS FOR COLLECTION ID ${id}]`);
      db.fetchNextGenCollectionTokens(
        id,
        pageSize,
        page,
        traits,
        sort,
        sortDir,
        showNormalised,
        showTraitCount,
        listed
      ).then((result) => {
        return returnPaginatedResult(result, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(
  `/collections/:id/tokens/:token`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);
    const token: number = parseInt(req.params.token);
    if (!isNaN(id) && !isNaN(token)) {
      const tokenId = id * 10000000000 + token;
      logger.info(`[FETCHING TOKEN ${id}]`);
      db.fetchNextGenToken(tokenId).then((result) => {
        if (result.id) {
          return returnJsonResult(result, req, res);
        } else {
          return res.status(404).send({});
        }
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(
  `/collections/:id/logs`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    if (!isNaN(id)) {
      logger.info(`[FETCHING LOGS FOR COLLECTION ID ${id}]`);
      db.fetchNextGenCollectionLogs(id, pageSize, page).then((result) => {
        return returnJsonResult(result, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(
  `/collections/:id/logs/:tokenId`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);
    const tokenId = parseInt(req.params.tokenId);
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    if (!isNaN(id) && !isNaN(tokenId)) {
      logger.info(
        `[FETCHING LOGS FOR COLLECTION ID ${id} TOKEN ID ${tokenId}]`
      );
      db.fetchNextGenCollectionAndTokenLogs(id, tokenId, pageSize, page).then(
        (result) => {
          return returnJsonResult(result, req, res);
        }
      );
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(
  `/collections/:id/traits`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);

    if (!isNaN(id)) {
      logger.info(`[FETCHING TRAITS FOR COLLECTION ID ${id}]`);
      db.fetchNextGenCollectionTraits(id).then((result) => {
        const uniqueKeys: string[] = [];
        result.forEach((r: any) => {
          if (!uniqueKeys.includes(r.trait)) {
            uniqueKeys.push(r.trait);
          }
        });

        const traits: TokenTraitWithCount[] = [];
        uniqueKeys.forEach((key) => {
          const values = result
            .filter((r: any) => r.trait === key)
            .map((r: any) => {
              return {
                key: r.value,
                count: r.count
              };
            });
          const sortedValues = values
            .sort((a: any, b: any) => a.key.localeCompare(b.key))
            .sort((a: any, b: any) => a.count - b.count);
          const trait: TokenTraitWithCount = {
            trait: key,
            values: sortedValues.map((v: TokenValueCount) => v.key),
            value_counts: sortedValues
          };

          traits.push(trait);
        });
        const sortedTraits = traits
          .sort((a, b) => a.trait.localeCompare(b.trait))
          .sort((a, b) => b.values.length - a.values.length);
        return returnJsonResult(sortedTraits, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(`/tokens/:id`, async function (req: any, res: any, next: any) {
  const id: number = parseInt(req.params.id);
  if (!isNaN(id)) {
    logger.info(`[FETCHING TOKEN ${id}]`);
    db.fetchNextGenToken(id).then((result) => {
      if (result.id) {
        return returnJsonResult(result, req, res);
      } else {
        return res.status(404).send({});
      }
    });
  } else {
    return res.status(404).send({});
  }
});

router.get(
  `/tokens/:id/transactions`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    if (!isNaN(id)) {
      logger.info(`[FETCHING TOKEN ${id} TRANSACTIONS]`);
      db.fetchNextGenTokenTransactions(id, pageSize, page).then((result) => {
        return returnJsonResult(result, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(
  `/tokens/:id/traits`,
  async function (req: any, res: any, next: any) {
    const id: number = parseInt(req.params.id);

    if (!isNaN(id)) {
      logger.info(`[FETCHING TOKEN ${id} TRAITS]`);
      db.fetchNextGenTokenTraits(id).then((result) => {
        return returnJsonResult(result, req, res);
      });
    } else {
      return res.status(404).send({});
    }
  }
);

router.get(`/tdh`, async function (req: any, res: any, next: any) {
  const pageSize: number =
    req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
      ? parseInt(req.query.page_size)
      : DEFAULT_PAGE_SIZE;
  const page: number = req.query.page ? parseInt(req.query.page) : 1;

  const consolidationKeys = req.query.consolidation_key;
  const tokenIds = req.query.token_id;

  logger.info(`[FETCHING TOKEN TDH]`);

  db.fetchNextGenTokenTDH(consolidationKeys, tokenIds, pageSize, page).then(
    (result) => {
      return returnJsonResult(result, req, res);
    }
  );
});

async function persistAllowlist(body: {
  collection_id: number;
  added_by: string;
  al_type: string;
  phase: string;
  start_time: number;
  end_time: number;
  mint_price: number;
  merkle: {
    merkle_root: string;
    merkle_tree: any;
    allowlist: any[];
  };
}): Promise<void> {
  const collection = new NextGenAllowlistCollection();
  collection.collection_id = body.collection_id;
  collection.added_by = body.added_by;
  collection.al_type = body.al_type;
  collection.merkle_root = body.merkle.merkle_root;
  collection.phase = body.phase;
  collection.merkle_tree = JSON.stringify(body.merkle.merkle_tree);
  collection.start_time = body.start_time;
  collection.end_time = body.end_time;
  collection.mint_price = body.mint_price;

  const existingMerkle = await sqlExecutor.execute(
    `SELECT * FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} WHERE phase = :phase AND collection_id = :collection_id`,
    {
      phase: body.phase,
      collection_id: collection.collection_id
    }
  );

  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    if (existingMerkle.length > 0) {
      const existingMerkleRoot = existingMerkle[0].merkle_root;
      await sqlExecutor.execute(
        `DELETE FROM ${NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE} WHERE merkle_root = :merkle_root AND collection_id=:collection_id`,
        {
          merkle_root: existingMerkleRoot,
          collection_id: collection.collection_id
        },
        { wrappedConnection: connection }
      );
      await sqlExecutor.execute(
        `DELETE FROM ${NEXTGEN_ALLOWLIST_TABLE} WHERE merkle_root = :merkle_root AND collection_id=:collection_id`,
        {
          merkle_root: existingMerkleRoot,
          collection_id: collection.collection_id
        },
        { wrappedConnection: connection }
      );
      await sqlExecutor.execute(
        `DELETE FROM ${NEXTGEN_ALLOWLIST_BURN_TABLE} WHERE merkle_root = :merkle_root AND collection_id=:collection_id`,
        {
          merkle_root: existingMerkleRoot,
          collection_id: collection.collection_id
        },
        { wrappedConnection: connection }
      );
    }

    if (body.al_type === NextGenAllowlistType.ALLOWLIST) {
      const allowlistData: NextGenAllowlist[] = body.merkle.allowlist.map(
        (entry) => {
          const al = new NextGenAllowlist();
          al.address = entry.address;
          al.spots = entry.spots;
          al.info = entry.info;
          al.keccak = entry.keccak;
          al.merkle_root = body.merkle.merkle_root;
          return al;
        }
      );
      const allowlistInsert = extractNextGenAllowlistInsert(
        collection.collection_id,
        allowlistData
      );
      await sqlExecutor.execute(allowlistInsert.sql, allowlistInsert.params, {
        wrappedConnection: connection
      });
    } else if (body.al_type === NextGenAllowlistType.EXTERNAL_BURN) {
      const allowlistData: NextGenAllowlistBurn[] = body.merkle.allowlist.map(
        (entry) => {
          const al = new NextGenAllowlistBurn();
          al.token_id = entry.token_id;
          al.info = entry.info;
          al.keccak = entry.keccak;
          al.merkle_root = body.merkle.merkle_root;
          return al;
        }
      );
      const allowlistInsert = extractNextGenAllowlistBurnInsert(
        collection.collection_id,
        allowlistData
      );
      await sqlExecutor.execute(allowlistInsert.sql, allowlistInsert.params, {
        wrappedConnection: connection
      });
    }

    const collectionInsert = extractNextGenCollectionInsert(collection);
    await sqlExecutor.execute(collectionInsert.sql, collectionInsert.params, {
      wrappedConnection: connection
    });
  });

  logger.info(`[ALLOWLIST PERSISTED] [COLLECTION ID ${body.collection_id}]`);
}

export async function persistCollectionBurn(body: {
  collection_id: number;
  burn_collection: string;
  burn_collection_id: number;
  min_token_index: number;
  max_token_index: number;
  burn_address: string;
  status: boolean;
}) {
  const collectionBurn = new NextGenCollectionBurn();
  collectionBurn.collection_id = body.collection_id;
  collectionBurn.burn_collection = body.burn_collection;
  collectionBurn.burn_collection_id = body.burn_collection_id;
  collectionBurn.min_token_index = body.min_token_index;
  collectionBurn.max_token_index = body.max_token_index;
  collectionBurn.burn_address = body.burn_address;
  collectionBurn.status = body.status;

  const collectionBurnInsert =
    extractNextGenCollectionBurnInsert(collectionBurn);
  await sqlExecutor.execute(
    collectionBurnInsert.sql,
    collectionBurnInsert.params
  );

  logger.info(
    `[COLLECTION BURN PERSISTED] [COLLECTION ID ${body.collection_id}]`
  );
}

export default router;

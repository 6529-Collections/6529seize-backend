import {
  extractNextGenAllowlistBurnInsert,
  extractNextGenAllowlistInsert,
  extractNextGenCollectionBurnInsert,
  extractNextGenCollectionInsert,
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenAllowlistCollection,
  NextGenCollectionBurn
} from '../../../entities/INextGen';
import { BadRequestException } from '../../../exceptions';
import { Logger } from '../../../logging';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE
} from '../../../nextgen/nextgen_constants';
import { numbers } from '../../../numbers';
import { sqlExecutor } from '../../../sql-executor';
import {
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  CONTENT_TYPE_HEADER,
  corsOptions,
  DISTRIBUTION_PAGE_SIZE,
  JSON_HEADER_VALUE
} from '../api-constants';
import { NextGenCollectionStatus } from '../api-filters';
import { getPage, getPageSize, returnPaginatedResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { initMulterSingleMiddleware } from '../multer-middleware';
import { PageSortDirection } from '../page-request';
import { cacheRequest } from '../request-cache';
import * as db from './nextgen.db-api';
import {
  NextGenAllowlistType,
  validateNextgen,
  validateNextgenBurn
} from './validation';

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

function validateCollectionId(req: any, _: any, next: any) {
  const id = numbers.parseIntOrNull(req.params.id);
  if (id === null) {
    throw new BadRequestException('Collection ID must be a number.');
  }
  req.params.id = id;
  next();
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
    res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
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
    res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
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

router.get(`/merkle_roots/:merkle_root`, async function (req: any, res: any) {
  const merkleRoot = req.params.merkle_root;

  db.fetchNextGenAllowlistCollection(merkleRoot).then((result) => {
    if (result) {
      result.merkle_tree = JSON.parse(result.merkle_tree);
    } else {
      result = null;
    }
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
    res.end(JSON.stringify(result));
  });
});

router.get(
  `/:collection_id/allowlist_merkle/:merkle_root?`,
  async function (req: any, res: any) {
    const id = numbers.parseIntOrNull(req.params.collection_id);
    if (id === null) {
      return res.status(404).send({});
    }

    const addresses = req.query.address;
    const merkleRoot = req.params.merkle_root;

    const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
    const page = getPage(req);

    db.fetchNextGenAllowlistByPhase(
      id,
      addresses,
      merkleRoot,
      pageSize,
      page
    ).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
      res.end(JSON.stringify(result));
    });
  }
);

router.get(`/proofs`, async function (req: any, res: any) {
  const pageSize = getPageSize(req);
  const page = getPage(req);
  const addresses = req.query.address;

  db.fetchNextGenProofs(addresses, pageSize, page).then((result) => {
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
    res.end(JSON.stringify(result));
  });
});

router.get(
  `/proofs/:merkle_root/:address`,
  async function (req: any, res: any) {
    const merkleRoot = req.params.merkle_root;
    const address = req.params.address;

    db.fetchNextGenAllowlist(merkleRoot, address).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
      res.end(JSON.stringify(result));
    });
  }
);

router.get(
  `/burn_proofs/:merkle_root/:tokenId`,
  async function (req: any, res: any) {
    const merkleRoot = req.params.merkle_root;
    const tokenId = numbers.parseIntOrNull(req.params.tokenId);

    if (tokenId === null) {
      return res.status(400).send({});
    }

    db.fetchNextGenBurnAllowlist(merkleRoot, tokenId).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader(ACCESS_CONTROL_ALLOW_ORIGIN_HEADER, corsOptions.origin);
      res.end(JSON.stringify(result));
    });
  }
);

router.get(`/allowlist_phases`, async function (req: any, res: any) {
  const pageSize = getPageSize(req);
  const page = getPage(req);

  logger.info(
    `[FETCHING ALLOWLIST PHASES FOR ALL COLLECTIONS] : [PAGE SIZE ${pageSize}] : [PAGE ${page}]`
  );
  await db.fetchAllAllowlistPhases(pageSize, page).then(async (result) => {
    return returnPaginatedResult(result, req, res);
  });
});

router.get(
  `/allowlist_phases/:collection_id`,
  async function (req: any, res: any) {
    const id = numbers.parseIntOrNull(req.params.collection_id);
    if (id === null) {
      return res.status(404).send({});
    }

    logger.info(`[FETCHING ALLOWLIST PHASES COLLECTION ID ${id}]`);
    await db.fetchAllowlistPhasesForCollection(id).then(async (result) => {
      return returnPaginatedResult(result as unknown as any, req, res);
    });
  }
);

router.get(`/featured`, cacheRequest(), async function (req: any, res: any) {
  await db.fetchFeaturedCollection().then(async (result) => {
    return res.json(result);
  });
});

router.get(`/collections`, cacheRequest(), async function (req: any, res: any) {
  const pageSize = getPageSize(req);
  const page = getPage(req);
  const statusKey =
    req.query.status?.toUpperCase() as keyof typeof NextGenCollectionStatus;
  const status =
    statusKey in NextGenCollectionStatus
      ? NextGenCollectionStatus[statusKey]
      : null;
  await db
    .fetchNextGenCollections(pageSize, page, status)
    .then(async (result) => {
      return returnPaginatedResult(result, req, res);
    });
});

router.get(
  `/collections/:id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const id = numbers.parseIntOrNull(req.params.id);
    let result: any;
    if (id === null) {
      const name = req.params.id.replace(/-/g, ' ');
      logger.info(`[FETCHING COLLECTION BY NAME ${name}]`);
      result = await db.fetchNextGenCollectionByName(name);
    } else {
      logger.info(`[FETCHING COLLECTION BY ID ${id}]`);
      result = await db.fetchNextGenCollectionById(id);
    }
    if (result?.id) {
      return res.json(result);
    }
    return res.status(404).send({});
  }
);

router.get(
  `/collections/:id/tokens`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const pageSize = getPageSize(req);
    const page = getPage(req);
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

    await db
      .fetchNextGenCollectionTokens(
        id,
        pageSize,
        page,
        traits,
        sort,
        sortDir,
        showNormalised,
        showTraitCount,
        listed
      )
      .then(async (result) => {
        return returnPaginatedResult(result, req, res);
      });
  }
);

router.get(
  `/collections/:id/tokens/:token`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const token = numbers.parseIntOrNull(req.params.token);

    if (token === null) {
      throw new BadRequestException('Token must be a number.');
    }

    const tokenId = id * 10000000000 + token;
    await db.fetchNextGenToken(tokenId).then(async (result) => {
      if (result.id) {
        return res.json(result);
      } else {
        return res.status(404).send({});
      }
    });
  }
);

router.get(
  `/collections/:id/logs`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const pageSize = getPageSize(req);
    const page = getPage(req);

    await db
      .fetchNextGenCollectionLogs(id, pageSize, page)
      .then(async (result) => {
        return res.json(result);
      });
  }
);

router.get(
  `/collections/:id/logs/:tokenId`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const tokenId = numbers.parseIntOrNull(req.params.tokenId);

    if (tokenId === null) {
      throw new BadRequestException('Token ID must be a number.');
    }

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await db
      .fetchNextGenCollectionOnlyLogs(id, pageSize, page)
      .then(async (result) => {
        return res.json(result);
      });
  }
);

router.get(
  `/collections/:id/traits`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;

    await db.fetchNextGenCollectionTraits(id).then(async (result) => {
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
        const sortedValues = [...values]
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
      return res.json(sortedTraits);
    });
  }
);

router.get(
  `/collections/:id/ultimate_trait_set`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const traits = req.query.trait;

    if (!traits) {
      throw new BadRequestException('Traits must be supplied.');
    }

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await db
      .fetchNextGenCollectionTraitSetsUltimate(id, traits, pageSize, page)
      .then(async (result) => {
        return res.json(result);
      });
  }
);

router.get(
  `/collections/:id/trait_sets/:trait`,
  validateCollectionId,
  cacheRequest(),
  async function (req: any, res: any) {
    const id: number = req.params.id;
    const trait: string = req.params.trait;

    const pageSize = getPageSize(req);
    const page = getPage(req);
    const search = req.query.search;

    await db
      .fetchNextGenCollectionTraitSets(id, trait, pageSize, page, search)
      .then(async (result) => {
        return res.json(result);
      });
  }
);

router.get(`/tokens/:id`, cacheRequest(), async function (req: any, res: any) {
  const id = numbers.parseIntOrNull(req.params.id);
  if (id === null) {
    throw new BadRequestException('Token ID must be a number.');
  }

  await db.fetchNextGenToken(id).then(async (result) => {
    if (result.id) {
      return res.json(result);
    } else {
      return res.status(404).send({});
    }
  });
});

router.get(
  `/tokens/:id/transactions`,
  cacheRequest(),
  async function (req: any, res: any) {
    const id = numbers.parseIntOrNull(req.params.id);
    if (id === null) {
      throw new BadRequestException('Token ID must be a number.');
    }

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await db
      .fetchNextGenTokenTransactions(id, pageSize, page)
      .then(async (result) => {
        return res.json(result);
      });
  }
);

router.get(
  `/tokens/:id/traits`,
  cacheRequest(),
  async function (req: any, res: any) {
    const id = numbers.parseIntOrNull(req.params.id);
    if (id === null) {
      throw new BadRequestException('Token ID must be a number.');
    }

    await db.fetchNextGenTokenTraits(id).then(async (result) => {
      return res.json(result);
    });
  }
);

router.get(`/tdh`, cacheRequest(), async function (req: any, res: any) {
  const pageSize = getPageSize(req);
  const page = getPage(req);

  const consolidationKeys = req.query.consolidation_key;
  const tokenIds = req.query.token_id;

  logger.info(`[FETCHING TOKEN TDH]`);

  await db
    .fetchNextGenTokenTDH(consolidationKeys, tokenIds, pageSize, page)
    .then(async (result) => {
      return res.json(result);
    });
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

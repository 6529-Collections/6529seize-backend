import {
  NextGenAllowlistType,
  validateNextgen,
  validateNextgenBurn
} from './validation';
import {
  ACCESS_CONTROL_ALLOW_HEADER,
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from '../options';
import { sqlExecutor } from '../../../sql-executor';
import {
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenCollection,
  NextGenCollectionBurn,
  extractNextGenAllowlistBurnInsert,
  extractNextGenAllowlistInsert,
  extractNextGenCollectionBurnInsert,
  extractNextGenCollectionInsert
} from '../../../entities/INextGen';
import { execSQLWithTransaction } from '../../../db-api';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_COLLECTIONS_TABLE
} from '../../../constants';
import * as mysql from 'mysql';
import * as db from '../../../db-api';
import { asyncRouter } from '../async.router';
import { initMulterSingleMiddleware } from '../multer-middleware';

const router = asyncRouter();

router.post(
  '/create_allowlist',
  initMulterSingleMiddleware('allowlist'),
  validateNextgen,
  async (req: any, res: any) => {
    const body = req.validatedBody;
    console.log(
      new Date(),
      `[API]`,
      '[NEXTGEN]',
      `[VALID ${body.valid}]`,
      `[FROM ${body.added_by}]`
    );
    const valid = body.valid;
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
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
    console.log(
      new Date(),
      `[API]`,
      '[NEXTGEN COLLECTION BURN]',
      `[VALID ${body.valid}]`
    );
    const valid = body.valid;
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
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

router.get(`/:merkle_root`, async function (req: any, res: any, next: any) {
  const merkleRoot = req.params.merkle_root;

  db.fetchNextGenCollection(merkleRoot).then((result) => {
    if (result) {
      result.merkle_tree = JSON.parse(result.merkle_tree);
    } else {
      result = null;
    }
    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
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
      res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
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
      res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
      res.end(JSON.stringify(result));
    });
  }
);

async function persistAllowlist(body: {
  collection_id: number;
  added_by: string;
  al_type: string;
  phase: string;
  merkle: {
    merkle_root: string;
    merkle_tree: any;
    allowlist: any[];
  };
}): Promise<void> {
  const collection = new NextGenCollection();
  collection.collection_id = body.collection_id;
  collection.added_by = body.added_by;
  collection.al_type = body.al_type;
  collection.merkle_root = body.merkle.merkle_root;
  collection.phase = body.phase;
  collection.merkle_tree = JSON.stringify(body.merkle.merkle_tree);

  const sqlOperations = [];

  const existingMerkle = await sqlExecutor.execute(
    `SELECT * FROM ${NEXTGEN_COLLECTIONS_TABLE} WHERE collection_id = :collection_id`,
    {
      collection_id: collection.collection_id
    }
  );

  if (existingMerkle.length > 0) {
    const existingMerkleRoot = existingMerkle[0].merkle_root;
    sqlOperations.push(
      `DELETE FROM ${NEXTGEN_COLLECTIONS_TABLE} WHERE merkle_root = ${mysql.escape(
        existingMerkleRoot
      )} AND collection_id=${collection.collection_id}`
    );
    sqlOperations.push(
      `DELETE FROM ${NEXTGEN_ALLOWLIST_TABLE} WHERE merkle_root = ${mysql.escape(
        existingMerkleRoot
      )} AND collection_id=${collection.collection_id}`
    );
    sqlOperations.push(
      `DELETE FROM ${NEXTGEN_ALLOWLIST_BURN_TABLE} WHERE merkle_root = ${mysql.escape(
        existingMerkleRoot
      )} AND collection_id=${collection.collection_id}`
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
    sqlOperations.push(
      extractNextGenAllowlistInsert(collection.collection_id, allowlistData)
    );
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
    sqlOperations.push(
      extractNextGenAllowlistBurnInsert(collection.collection_id, allowlistData)
    );
  }

  const collectionInsert = extractNextGenCollectionInsert(collection);
  sqlOperations.push(collectionInsert);
  await execSQLWithTransaction(sqlOperations).catch((e) => {
    console.log('i am error', e);
  });

  console.log(
    `[NEXTGEN ALLOWLIST]`,
    `[ALLOWLIST PERSISTED]`,
    `[COLLECTION ID ${body.collection_id}]`
  );
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
  await sqlExecutor.execute(collectionBurnInsert);

  console.log(
    `[NEXTGEN COLLECTION BURN]`,
    `[COLLECTION BURN PERSISTED]`,
    `[COLLECTION ID ${body.collection_id}]`
  );
}

export default router;

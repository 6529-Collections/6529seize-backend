import { validateNextgen } from './validation';
import {
  ACCESS_CONTROL_ALLOW_HEADER,
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from '../options';
import { sqlExecutor } from '../../../sql-executor';
import {
  NextGenAllowlist,
  NextGenCollection,
  extractNextGenAllowlistInsert,
  extractNextGenCollectionInsert
} from '../../../entities/INextGen';
import { execSQLWithTransaction } from '../../../db-api';
import {
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_COLLECTIONS_TABLE
} from '../../../constants';
import * as mysql from 'mysql';
import * as db from '../../../db-api';
import { asyncRouter } from '../async.router';
import { initMulterSingleMiddleware } from 'src/multer-middleware';

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

router.get(
  `/:merkle_root/:address`,
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

async function persistAllowlist(body: {
  collection_id: number;
  added_by: string;
  merkle: {
    merkle_root: string;
    merkle_tree: any;
    allowlist: any[];
  };
}): Promise<void> {
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

  const collection = new NextGenCollection();
  collection.collection_id = body.collection_id;
  collection.added_by = body.added_by;
  collection.merkle_root = body.merkle.merkle_root;
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
  }

  sqlOperations.push(
    extractNextGenAllowlistInsert(collection.collection_id, allowlistData)
  );
  sqlOperations.push(extractNextGenCollectionInsert(collection));
  await execSQLWithTransaction(sqlOperations);

  console.log(
    `[NEXTGEN ALLOWLIST]`,
    `[ALLOWLIST PERSISTED]`,
    `[COLLECTION ID ${body.collection_id}]`
  );
}

export default router;

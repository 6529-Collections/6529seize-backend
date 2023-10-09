import { Router } from 'express';
import { validateNextgen } from './validation';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from 'src/options';
import { sqlExecutor } from '../../../sql-executor';
import {
  NextGenAllowlist,
  NextGenCollection,
  extractNextGenAllowlistInsert,
  extractNextGenCollectionInsert
} from '../../../entities/INextGen';
import { execSQLWithTransaction } from '../../../db-api';

const router = Router();
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.get(`/`, async function (req: any, res: any, next: any) {
  res.status(200);
  res.end();
});

router.post(
  '/create_allowlist',
  upload.single('allowlist'),
  validateNextgen,
  async (req: any, res: any) => {
    try {
      const body = req.validatedBody;
      console.log(
        new Date(),
        `[API]`,
        '[NEXTGEN]',
        `[VALID ${body.valid}]`,
        `[FROM ${req.body.wallet}]`
      );
      const valid = body.valid;
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader('Access-Control-Allow-Headers', corsOptions.allowedHeaders);
      if (valid) {
        await persistAllowlist(body.merkle);
        res
          .status(200)
          .send(JSON.stringify({ merkle_root: body.merkle.merkle_root }));
        res.end();
      } else {
        res.status(400).send(JSON.stringify(body));
        res.end();
      }
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[NEXTGEN]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  }
);

export default router;

async function persistAllowlist(merkle: {
  merkle_root: string;
  merkle_tree: any;
  allowlist: any[];
}): Promise<void> {
  const allowlistData: NextGenAllowlist[] = merkle.allowlist.map((entry) => {
    const al = new NextGenAllowlist();
    al.address = entry.address;
    al.spots = entry.spots;
    al.info = entry.info;
    al.keccak = entry.keccak;
    al.merkle_root = merkle.merkle_root;
    return al;
  });

  const collection = new NextGenCollection();
  collection.merkle_root = merkle.merkle_root;
  collection.merkle_tree = JSON.stringify(merkle.merkle_tree);

  const result = await execSQLWithTransaction([
    extractNextGenAllowlistInsert(allowlistData),
    extractNextGenCollectionInsert(collection)
  ]);

  console.log(
    `[NEXTGEN ALLOWLIST]`,
    `[Allowlist persisted]`,
    `[MERKLE ROOT ${merkle.merkle_root}]`
  );
}

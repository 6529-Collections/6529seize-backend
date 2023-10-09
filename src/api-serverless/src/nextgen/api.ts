import { Router } from 'express';
import { validateNextgen } from './validation';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from 'src/options';

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

import { Router } from 'express';
import * as db from '../../../db-api';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from 'src/options';
import { validateUser } from './user_validation';

const router = Router();
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.get('/:address/', function (req: any, res: any, next: any) {
  try {
    const address = req.params.address;

    console.log(new Date(), `[API]`, '[USER]', `[ADDRESS ${address}]`);

    db.fetchUser(address).then((result) => {
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      if (result.length == 1) {
        res.end(JSON.stringify(result[0]));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  } catch (e) {
    console.log(
      new Date(),
      `[API]`,
      '[USER]',
      `SOMETHING WENT WRONG [EXCEPTION ${e}]`
    );
    next(e);
  }
});

router.post(
  '/',
  upload.single('pfp'),
  validateUser,
  function (req: any, res: any, next: any) {
    try {
      const body = req.validatedBody;
      console.log(
        new Date(),
        `[API]`,
        '[USER]',
        `[VALID ${body.valid}]`,
        `[FROM ${req.body.wallet}]`
      );
      const valid = body.valid;
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader('Access-Control-Allow-Headers', corsOptions.allowedHeaders);
      if (valid) {
        db.updateUser(body.user).then((result) => {
          res.status(200).send(JSON.stringify(body));
          res.end();
        });
      } else {
        res.status(400).send(JSON.stringify(body));
        res.end();
      }
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[USER]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  }
);

export default router;

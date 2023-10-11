import { Router } from 'express';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from '../options';
import { validateRememe, validateRememeAdd } from './rememes_validation';
import * as db from '../../../db-api';

const router = Router();

router.post(
  `/validate`,
  validateRememe,
  function (req: any, res: any, next: any) {
    try {
      const body = req.validatedBody;
      console.log(
        new Date(),
        `[API]`,
        '[REMEMES VALIDATE]',
        `[VALID ${body.valid}]`
      );
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader('Access-Control-Allow-Headers', corsOptions.allowedHeaders);
      res.status(body.valid ? 200 : 400).send(JSON.stringify(body));
      res.end();
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[REMEMES VALIDATE]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  }
);

router.post(
  `/add`,
  validateRememeAdd,
  function (req: any, res: any, next: any) {
    try {
      const body = req.validatedBody;
      console.log(
        new Date(),
        `[API]`,
        '[REMEMES ADD]',
        `[VALID ${body.valid}]`,
        `[FROM ${req.body.address}]`
      );
      const valid = body.valid;
      res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
      res.setHeader('Access-Control-Allow-Headers', corsOptions.allowedHeaders);
      if (valid) {
        db.addRememe(req.body.address, body).then((result) => {
          res.status(201).send(JSON.stringify(body));
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
        '[REMEMES ADD]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  }
);

export default router;

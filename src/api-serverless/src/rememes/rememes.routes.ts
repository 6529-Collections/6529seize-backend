import { Router } from 'express';
import {
  ACCESS_CONTROL_ALLOW_HEADER,
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  corsOptions
} from '../options';
import { validateRememe, validateRememeAdd } from './rememes_validation';
import * as db from '../../../db-api';
import { asyncRouter } from '../async.router';

const router = asyncRouter();

router.post(`/rememes/validate`, validateRememe, function (req: any, res: any) {
  const body = req.validatedBody;
  res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
  res
    .status(body.valid ? 200 : 400)
    .send(JSON.stringify(body))
    .end();
});

router.post(`/rememes/add`, validateRememeAdd, function (req: any, res: any) {
  const body = req.validatedBody;
  const valid = body.valid;
  res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  res.setHeader(ACCESS_CONTROL_ALLOW_HEADER, corsOptions.allowedHeaders);
  if (valid) {
    db.addRememe(req.body.address, body).then((result) => {
      res.status(201).send(JSON.stringify(body));
      res.end();
    });
  } else {
    res.status(400).send(JSON.stringify(body));
    res.end();
  }
});

export default router;

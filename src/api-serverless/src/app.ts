import * as db from '../../db-api';

import { NextFunction, Request, Response } from 'express';
import { Time } from '../../time';
import { asyncRouter } from './async.router';
import { ApiCompliantException } from '../../exceptions';

import { Logger } from '../../logging';
import * as process from 'process';

import { corsOptions } from './api-constants';
import { prepEnvironment } from '../../env';
import { returnJsonResult } from './api-helpers';

const requestLogger = Logger.get('API_REQUEST');
const logger = Logger.get('API');

function requestLogMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    const { method, originalUrl: url } = request;
    const start = Time.now();
    response.on('close', () => {
      const { statusCode } = response;
      requestLogger.info(
        `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${start
          .diffFromNow()
          .toMillis()}]`
      );
      Logger.deregisterRequestId();
    });
    next();
  };
}

function customErrorMiddleware() {
  return (err: Error, _: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).send({ error: err.message });
      next();
    } else {
      res.status(500).send({ error: 'Something went wrong...' });
      next(err);
    }
  };
}

const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const rootRouter = asyncRouter();

async function loadApi() {
  await prepEnvironment();
  await db.connect();
}

loadApi().then(() => {
  logger.info(
    `[DB HOST ${process.env.DB_HOST_READ}] [API PASSWORD ACTIVE ${process.env.ACTIVATE_API_PASSWORD}] [LOAD SECRETS ENABLED ${process.env.API_LOAD_SECRETS}]`
  );

  app.use(requestLogMiddleware());
  app.use(compression());
  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          fontSrc: ["'self'"],
          imgSrc: ["'self'"]
        }
      },
      referrerPolicy: {
        policy: 'same-origin'
      },
      frameguard: {
        action: 'sameorigin'
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true
      },
      nosniff: true,
      permissionsPolicy: {
        policy: {
          accelerometer: "'none'",
          camera: "'none'",
          geolocation: "'none'",
          microphone: "'none'",
          payment: "'none'"
        }
      }
    })
  );
  app.enable('trust proxy');

  const BASE_PATH = '/api';
  const apiRouter = asyncRouter();

  apiRouter.get(
    '/tdh/total',
    async function (req: Request<{}, any, any, {}>, res: any) {
      const result = await db.fetchTotalTDH();
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/above/:value',
    async function (
      req: Request<
        {
          value: number;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const value = req.params.value;
      if (isNaN(value)) {
        return res.status(400).send({ error: 'Invalid value' });
      }
      const result = await db.fetchTDHAbove(Number(value));
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/percentile/:value',
    async function (
      req: Request<
        {
          value: number;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const percentile = req.params.value;
      if (
        !percentile ||
        isNaN(percentile) ||
        !Number.isInteger(Number(percentile)) ||
        percentile <= 0 ||
        percentile > 10000
      ) {
        return res
          .status(400)
          .send(
            'Invalid percentile value. Please provide an integer between 0 and 10000.'
          );
      }

      const resolvedPercentile = Number(percentile) / 100;
      const result = await db.fetchTDHPercentile(resolvedPercentile);
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/cutoff/:value',
    async function (
      req: Request<
        {
          value: number;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const cutoff = req.params.value;
      if (!Number.isInteger(Number(cutoff)) || cutoff < 1) {
        return res
          .status(400)
          .send('Invalid cutoff value. Please provide a non-negative integer.');
      }

      const result = await db.fetchTDHCutoff(Number(cutoff));
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/:address',
    async function (
      req: Request<
        {
          address: string;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const address = req.params.address;
      const result = await db.fetchSingleAddressTDH(address);
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/:address/breakdown',
    async function (
      req: Request<
        {
          address: string;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const address = req.params.address;
      const result = await db.fetchSingleAddressTDHBreakdown(address);
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/tdh/:address/memes_seasons',
    async function (
      req: Request<
        {
          address: string;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const address = req.params.address;
      const result = await db.fetchSingleAddressTDHMemesSeasons(address);
      return returnJsonResult(result, res);
    }
  );

  apiRouter.get(
    '/nfts/:contract?',
    async function (
      req: Request<
        {
          contract?: string;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const contract = req.params.contract;
      const result = await db.fetchNfts(contract);
      return returnJsonResult(result, res);
    }
  );

  rootRouter.use(BASE_PATH, apiRouter);
  app.use(rootRouter);

  app.use(customErrorMiddleware());

  app.listen(3000, function () {
    logger.info(
      `[CONFIG ${process.env.NODE_ENV}] [SERVER RUNNING ON PORT 3000]`
    );
  });
});

export { app };

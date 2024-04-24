import * as db from '../../db-api';

import { NextFunction, Request, Response } from 'express';
import { Time } from '../../time';
import { asyncRouter } from './async.router';
import { ApiCompliantException } from '../../exceptions';

import { Logger } from '../../logging';
import * as process from 'process';
import { fetchSingleWalletTDH, returnJsonResult } from './api-helpers';
import { corsOptions } from './api-constants';
import { loadLocalConfig } from '../../env';

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
  await loadLocalConfig();
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
    '/tdh/:wallet',
    async function (
      req: Request<
        {
          wallet: string;
        },
        any,
        any,
        {}
      >,
      res: any
    ) {
      const wallet = req.params.wallet;
      const result = await fetchSingleWalletTDH(wallet);
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

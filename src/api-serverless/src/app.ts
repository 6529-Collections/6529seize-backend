import fetch from 'node-fetch';
import * as db from '../../db-api';
import { ids } from '../../ids';

import * as http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import aggregatedActivityRoutes from './aggregated-activity/api.aggregated-activity.routes';
import authRoutes from './auth/auth.routes';
import communityMembersRoutes from './community-members/community-members.routes';
import communityMetricsRoutes from './community-metrics/community-metrics.routes';
import userGroupsImEligibleForRoutes from './community-members/user-groups-im-elgigible-for.routes';
import userGroupsRoutes from './community-members/user-groups.routes';
import delegationsRoutes from './delegations/delegations.routes';
import distributionPhotosRoutes from './distribution-photos/api.distribution_photos.routes';
import distributionsRoutes from './distributions/api.distributions.routes';
import dropsMediaRoutes from './drops/drops-media.routes';
import dropsRoutes from './drops/drops.routes';
import lightDropsRoutes from './drops/light-drops.routes';
import feedRoutes from './feed/feed.routes';
import gasRoutes from './gas/gas.routes';
import identitiesRoutes from './identities/identities.routes';
import identitySubscriptionsRoutes from './identity-subscriptions/identity-subscriptions.routes';
import nextgenRoutes from './nextgen/nextgen.routes';
import nftOwnersRoutes from './nft-owners/api.nft-owners.routes';
import notificationsRoutes from './notifications/notifications.routes';
import oracleRoutes from './oracle/api.oracle.routes';
import ownersBalancesRoutes from './owners-balances/api.owners-balances.routes';
import policiesRoutes from './policies/policies.routes';
import profileActivityLogsRoutes from './profiles/profile-activity-logs.routes';
import profileSubClassificationsRoutes from './profiles/profiles-sub-classifications.routes';
import profilesRoutes from './profiles/profiles.routes';
import repCategorySearchRoutes from './profiles/rep-category-search.routes';
import boostedDropsRoutes from './drops/boosted-drops.routes';
import bookmarkedDropsRoutes from './drops/bookmarked-drops.routes';
import proxiesRoutes from './proxies/proxies.routes';
import pushNotificationsRoutes from './push-notifications/push-notifications.routes';
import bulkRepRoutes from './ratings/bulk-rep.routes';
import ratingsRoutes from './ratings/ratings.routes';
import rememesRoutes from './rememes/rememes.routes';
import royaltiesRoutes from './royalties/royalties.routes';
import tdhEditionsRoutes from './tdh-editions/tdh-editions.routes';
import tdhRoutes from './tdh/api.tdh.routes';
import waveMediaRoutes from './waves/wave-media.routes';
import wavesOverviewRoutes from './waves/waves-overview.routes';
import publicWavesRoutes from './waves/waves-public.routes';
import wavesRoutes from './waves/waves.routes';
import xtdhRoutes from './xtdh/xtdh.routes';

import * as Sentry from '@sentry/serverless';
import { NextFunction, Request, Response } from 'express';
import * as Joi from 'joi';
import * as passport from 'passport';
import {
  ExtractJwt,
  Strategy as JwtStrategy,
  VerifiedCallback
} from 'passport-jwt';
import { ApiCompliantException } from '../../exceptions';
import * as sentryContext from '../../sentry.context';
import { Time, Timer } from '../../time';
import { asyncRouter } from './async.router';
import { getJwtSecret } from './auth/auth';

import * as awsServerlessExpressMiddleware from 'aws-serverless-express/middleware';
import { randomUUID } from 'crypto';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import * as process from 'process';
import * as SwaggerUI from 'swagger-ui-express';
import { Artist } from '../../entities/IArtist';
import { NFT } from '../../entities/INFT';
import { TDHBlock } from '../../entities/ITDH';
import { Upload } from '../../entities/IUpload';
import { env, loadLocalConfig, loadSecrets } from '../../env';
import { loggerContext } from '../../logger-context';
import { Logger } from '../../logging';
import { numbers } from '../../numbers';
import { getRedisClient, initRedis, redisGet } from '../../redis';
import { parseTdhResultsFromDB } from '../../sql_helpers';
import alchemyProxyRoutes from './alchemy-proxy/alchemy-proxy.routes';
import {
  corsOptions,
  DEFAULT_PAGE_SIZE,
  DISTRIBUTION_PAGE_SIZE,
  NFTS_PAGE_SIZE,
  PaginatedResponse,
  seizeSettings,
  SORT_DIRECTIONS
} from './api-constants';
import { MEMES_EXTENDED_SORT, TRANSACTION_FILTERS } from './api-filters';
import {
  cacheKey,
  getPage,
  getPageSize,
  returnJsonResult,
  returnPaginatedResult,
  transformPaginatedResponse
} from './api-helpers';
import { ApiResponse } from './api-response';
import { ApiArtistItem } from './generated/models/ApiArtistItem';
import { ApiArtistNameItem } from './generated/models/ApiArtistNameItem';
import { ApiArtistsPage } from './generated/models/ApiArtistsPage';
import { ApiBlockItem } from './generated/models/ApiBlockItem';
import { ApiBlocksPage } from './generated/models/ApiBlocksPage';
import { ApiNft } from './generated/models/ApiNft';
import { ApiNftsPage } from './generated/models/ApiNftsPage';
import { ApiSeizeSettings } from './generated/models/ApiSeizeSettings';
import { ApiTransactionPage } from './generated/models/ApiTransactionPage';
import { ApiUploadItem } from './generated/models/ApiUploadItem';
import { ApiUploadsPage } from './generated/models/ApiUploadsPage';
import { LOGO_SVG, renderHealthUI } from './health/health-ui.renderer';
import { getHealthData } from './health/health.service';
import { DEFAULT_MAX_SIZE } from './page-request';
import {
  initRateLimiting,
  rateLimitingMiddleware
} from './rate-limiting/rate-limiting.middleware';
import { cacheRequest, isRequestCacheEntry } from './request-cache';
import rpcRoutes from './rpc/rpc.routes';
import sitemapRoutes from './sitemap/sitemap.routes';
import subscriptionsRoutes from './subscriptions/api.subscriptions.routes';
import { getValidatedByJoiOrThrow } from './validation';
import {
  appWebSockets,
  authenticateWebSocketJwtOrGetByConnectionId,
  mapHttpRequestToGatewayEvent
} from './ws/ws';
import { wsListenersNotifier } from './ws/ws-listeners-notifier';
import { WsMessageType } from './ws/ws-message';
import * as crypto from 'node:crypto';
import { githubIssueDropService } from './github/github-issue-drop.service';

const YAML = require('yamljs');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');

const requestLogger = Logger.get('API_REQUEST');
const logger = Logger.get('API');

const API_PORT = 3000;

function requestLogMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    const requestId =
      request.apiGateway?.context?.awsRequestId ?? ids.uniqueShortId();
    loggerContext.run({ requestId }, () => {
      const { method, originalUrl: url } = request;
      const uqKey = `${method} ${url}`;
      const timer = new Timer(uqKey);
      (request as any).timer = timer;
      response.on('close', () => {
        const { statusCode } = response;
        const slowRequestThresholdEnv = numbers.parseIntOrNull(
          process.env.SLOW_API_REQUEST_THRESHOLD
        );
        const slowRequestThreshold = slowRequestThresholdEnv
          ? Time.millis(slowRequestThresholdEnv)
          : Time.seconds(1);
        if (timer.getTotalTimePassed().gt(slowRequestThreshold)) {
          requestLogger.warn(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${timer
              .getTotalTimePassed()
              .toMillis()}] [${timer.getReport()}]`
          );
        } else {
          requestLogger.info(
            `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${timer
              .getTotalTimePassed()
              .toMillis()}]`
          );
        }
      });
      next();
    });
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

function sentryFlusherMiddleware() {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    Sentry.flush(Time.seconds(2).toMillis()).then(() => {
      next(err);
    });
  };
}

const app = express();
const rootRouter = asyncRouter();

const storage = multer.memoryStorage();
multer({ storage: storage });

let isInitialized = false;

async function loadApiSecrets() {
  if (process.env.API_LOAD_SECRETS === 'true') {
    await loadSecrets();
  }
}

async function loadApi() {
  await loadLocalConfig();
  await db.connect();
}

async function initializeApp() {
  await loadApi();
  logger.info(
    `[DB HOST ${process.env.DB_HOST_READ}] [API PASSWORD ACTIVE ${process.env.ACTIVATE_API_PASSWORD}] [LOAD SECRETS ENABLED ${process.env.API_LOAD_SECRETS}]`
  );

  await loadApiSecrets();
  await initRedis();
  initRateLimiting();
  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: getJwtSecret()
      },
      function (
        {
          sub: wallet,
          role,
          exp
        }: { sub: string; role?: string; exp?: number },
        cb: VerifiedCallback
      ) {
        return cb(null, { wallet: wallet, role, exp });
      }
    )
  );
  passport.use(new AnonymousStrategy());
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Only enabled in AWS Lambda
    app.use(awsServerlessExpressMiddleware.eventContext());
  }
  app.use(requestLogMiddleware());
  app.use(compression());
  app.use(cors(corsOptions));
  app.use(
    express.json({
      limit: '5mb',
      verify: (req: any, _res: any, buf: Buffer) => {
        // Store raw body only for webhook endpoints that need signature verification
        if (req.url === '/gh-hooks') {
          req.rawBody = buf;
        }
      }
    })
  );
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

  const pass = process.env.API_PASSWORD
    ? process.env.API_PASSWORD.split(',')
    : [];

  const requireLogin = async (req: any, res: any, next: any) => {
    if (req.method == 'OPTIONS') {
      next();
    } else if (
      process.env.ACTIVATE_API_PASSWORD &&
      process.env.ACTIVATE_API_PASSWORD === 'true'
    ) {
      const auth = req.headers['x-6529-auth'];
      if (!auth || !pass.includes(auth)) {
        logger.info(`Unauthorized request for ${req.path} auth: ${auth}`);
        res.statusCode = 401;
        const image = await db.fetchRandomImage();
        await returnJsonResult(
          {
            image: image[0].scaled ? image[0].scaled : image[0].image
          },
          req,
          res
        );
      } else {
        next();
      }
    } else {
      next();
    }
  };

  const checkCache = async function (req: any, res: any, next: any) {
    return redisGet(cacheKey(req))
      .then((cachedBody) => {
        if (!cachedBody) {
          return next();
        }
        // this checks if old cache already caches it. temporary thing.
        if (isRequestCacheEntry(cachedBody)) {
          return next();
        }
        return returnPaginatedResult(
          cachedBody as PaginatedResponse<any>,
          req,
          res,
          true
        );
      })
      .catch(() => next());
  };

  const BASE_PATH = '/api';
  const apiRouter = asyncRouter();

  app.all(`${BASE_PATH}*`, requireLogin);
  app.all(`${BASE_PATH}*`, checkCache);

  apiRouter.get(
    `/blocks`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiBlocksPage>>) {
      const pageSize = getPageSize(req);
      const page = getPage(req);
      await db.fetchBlocks(pageSize, page).then(async (result) => {
        await returnPaginatedResult(
          transformPaginatedResponse(
            (orig: TDHBlock): ApiBlockItem => ({
              block_number: orig.block_number,
              timestamp: orig.timestamp,
              created_at: orig.created_at!
            }),
            result
          ),
          req,
          res
        );
      });
    }
  );

  apiRouter.get(
    `/settings`,
    async function (req: any, res: Response<ApiResponse<ApiSeizeSettings>>) {
      await returnJsonResult(seizeSettings(), req, res);
    }
  );

  const UploadsQuerySchema = Joi.object({
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
    page: Joi.number().integer().min(1).default(1),
    block: Joi.number().integer().min(0).default(0),
    date: Joi.string()
      .optional()
      .pattern(/\d\d\d\d\d\d\d\d/)
  });

  apiRouter.get(
    `/uploads`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiUploadsPage>>) {
      const params = getValidatedByJoiOrThrow(req.query, UploadsQuerySchema);
      await db
        .fetchUploads(params.page_size, params.page, params.block, params.date)
        .then(async (result) => {
          await returnPaginatedResult(
            transformPaginatedResponse(
              (orig: Upload): ApiUploadItem => ({
                date: orig.date,
                block: orig.block,
                url: orig.tdh
              }),
              result
            ),
            req,
            res
          );
        });
    }
  );

  apiRouter.get(
    `/consolidated_uploads`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiUploadsPage>>) {
      const params = getValidatedByJoiOrThrow(req.query, UploadsQuerySchema);
      await db
        .fetchConsolidatedUploads(
          params.page_size,
          params.page,
          params.block,
          params.date
        )
        .then(async (result) => {
          await returnPaginatedResult(
            transformPaginatedResponse(
              (orig: Upload): ApiUploadItem => ({
                date: orig.date,
                block: orig.block,
                url: orig.tdh
              }),
              result
            ),
            req,
            res
          );
        });
    }
  );

  apiRouter.get(
    `/artists`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiArtistsPage>>) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const meme_nfts = req.query.meme_id;

      await db.fetchArtists(pageSize, page, meme_nfts).then(async (result) => {
        await returnPaginatedResult(
          transformPaginatedResponse(
            (orig: Artist): ApiArtistItem => ({
              name: orig.name,
              bio: orig.bio ?? null,
              pfp: orig.pfp ?? null,
              memes: JSON.parse(orig.memes as any),
              memelab: JSON.parse(orig.memelab as any),
              gradients: JSON.parse(orig.gradients as any),
              work: JSON.parse(orig.work as any),
              social_links: JSON.parse(orig.social_links as any)
            }),
            result
          ),
          req,
          res
        );
      });
    }
  );

  apiRouter.get(
    `/memes/artists_names`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      await db.fetchArtistsNamesMemes().then(async (result) => {
        return await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/memelab/artists_names`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      await db.fetchArtistsNamesMemeLab().then(async (result) => {
        return await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/nfts`,
    cacheRequest(),
    async function (req: any, res: Response<ApiNftsPage>) {
      const pageSize = getPageSize(req, NFTS_PAGE_SIZE);
      const page = getPage(req);

      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'desc';

      const contracts = req.query.contract;
      const nfts = req.query.id;
      await db
        .fetchNFTs(pageSize, page, contracts, nfts, sortDir)
        .then(async (result) => {
          await returnPaginatedResult(
            transformPaginatedResponse(
              (orig: NFT & { has_distribution: boolean }): ApiNft => {
                const metadata = JSON.parse(orig.metadata!);
                return {
                  ...orig,
                  name: orig.name!,
                  token_type: orig.token_type as any,
                  uri: orig.uri ?? null,
                  thumbnail: orig.thumbnail!,
                  image: orig.image ?? null,
                  animation: orig.animation ?? null,
                  metadata: {
                    ...metadata,
                    animation_details:
                      typeof metadata.animation_details === 'string'
                        ? JSON.parse(metadata.animation_details)
                        : metadata.animation_details
                  },
                  scaled: orig.scaled!,
                  compressed_animation: orig.compressed_animation ?? null,
                  icon: orig.icon!,
                  mint_date: orig.mint_date ?? null
                };
              },
              result
            ),
            req,
            res
          );
        });
    }
  );

  apiRouter.get(
    `/nfts/gradients`,
    cacheRequest(),
    async function (req: any, res: any) {
      const id = req.query.id;
      const pageSize = getPageSize(req, NFTS_PAGE_SIZE);
      const page = getPage(req);

      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'asc';

      const sort =
        req.query.sort && ['id', 'tdh'].includes(req.query.sort)
          ? req.query.sort
          : 'id';

      await db
        .fetchGradients(id, pageSize, page, sort, sortDir)
        .then(async (result) => {
          result.data.map((d: any) => {
            d.metadata = JSON.parse(d.metadata);
          });
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/nfts/:contract/media`,
    cacheRequest(),
    async function (req: any, res: any) {
      const contract = req.params.contract;

      await db.fetchNFTMedia(contract).then(async (result) => {
        await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/nfts_memelab`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'desc';

      const nfts = req.query.id;
      const memeIds = req.query.meme_id;

      await db
        .fetchLabNFTs(memeIds, pageSize, page, nfts, sortDir)
        .then(async (result) => {
          result.data.map((d: any) => {
            d.meme_references = JSON.parse(d.meme_references);
            d.metadata = JSON.parse(d.metadata);
            if (
              d.metadata.animation_details &&
              typeof d.metadata.animation_details === 'string'
            ) {
              d.metadata.animation_details = JSON.parse(
                d.metadata.animation_details
              );
            }
          });
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/memes_extended_data`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req, NFTS_PAGE_SIZE);
      const page = getPage(req);

      const nfts = req.query.id;
      const seasons = req.query.season;

      const sort =
        req.query.sort && MEMES_EXTENDED_SORT.includes(req.query.sort)
          ? req.query.sort
          : MEMES_EXTENDED_SORT[0];

      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'desc';

      await db
        .fetchMemesExtended(pageSize, page, nfts, seasons, sort, sortDir)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/memes_seasons`,
    cacheRequest(),
    async function (req: any, res: any) {
      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'asc';

      await db.fetchMemesSeasons(sortDir).then(async (result) => {
        await returnPaginatedResult(result as unknown as any, req, res);
      });
    }
  );

  apiRouter.get(
    `/new_memes_seasons`,
    cacheRequest(),
    async function (req: any, res: any) {
      await db.fetchNewMemesSeasons().then(async (result) => {
        await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/memes_lite`,
    cacheRequest(),
    async function (req: any, res: any) {
      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'asc';

      await db.fetchMemesLite(sortDir).then(async (result) => {
        return await returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/memelab_lite`,
    cacheRequest(),
    async function (req: any, res: any) {
      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'asc';

      await db.fetchMemelabLite(sortDir).then(async (result) => {
        return await returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(`/test`, async function (req: any, res: any) {
    await appWebSockets.send({
      connectionId: req.query.p,
      message: 'Hello from server'
    });
    res.send('HEllo');
  });

  apiRouter.get(
    `/memes_latest`,
    cacheRequest(),
    async function (req: any, res: any) {
      await db.fetchMemesLatest().then(async (result) => {
        result.metadata = JSON.parse(result.metadata);
        result.metadata.animation_details =
          typeof result.metadata.animation_details === 'string'
            ? JSON.parse(result.metadata.animation_details)
            : result.metadata.animation_details;
        return await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/nfts_search`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const search = req.query.search;

      await db.searchNfts(search, pageSize).then(async (result) => {
        return await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/lab_extended_data`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const nfts = req.query.id;
      const collections = req.query.collection;

      await db
        .fetchLabExtended(pageSize, page, nfts, collections)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/transactions`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiTransactionPage>>) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const wallets = req.query.wallet;
      const contracts = req.query.contract;
      const nfts = req.query.id;

      const filter =
        req.query.filter && TRANSACTION_FILTERS.includes(req.query.filter)
          ? req.query.filter
          : null;
      await db
        .fetchTransactions(pageSize, page, wallets, contracts, nfts, filter)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/transactions/:hash`,
    cacheRequest(),
    async function (req: any, res: any) {
      const hash = req.params.hash;
      await db.fetchTransactionByHash(hash).then(async (result) => {
        if (result.data.length == 1) {
          await returnJsonResult(result.data[0], req, res);
        } else {
          await returnJsonResult({}, req, res);
        }
      });
    }
  );

  apiRouter.get(
    `/transactions_memelab`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const wallets = req.query.wallet;
      const nfts = req.query.id;

      const filter =
        req.query.filter && TRANSACTION_FILTERS.includes(req.query.filter)
          ? req.query.filter
          : null;

      await db
        .fetchLabTransactions(pageSize, page, wallets, nfts, filter)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/tdh/gradients/`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);
      await db.fetchGradientTdh(pageSize, page).then(async (result) => {
        result = parseTdhResultsFromDB(result);
        await returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/ens/:address/`,
    cacheRequest(),
    async function (req: any, res: any) {
      const address = req.params.address;

      await db.fetchEns(address).then(async (result) => {
        if (result.length == 1) {
          await returnJsonResult(result[0], req, res);
        } else {
          await returnJsonResult({}, req, res);
        }
      });
    }
  );

  apiRouter.get(`/team`, cacheRequest(), async function (req: any, res: any) {
    const pageSize = getPageSize(req);
    const page = getPage(req);

    await db.fetchTeam(pageSize, page).then(async (result) => {
      await returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(
    `/consolidations/:wallet`,
    cacheRequest(),
    async function (req: any, res: any) {
      const wallet = req.params.wallet;
      const showIncomplete = !!(
        req.query.show_incomplete && req.query.show_incomplete == 'true'
      );
      await db
        .fetchConsolidationsForWallet(wallet, showIncomplete)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/consolidations`,
    cacheRequest(),
    async function (req: any, res: any) {
      const block = req.query.block;
      const pageSize = getPageSize(req, DEFAULT_MAX_SIZE);
      const page = getPage(req);

      await db
        .fetchConsolidations(pageSize, page, block)
        .then(async (result) => {
          result.data.map((a: any) => {
            a.wallets = JSON.parse(a.wallets);
          });
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/consolidation_transactions`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);

      const block = req.query.block;
      const showIncomplete = !!(
        req.query.show_incomplete && req.query.show_incomplete == 'true'
      );
      await db
        .fetchConsolidationTransactions(pageSize, page, block, showIncomplete)
        .then(async (result) => {
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/nft_history/:contract/:nft_id`,
    cacheRequest(),
    async function (req: any, res: any) {
      const contract = req.params.contract;
      const nftId = req.params.nft_id;

      const pageSize = getPageSize(req);
      const page = getPage(req);

      await db
        .fetchNftHistory(pageSize, page, contract, nftId)
        .then(async (result) => {
          result.data.map((a: any) => {
            a.description = JSON.parse(a.description);
          });
          await returnPaginatedResult(result, req, res);
        });
    }
  );

  rootRouter.get(
    `/floor_price`,
    cacheRequest(),
    async function (req: any, res: any) {
      const contract = req.query.contract;
      const id = req.query.id;

      if (!contract || !id) {
        res.status(400).send('Missing contract or id');
        return;
      }
      const url = `https://api.opensea.io/v2/orders/ethereum/seaport/listings?asset_contract_address=${contract}&limit=1&token_ids=${id}&order_by=eth_price&order_direction=asc`;
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': process.env.OPENSEA_API_KEY!,
          accept: 'application/json'
        }
      });
      const json = await response.json();
      return res.send(json);
    }
  );

  apiRouter.get(
    `/rememes_uploads`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
      const page = getPage(req);

      await db.fetchRememesUploads(pageSize, page).then(async (result) => {
        result.data.forEach((e: any) => {
          e.date = e.created_at;
          delete e.created_at;
        });
        await returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/tdh_global_history`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
      const page = getPage(req);
      await db.fetchTDHGlobalHistory(pageSize, page).then(async (result) => {
        result.data.map((d: any) => {
          const date = new Date(d.date);
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const day = String(date.getUTCDate()).padStart(2, '0');
          d.date = `${year}-${month}-${day}`;
        });
        await returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/recent_tdh_history/:consolidation_key`,
    cacheRequest(),
    async function (req: any, res: any) {
      const consolidationKey = req.params.consolidation_key;
      await db.fetchRecentTDHHistory(consolidationKey).then(async (result) => {
        result.map((d: any) => {
          if (d.wallets && !Array.isArray(d.wallets)) {
            d.wallets = JSON.parse(d.wallets);
          }
          const date = new Date(d.date);
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          d.date = `${year}-${month}-${day}`;
        });
        await returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(``, async function (req: any, res: any) {
    const image = await db.fetchRandomImage();
    await returnJsonResult(
      {
        message: 'WELCOME TO 6529 API',
        health: '/health',
        image: image[0].scaled ? image[0].scaled : image[0].image
      },
      req,
      res
    );
  });

  rootRouter.get('/health', async (req, res) => {
    const healthData = await getHealthData();

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.json(healthData);
  });

  rootRouter.post('/gh-hooks', async (req: any, res: any) => {
    function timingSafeEqual(a: string, b: string) {
      const aBuf = Buffer.from(a);
      const bBuf = Buffer.from(b);
      if (aBuf.length !== bBuf.length) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    }
    const body = req.body;
    const action = body?.action;
    const html_url = body?.issue?.html_url;
    const sig256 = req.get('x-hub-signature-256');
    if (!sig256) {
      return res.status(400).send('Missing x-hub-signature-256');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      return res.status(500).send('Raw body not available');
    }
    const expected =
      'sha256=' +
      crypto
        .createHmac('sha256', env.getStringOrThrow(`GH_WEBHOOK_SECRET`))
        .update(rawBody)
        .digest('hex');
    if (!timingSafeEqual(expected, sig256)) {
      return res.status(401).send('Invalid signature');
    }
    if (action === 'opened' && html_url) {
      const redis = getRedisClient();
      if (redis) {
        const cacheKey = `gh-webhook:${html_url}`;
        const wasSet = await redis.set(cacheKey, '1', { NX: true, EX: 86400 });
        if (!wasSet) {
          logger.info(`Duplicate webhook for ${html_url}, skipping`);
          return res.send({});
        }
      }
      logger.info(`New issue was opened: ${html_url}`);
      try {
        await githubIssueDropService.postGhIssueDrop(html_url);
      } catch (err) {
        logger.error(`Failed to post drop for issue ${html_url}: ${err}`);
      }
    }
    res.send({});
  });

  rootRouter.get('/health/ui', async (req, res) => {
    const healthData = await getHealthData();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const html = renderHealthUI(healthData, baseUrl);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'text/html');

    return res.send(html);
  });

  rootRouter.get('/favicon.svg', async (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(LOGO_SVG);
  });

  rootRouter.get(``, async function (req: any, res: any) {
    const image = await db.fetchRandomImage();
    await returnJsonResult(
      {
        message: 'WELCOME TO 6529 API',
        api: '/api',
        health: '/health',
        image: image[0].scaled ? image[0].scaled : image[0].image
      },
      req,
      res
    );
  });

  apiRouter.use(`/boosted-drops`, boostedDropsRoutes);
  apiRouter.use(`/drops-bookmarked`, bookmarkedDropsRoutes);
  apiRouter.use(`/feed`, feedRoutes);
  apiRouter.use(`/notifications`, notificationsRoutes);
  apiRouter.use(`/identity-subscriptions`, identitySubscriptionsRoutes);
  apiRouter.use(`/waves-overview`, wavesOverviewRoutes);
  apiRouter.use(`/identities`, identitiesRoutes);
  apiRouter.use(`/profiles`, profilesRoutes);
  apiRouter.use(`/community-members`, communityMembersRoutes);
  apiRouter.use(`/community-metrics`, communityMetricsRoutes);
  apiRouter.use(`/groups`, userGroupsRoutes);
  apiRouter.use(`/groups_im_eligible_for`, userGroupsImEligibleForRoutes);
  apiRouter.use(`/auth`, authRoutes);
  apiRouter.use(`/rememes`, rememesRoutes);
  apiRouter.use(`/nextgen`, nextgenRoutes);
  apiRouter.use(`/gas`, gasRoutes);
  apiRouter.use(`/royalties`, royaltiesRoutes);
  apiRouter.use(`/profile-logs`, profileActivityLogsRoutes);
  apiRouter.use(`/rep/categories`, repCategorySearchRoutes);
  apiRouter.use(`/tdh`, tdhRoutes);
  apiRouter.use(`/tdh-editions`, tdhEditionsRoutes);
  apiRouter.use(`/aggregated-activity`, aggregatedActivityRoutes);
  apiRouter.use(`/owners-balances`, ownersBalancesRoutes);
  apiRouter.use(`/ratings`, ratingsRoutes);
  apiRouter.use(`/bulk-rep`, bulkRepRoutes);
  apiRouter.use(`/proxies`, proxiesRoutes);
  apiRouter.use(`/subscriptions`, subscriptionsRoutes);
  apiRouter.use(`/drops`, dropsRoutes);
  apiRouter.use(`/light-drops`, lightDropsRoutes);
  apiRouter.use(`/nft-owners`, nftOwnersRoutes);
  apiRouter.use(`/drop-media`, dropsMediaRoutes);
  apiRouter.use(`/wave-media`, waveMediaRoutes);
  apiRouter.use(`/profile-subclassifications`, profileSubClassificationsRoutes);
  apiRouter.use(`/delegations`, delegationsRoutes);
  apiRouter.use(`/distribution_photos`, distributionPhotosRoutes);
  apiRouter.use(``, distributionsRoutes);
  apiRouter.use(`/waves`, wavesRoutes);
  apiRouter.use(`/public/waves`, publicWavesRoutes);
  apiRouter.use(`/policies`, policiesRoutes);
  apiRouter.use(`/push-notifications`, pushNotificationsRoutes);
  apiRouter.use(`/xtdh`, xtdhRoutes);

  rootRouter.use(BASE_PATH, apiRouter);
  rootRouter.use(`/oracle`, oracleRoutes);
  rootRouter.use(`/rpc`, rpcRoutes);
  rootRouter.use(`/sitemap`, sitemapRoutes);
  rootRouter.use(`/alchemy-proxy`, alchemyProxyRoutes);

  // Apply rate limiting after cache check (cached responses bypass rate limiting)
  app.use(rateLimitingMiddleware());
  app.use(rootRouter);

  app.use(customErrorMiddleware());

  const swaggerDocument = YAML.load('openapi.yaml');
  app.use(
    '/docs',
    SwaggerUI.serve,
    SwaggerUI.setup(
      swaggerDocument,
      {
        customSiteTitle: '6529 API Docs',
        customCss: '.topbar { display: none }',
        customfavIcon: '/favicon.svg'
      },
      { explorer: true }
    )
  );

  if (sentryContext.isConfigured()) {
    app.use(Sentry.Handlers.errorHandler());
    app.use(sentryFlusherMiddleware());
  }

  if (process.env.NODE_ENV === 'local') {
    const localWebSocketLogger = Logger.get('LocalWebSocket');
    const httpServer = http.createServer(app);
    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', async (socket: WebSocket, request) => {
      const connectionId = randomUUID();
      try {
        const event = mapHttpRequestToGatewayEvent(
          request,
          connectionId,
          '$connect'
        );
        const { identityId, jwtExpiry } =
          await authenticateWebSocketJwtOrGetByConnectionId(event);
        await appWebSockets.register({
          identityId,
          connectionId,
          jwtExpiry,
          ws: socket
        });

        socket.send(JSON.stringify({ routeKey: '$connect', connected: true }));

        socket.on('message', async (rawData) => {
          try {
            const message = JSON.parse(rawData.toString());

            switch (message.type) {
              case WsMessageType.SUBSCRIBE_TO_WAVE: {
                const waveId = message.wave_id?.toString() ?? null;
                if (waveId && !ids.isValidUuid(waveId)) {
                  socket.send(
                    JSON.stringify({
                      error: 'Invalid waveId'
                    })
                  );
                  return;
                }
                await appWebSockets.updateActiveWaveForConnection(
                  { connectionId, activeWaveId: waveId },
                  {}
                );
                socket.send(JSON.stringify({ message: 'OK' }));
                break;
              }
              case WsMessageType.USER_IS_TYPING: {
                const waveId = message.wave_id?.toString();
                if (!waveId || !ids.isValidUuid(waveId)) {
                  socket.send(
                    JSON.stringify({
                      error: 'Invalid wave id'
                    })
                  );
                } else {
                  await wsListenersNotifier.notifyAboutUserIsTyping({
                    identityId,
                    waveId
                  });
                }
                break;
              }
              default:
                socket.send(
                  JSON.stringify({
                    error: 'Unrecognized action'
                  })
                );
            }
          } catch (err) {
            socket.send(
              JSON.stringify({
                error: 'Failed to process message'
              })
            );
          }
        });

        socket.on('close', () => {
          appWebSockets.deregister({ connectionId });
        });
      } catch (err) {
        localWebSocketLogger.error(
          `$connect FAILED (connId = ${connectionId}): ${err}`
        );
        socket.close();
      }
    });

    httpServer.listen(API_PORT, () => {
      logger.info(`[CONFIG local] [LOCAL DEV SERVER + WS on port ${API_PORT}]`);
    });
  } else {
    app.listen(API_PORT, function () {
      logger.info(
        `[CONFIG ${process.env.NODE_ENV}] [SERVER RUNNING ON PORT ${API_PORT}] WARNING! Websockets are not set up in expressjs level. This is ok if they are set up in some other layer or if you don't care about websockets.`
      );
    });
  }
}

function initializationGuard() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isInitialized) {
      return next();
    }
    try {
      await initializationPromise;
      return next();
    } catch (err) {
      logger.error('[REQUEST DURING FAILED INIT]', err);
      return res.status(500).json({ error: 'Initialization failed' });
    }
  };
}

app.use(initializationGuard());

const initializationPromise = initializeApp()
  .then(() => {
    isInitialized = true;
  })
  .catch((err) => {
    logger.error(`[INITIALIZATION FAILED] ${err}`);
    throw err;
  });

export { app };

import fetch from 'node-fetch';
import * as db from '../../db-api';
import { isNumber, uniqueShortId } from '../../helpers';

import feedRoutes from './feed/feed.routes';
import identitiesRoutes from './identities/identities.routes';
import profilesRoutes from './profiles/profiles.routes';
import authRoutes from './auth/auth.routes';
import proxiesRoutes from './proxies/proxies.routes';
import rememesRoutes from './rememes/rememes.routes';
import nextgenRoutes from './nextgen/nextgen.routes';
import analyticsRoutes from './analytics/analytics.routes';
import royaltiesRoutes from './royalties/royalties.routes';
import profileActivityLogsRoutes from './profiles/profile-activity-logs.routes';
import repCategorySearchRoutes from './profiles/rep-category-search.routes';
import ratingsRoutes from './ratings/ratings.routes';
import bulkRepRoutes from './ratings/bulk-rep.routes';
import gasRoutes from './gas/gas.routes';
import tdhRoutes from './tdh/api.tdh.routes';
import oracleRoutes from './oracle/api.oracle.routes';
import aggregatedActivityRoutes from './aggregated-activity/api.aggregated-activity.routes';
import ownersBalancesRoutes from './owners-balances/api.owners-balances.routes';
import communityMembersRoutes from './community-members/community-members.routes';
import userGroupsRoutes from './community-members/user-groups.routes';
import dropsRoutes from './drops/drops.routes';
import nftOwnersRoutes from './nft-owners/api.nft-owners.routes';
import dropsMediaRoutes from './drops/drops-media.routes';
import profileSubClassificationsRoutes from './profiles/profiles-sub-classifications.routes';
import delegationsRoutes from './delegations/delegations.routes';
import wavesRoutes from './waves/waves.routes';
import publicWavesRoutes from './waves/waves-public.routes';
import policiesRoutes from './policies/policies.routes';
import notificationsRoutes from './notifications/notifications.routes';
import waveMediaRoutes from './waves/wave-media.routes';
import wavesOverviewRoutes from './waves/waves-overview.routes';
import identitySubscriptionsRoutes from './identity-subscriptions/identity-subscriptions.routes';
import pushNotificationsRoutes from './push-notifications/push-notifications.routes';

import * as passport from 'passport';
import {
  ExtractJwt,
  Strategy as JwtStrategy,
  VerifiedCallback
} from 'passport-jwt';
import { getJwtSecret } from './auth/auth';
import { NextFunction, Request, Response } from 'express';
import { Time, Timer } from '../../time';
import * as sentryContext from '../../sentry.context';
import * as Sentry from '@sentry/serverless';
import { asyncRouter } from './async.router';
import { ApiCompliantException } from '../../exceptions';

import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import { Logger } from '../../logging';
import * as awsServerlessExpressMiddleware from 'aws-serverless-express/middleware';
import * as process from 'process';
import * as mcache from 'memory-cache';
import {
  cacheKey,
  returnJsonResult,
  returnPaginatedResult,
  transformPaginatedResponse
} from './api-helpers';
import {
  corsOptions,
  DEFAULT_PAGE_SIZE,
  DISTRIBUTION_PAGE_SIZE,
  NFTS_PAGE_SIZE,
  SEIZE_SETTINGS,
  SORT_DIRECTIONS
} from './api-constants';
import { MEMES_EXTENDED_SORT, TRANSACTION_FILTERS } from './api-filters';
import { parseTdhResultsFromDB } from '../../sql_helpers';
import { loadLocalConfig, loadSecrets } from '../../env';
import subscriptionsRoutes from './subscriptions/api.subscriptions.routes';
import * as SwaggerUI from 'swagger-ui-express';
import { DEFAULT_MAX_SIZE } from './page-request';
import { ApiResponse } from './api-response';
import { ApiBlockItem } from './generated/models/ApiBlockItem';
import { TDHBlock } from '../../entities/ITDH';
import { ApiBlocksPage } from './generated/models/ApiBlocksPage';
import { ApiSeizeSettings } from './generated/models/ApiSeizeSettings';
import { ApiUploadsPage } from './generated/models/ApiUploadsPage';
import { Upload } from '../../entities/IUpload';
import { ApiUploadItem } from './generated/models/ApiUploadItem';
import { ApiArtistsPage } from './generated/models/ApiArtistsPage';
import { Artist } from '../../entities/IArtist';
import { ApiArtistItem } from './generated/models/ApiArtistItem';
import { ApiNftsPage } from './generated/models/ApiNftsPage';
import { NFT } from '../../entities/INFT';
import { ApiNft } from './generated/models/ApiNft';
import { ApiArtistNameItem } from './generated/models/ApiArtistNameItem';
import { ApiTransactionPage } from './generated/models/ApiTransactionPage';
import { initRedis, redisCached } from '../../redis';
import rpcRoutes from './rpc/rpc.routes';

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
      request.apiGateway?.context?.awsRequestId ?? uniqueShortId();
    Logger.registerAwsRequestId(requestId);
    const { method, originalUrl: url } = request;
    const uqKey = `${method} ${url}`;
    const timer = new Timer(uqKey);
    (request as any).timer = timer;
    response.on('close', () => {
      const { statusCode } = response;
      if (
        timer.getTotalTimePassed().gt(Time.seconds(1)) &&
        timer.hasStoppedTimers()
      ) {
        requestLogger.info(
          `[METHOD ${method}] [PATH ${url}] [RESPONSE_STATUS ${statusCode}] [TOOK_MS ${timer
            .getTotalTimePassed()
            .toMillis()}] [${timer.getReport()}]`
        );
      } else if (
        process.env.LOG_LEVEL_API_REQUEST === 'debug' &&
        timer.hasStoppedTimers()
      ) {
        requestLogger.debug(
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

async function loadApiSecrets() {
  if (process.env.API_LOAD_SECRETS === 'true') {
    await loadSecrets();
  }
}

async function loadApi() {
  await loadLocalConfig();
  await initRedis();
  await db.connect();
}

loadApi().then(() => {
  logger.info(
    `[DB HOST ${process.env.DB_HOST_READ}] [API PASSWORD ACTIVE ${process.env.ACTIVATE_API_PASSWORD}] [LOAD SECRETS ENABLED ${process.env.API_LOAD_SECRETS}]`
  );

  loadApiSecrets().then(() => {
    passport.use(
      new JwtStrategy(
        {
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          secretOrKey: getJwtSecret()
        },
        function (
          { sub: wallet, role }: { sub: string; role?: string },
          cb: VerifiedCallback
        ) {
          return cb(null, { wallet: wallet, role });
        }
      )
    );
  });
  passport.use(new AnonymousStrategy());
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Only enabled in AWS Lambda
    app.use(awsServerlessExpressMiddleware.eventContext());
  }
  app.use(requestLogMiddleware());
  app.use(compression());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '5mb' }));
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
        returnJsonResult(
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

  const checkCache = function (req: any, res: any, next: any) {
    const key = cacheKey(req);

    const cachedBody = mcache.get(key);
    if (cachedBody) {
      returnPaginatedResult(cachedBody, req, res, true);
    } else {
      next();
    }
  };

  const BASE_PATH = '/api';
  const apiRouter = asyncRouter();

  app.all(`${BASE_PATH}*`, requireLogin);
  app.all(`${BASE_PATH}*`, checkCache);

  apiRouter.get(
    `/blocks`,
    function (req: any, res: Response<ApiResponse<ApiBlocksPage>>) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;
      db.fetchBlocks(pageSize, page).then((result) => {
        returnPaginatedResult(
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
    function (req: any, res: Response<ApiResponse<ApiSeizeSettings>>) {
      const settingsResp: ApiSeizeSettings = {
        rememes_submission_tdh_threshold:
          SEIZE_SETTINGS.rememes_submission_tdh_threshold
      };
      returnJsonResult(settingsResp, req, res);
    }
  );

  apiRouter.get(
    `/uploads`,
    function (req: any, res: Response<ApiResponse<ApiUploadsPage>>) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;
      const block = isNumber(req.query.block) ? parseInt(req.query.block) : 0;
      const date = req.query.date;
      db.fetchUploads(pageSize, page, block, date).then((result) => {
        returnPaginatedResult(
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
    function (req: any, res: Response<ApiResponse<ApiUploadsPage>>) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;
      const block = isNumber(req.query.block) ? parseInt(req.query.block) : 0;
      const date = req.query.date;
      db.fetchConsolidatedUploads(pageSize, page, block, date).then(
        (result) => {
          returnPaginatedResult(
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
        }
      );
    }
  );

  apiRouter.get(
    `/artists`,
    function (req: any, res: Response<ApiResponse<ApiArtistsPage>>) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const meme_nfts = req.query.meme_id;

      db.fetchArtists(pageSize, page, meme_nfts).then((result) => {
        returnPaginatedResult(
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
    function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      db.fetchArtistsNamesMemes().then((result) => {
        return returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/memelab/artists_names`,
    function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      db.fetchArtistsNamesMemeLab().then((result) => {
        return returnJsonResult(result, req, res);
      });
    }
  );

  apiRouter.get(`/nfts`, function (req: any, res: Response<ApiNftsPage>) {
    const pageSize: number =
      req.query.page_size && req.query.page_size <= NFTS_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const sortDir =
      req.query.sort_direction &&
      SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
        ? req.query.sort_direction
        : 'desc';

    const contracts = req.query.contract;
    const nfts = req.query.id;
    db.fetchNFTs(pageSize, page, contracts, nfts, sortDir).then((result) => {
      returnPaginatedResult(
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
              icon: orig.icon!
            };
          },
          result
        ),
        req,
        res
      );
    });
  });

  apiRouter.get(`/nfts/gradients`, function (req: any, res: any) {
    const id = req.query.id;
    const pageSize: number =
      req.query.page_size && req.query.page_size <= NFTS_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const sortDir =
      req.query.sort_direction &&
      SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
        ? req.query.sort_direction
        : 'asc';

    const sort =
      req.query.sort && ['id', 'tdh'].includes(req.query.sort)
        ? req.query.sort
        : 'id';

    db.fetchGradients(id, pageSize, page, sort, sortDir).then((result) => {
      result.data.map((d: any) => {
        d.metadata = JSON.parse(d.metadata);
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/nfts/:contract/media`, function (req: any, res: any) {
    const contract = req.params.contract;

    db.fetchNFTMedia(contract).then((result) => {
      returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/nfts_memelab`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const sortDir =
      req.query.sort_direction &&
      SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
        ? req.query.sort_direction
        : 'desc';

    const nfts = req.query.id;
    const memeIds = req.query.meme_id;

    db.fetchLabNFTs(memeIds, pageSize, page, nfts, sortDir).then((result) => {
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
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/memes_extended_data`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size <= NFTS_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

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

    db.fetchMemesExtended(pageSize, page, nfts, seasons, sort, sortDir).then(
      (result) => {
        returnPaginatedResult(result, req, res);
      }
    );
  });

  apiRouter.get(`/memes_seasons`, function (req: any, res: any) {
    const sortDir =
      req.query.sort_direction &&
      SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
        ? req.query.sort_direction
        : 'asc';

    db.fetchMemesSeasons(sortDir).then((result) => {
      returnPaginatedResult(result as unknown as any, req, res);
    });
  });

  apiRouter.get(`/new_memes_seasons`, function (req: any, res: any) {
    db.fetchNewMemesSeasons().then((result) => {
      returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/memes_lite`, function (req: any, res: any) {
    const sortDir =
      req.query.sort_direction &&
      SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
        ? req.query.sort_direction
        : 'asc';

    db.fetchMemesLite(sortDir).then((result) => {
      return returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/memes_latest`, function (req: any, res: any) {
    db.fetchMemesLatest().then((result) => {
      result.metadata = JSON.parse(result.metadata);
      result.metadata.animation_details =
        typeof result.metadata.animation_details === 'string'
          ? JSON.parse(result.metadata.animation_details)
          : result.metadata.animation_details;
      return returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/nfts_search`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;

    const search = req.query.search;

    db.searchNfts(search, pageSize).then((result) => {
      return returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/lab_extended_data`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const nfts = req.query.id;
    const collections = req.query.collection;

    db.fetchLabExtended(pageSize, page, nfts, collections).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(
    `/transactions`,
    function (req: any, res: Response<ApiResponse<ApiTransactionPage>>) {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const wallets = req.query.wallet;
      const contracts = req.query.contract;
      const nfts = req.query.id;

      const filter =
        req.query.filter && TRANSACTION_FILTERS.includes(req.query.filter)
          ? req.query.filter
          : null;
      db.fetchTransactions(
        pageSize,
        page,
        wallets,
        contracts,
        nfts,
        filter
      ).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(`/transactions/:hash`, function (req: any, res: any) {
    const hash = req.params.hash;
    db.fetchTransactionByHash(hash).then((result) => {
      if (result.data.length == 1) {
        returnJsonResult(result.data[0], req, res);
      } else {
        returnJsonResult({}, req, res);
      }
    });
  });

  apiRouter.get(`/transactions_memelab`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const wallets = req.query.wallet;
    const nfts = req.query.id;

    const filter =
      req.query.filter && TRANSACTION_FILTERS.includes(req.query.filter)
        ? req.query.filter
        : null;

    db.fetchLabTransactions(pageSize, page, wallets, nfts, filter).then(
      (result) => {
        returnPaginatedResult(result, req, res);
      }
    );
  });

  apiRouter.get(`/tdh/gradients/`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    db.fetchGradientTdh(pageSize, page).then((result) => {
      result = parseTdhResultsFromDB(result);
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/ens/:address/`, function (req: any, res: any) {
    const address = req.params.address;

    db.fetchEns(address).then((result) => {
      if (result.length == 1) {
        returnJsonResult(result[0], req, res);
      } else {
        returnJsonResult({}, req, res);
      }
    });
  });

  apiRouter.get(`/team`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    db.fetchTeam(pageSize, page).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(
    `/distribution_photos/:contract/:nft_id`,
    function (req: any, res: any) {
      const contract = req.params.contract;
      const nftId = req.params.nft_id;

      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      db.fetchDistributionPhotos(contract, nftId, pageSize, page).then(
        (result) => {
          returnPaginatedResult(result, req, res);
        }
      );
    }
  );

  apiRouter.get(
    `/distribution_phases/:contract/:nft_id`,
    function (req: any, res: any) {
      const contract = req.params.contract;
      const nftId = req.params.nft_id;
      db.fetchDistributionPhases(contract, nftId).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(`/distributions`, function (req: any, res: any) {
    const search = req.query.search;
    const cards = req.query.card_id;
    const contracts = req.query.contract;

    const pageSize: number =
      req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    db.fetchDistributions(search, cards, contracts, pageSize, page).then(
      (result) => {
        returnPaginatedResult(result, req, res);
      }
    );
  });

  apiRouter.get(`/consolidations/:wallet`, function (req: any, res: any) {
    const wallet = req.params.wallet;
    const showIncomplete = !!(
      req.query.show_incomplete && req.query.show_incomplete == 'true'
    );
    db.fetchConsolidationsForWallet(wallet, showIncomplete).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/consolidations`, function (req: any, res: any) {
    const block = req.query.block;
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_MAX_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    db.fetchConsolidations(pageSize, page, block).then((result) => {
      result.data.map((a: any) => {
        a.wallets = JSON.parse(a.wallets);
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/consolidation_transactions`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const block = req.query.block;
    const showIncomplete = !!(
      req.query.show_incomplete && req.query.show_incomplete == 'true'
    );
    db.fetchConsolidationTransactions(
      pageSize,
      page,
      block,
      showIncomplete
    ).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(
    `/nft_history/:contract/:nft_id`,
    function (req: any, res: any) {
      const contract = req.params.contract;
      const nftId = req.params.nft_id;

      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      db.fetchNftHistory(pageSize, page, contract, nftId).then((result) => {
        result.data.map((a: any) => {
          a.description = JSON.parse(a.description);
        });
        returnPaginatedResult(result, req, res);
      });
    }
  );

  rootRouter.get(`/floor_price`, async function (req: any, res: any) {
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
  });

  apiRouter.get(`/rememes_uploads`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    db.fetchRememesUploads(pageSize, page).then((result) => {
      result.data.forEach((e: any) => {
        e.date = e.created_at;
        delete e.created_at;
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/tdh_global_history`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    db.fetchTDHGlobalHistory(pageSize, page).then((result) => {
      result.data.map((d: any) => {
        const date = new Date(d.date);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        d.date = `${year}-${month}-${day}`;
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/tdh_history`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    const wallets = req.query.wallet;
    db.fetchTDHHistory(wallets, pageSize, page).then((result) => {
      result.data.map((d: any) => {
        d.wallets = JSON.parse(d.wallets);
        const date = new Date(d.date);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        d.date = `${year}-${month}-${day}`;
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(``, async function (req: any, res: any) {
    const image = await db.fetchRandomImage();
    returnJsonResult(
      {
        message: 'FOR 6529 SEIZE API GO TO /api',
        image: image[0].scaled ? image[0].scaled : image[0].image
      },
      req,
      res
    );
  });

  apiRouter.get(`/redis-test`, async function (_: any, res: any) {
    const result = await redisCached(
      `redis-rest`,
      Time.minutes(10),
      async () => {
        return {
          message: `Testing Redis. Message composed ${Time.now().toIsoDateTimeString()}`
        };
      }
    );
    res.send(result);
  });

  rootRouter.get(``, async function (req: any, res: any) {
    const image = await db.fetchRandomImage();
    returnJsonResult(
      {
        message: 'FOR 6529 SEIZE API GO TO /api',
        image: image[0].scaled ? image[0].scaled : image[0].image
      },
      req,
      res
    );
  });

  apiRouter.use(`/feed`, feedRoutes);
  apiRouter.use(`/notifications`, notificationsRoutes);
  apiRouter.use(`/identity-subscriptions`, identitySubscriptionsRoutes);
  apiRouter.use(`/waves-overview`, wavesOverviewRoutes);
  apiRouter.use(`/identities`, identitiesRoutes);
  apiRouter.use(`/profiles`, profilesRoutes);
  apiRouter.use(`/analytics`, analyticsRoutes);
  apiRouter.use(`/community-members`, communityMembersRoutes);
  apiRouter.use(`/groups`, userGroupsRoutes);
  apiRouter.use(`/auth`, authRoutes);
  apiRouter.use(`/rememes`, rememesRoutes);
  apiRouter.use(`/nextgen`, nextgenRoutes);
  apiRouter.use(`/gas`, gasRoutes);
  apiRouter.use(`/royalties`, royaltiesRoutes);
  apiRouter.use(`/profile-logs`, profileActivityLogsRoutes);
  apiRouter.use(`/rep/categories`, repCategorySearchRoutes);
  apiRouter.use(`/tdh`, tdhRoutes);
  apiRouter.use(`/aggregated-activity`, aggregatedActivityRoutes);
  apiRouter.use(`/owners-balances`, ownersBalancesRoutes);
  apiRouter.use(`/ratings`, ratingsRoutes);
  apiRouter.use(`/bulk-rep`, bulkRepRoutes);
  apiRouter.use(`/proxies`, proxiesRoutes);
  apiRouter.use(`/subscriptions`, subscriptionsRoutes);
  apiRouter.use(`/drops`, dropsRoutes);
  apiRouter.use(`/nft-owners`, nftOwnersRoutes);
  apiRouter.use(`/drop-media`, dropsMediaRoutes);
  apiRouter.use(`/wave-media`, waveMediaRoutes);
  apiRouter.use(`/profile-subclassifications`, profileSubClassificationsRoutes);
  apiRouter.use(`/delegations`, delegationsRoutes);
  apiRouter.use(`/waves`, wavesRoutes);
  apiRouter.use(`/public/waves`, publicWavesRoutes);
  apiRouter.use(`/policies`, policiesRoutes);
  apiRouter.use(`/push-notifications`, pushNotificationsRoutes);

  rootRouter.use(BASE_PATH, apiRouter);
  rootRouter.use(`/oracle`, oracleRoutes);
  rootRouter.use(`/rpc`, rpcRoutes);
  app.use(rootRouter);

  app.use(customErrorMiddleware());

  const swaggerDocument = YAML.load('openapi.yaml');
  app.use(
    '/docs',
    SwaggerUI.serve,
    SwaggerUI.setup(
      swaggerDocument,
      {
        customSiteTitle: 'Seize API Docs',
        customCss: '.topbar { display: none }'
      },
      { explorer: true }
    )
  );

  if (sentryContext.isConfigured()) {
    app.use(Sentry.Handlers.errorHandler());
    app.use(sentryFlusherMiddleware());
  }

  app.listen(API_PORT, function () {
    logger.info(
      `[CONFIG ${process.env.NODE_ENV}] [SERVER RUNNING ON PORT ${API_PORT}]`
    );
  });
});

export { app };

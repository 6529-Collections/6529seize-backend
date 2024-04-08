import fetch from 'node-fetch';
import * as db from '../../db-api';
import { isNumber } from '../../helpers';

import profilesRoutes from './profiles/profiles.routes';
import authRoutes from './auth/auth.routes';
import rememesRoutes from './rememes/rememes.routes';
import nextgenRoutes from './nextgen/nextgen.routes';
import analyticsRoutes from './analytics/analytics.routes';
import royaltiesRoutes from './royalties/royalties.routes';
import profileActivityLogsRoutes from './profiles/profile-activity-logs.routes';
import repCategorySearchRoutes from './profiles/rep-category-search.routes';
import ratingsRoutes from './ratings/ratings.routes';
import gasRoutes from './gas/gas.routes';
import tdhRoutes from './tdh/api.tdh.routes';
import aggregatedActivityRoutes from './aggregated-activity/api.aggregated-activity.routes';
import ownersBalancesRoutes from './owners-balances/api.owners-balances.routes';
import communityMembersRoutes from './community-members/community-members.routes';
import communityMembersCurationRoutes from './community-members/community-members-curation.routes';
import dropsRoutes from './drops/drops.routes';
import nftOwnersRoutes from './nft-owners/api.nft-owners.routes';
import * as passport from 'passport';
import {
  ExtractJwt,
  Strategy as JwtStrategy,
  VerifiedCallback
} from 'passport-jwt';
import { getJwtSecret } from './auth/auth';
import { NextFunction, Request, Response } from 'express';
import { Time } from '../../time';
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
  returnPaginatedResult
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

const requestLogger = Logger.get('API_REQUEST');
const logger = Logger.get('API');

function requestLogMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    Logger.registerAwsRequestId(request.apiGateway?.context?.awsRequestId);
    const { method, originalUrl: url } = request;
    const start = Time.now();
    response.on('close', () => {
      const { statusCode } = response;
      requestLogger.info(
        `${method} ${url} - Response status: HTTP_${statusCode} - Running time: ${start.diffFromNow()}`
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

function sentryFlusherMiddleware() {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    Sentry.flush(Time.seconds(2).toMillis()).then(() => {
      next(err);
    });
  };
}

const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const rootRouter = asyncRouter();

const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

async function loadApiSecrets() {
  if (process.env.API_LOAD_SECRETS === 'true') {
    await loadSecrets();
  }
}

async function loadApi() {
  await loadLocalConfig();
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
        function ({ sub: wallet }: { sub: string }, cb: VerifiedCallback) {
          return cb(null, { wallet: wallet });
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
  app.use(express.json());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
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

  apiRouter.get(`/blocks`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    db.fetchBlocks(pageSize, page).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/settings`, function (req: any, res: any) {
    returnJsonResult(SEIZE_SETTINGS, req, res);
  });

  apiRouter.get(`/uploads`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    const block = isNumber(req.query.block) ? parseInt(req.query.block) : 0;
    const date = req.query.date;
    db.fetchUploads(pageSize, page, block, date).then((result) => {
      result.data.forEach((e: any) => {
        e.url = e.tdh;
        delete e.tdh;
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/consolidated_uploads`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    const block = isNumber(req.query.block) ? parseInt(req.query.block) : 0;
    const date = req.query.date;
    db.fetchConsolidatedUploads(pageSize, page, block, date).then((result) => {
      result.data.forEach((e: any) => {
        e.url = e.tdh;
        delete e.tdh;
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/artists`, function (req: any, res: any) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    const meme_nfts = req.query.meme_id;

    db.fetchArtists(pageSize, page, meme_nfts).then((result) => {
      result.data.map((a: any) => {
        a.memes = JSON.parse(a.memes);
        a.memelab = JSON.parse(a.memelab);
        a.gradients = JSON.parse(a.gradients);
        a.work = JSON.parse(a.work);
        a.social_links = JSON.parse(a.social_links);
      });
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/memes/artists_names`, function (req: any, res: any) {
    db.fetchArtistsNamesMemes().then((result) => {
      return returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/memelab/artists_names`, function (req: any, res: any) {
    db.fetchArtistsNamesMemeLab().then((result) => {
      return returnJsonResult(result, req, res);
    });
  });

  apiRouter.get(`/nfts`, function (req: any, res: any) {
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
      result.data.map((d: any) => {
        d.metadata = JSON.parse(d.metadata);
        if (typeof d.metadata.animation_details === 'string') {
          d.metadata.animation_details = JSON.parse(
            d.metadata.animation_details
          );
        }
      });
      returnPaginatedResult(result, req, res);
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
      returnPaginatedResult(result, req, res);
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
      returnPaginatedResult(result, req, res);
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

  apiRouter.get(`/transactions`, function (req: any, res: any) {
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
    db.fetchTransactions(pageSize, page, wallets, contracts, nfts, filter).then(
      (result) => {
        returnPaginatedResult(result, req, res);
      }
    );
  });

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
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
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

  apiRouter.get(`/delegations/:wallet`, function (req: any, res: any) {
    const wallet = req.params.wallet;

    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    db.fetchDelegations(wallet, pageSize, page).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/delegations/minting/:wallet`, function (req: any, res: any) {
    const wallet = req.params.wallet;

    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

    db.fetchMintingDelegations(wallet, pageSize, page).then((result) => {
      returnPaginatedResult(result, req, res);
    });
  });

  apiRouter.get(`/delegations`, function (req: any, res: any) {
    const use_cases = req.query.use_case;
    const collections = req.query.collection;
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;
    const showExpired = !!(
      req.query.show_expired && req.query.show_expired == 'true'
    );
    const block = req.query.block;

    db.fetchDelegationsByUseCase(
      collections,
      use_cases,
      showExpired,
      pageSize,
      page,
      block
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

  apiRouter.use(`/profiles`, profilesRoutes);
  apiRouter.use(`/analytics`, analyticsRoutes);
  apiRouter.use(`/community-members`, communityMembersRoutes);
  apiRouter.use(`/community-members-curation`, communityMembersCurationRoutes);
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
  apiRouter.use(`/drops`, dropsRoutes);
  apiRouter.use(`/nft-owners`, nftOwnersRoutes);
  rootRouter.use(BASE_PATH, apiRouter);
  app.use(rootRouter);

  app.use(customErrorMiddleware());

  if (sentryContext.isConfigured()) {
    app.use(Sentry.Handlers.errorHandler());
    app.use(sentryFlusherMiddleware());
  }

  app.listen(3000, function () {
    logger.info(
      `[CONFIG ${process.env.NODE_ENV}] [SERVER RUNNING ON PORT 3000]`
    );
  });
});

export { app };

import * as db from '../../db-api';
import { loadEnv } from '../../secrets';

const mcache = require('memory-cache');

const CACHE_TIME_MS = 1 * 60 * 1000;

function cacheKey(req: any) {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__` + req.originalUrl || req.url;
}

const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'x-6529-auth',
    'Origin',
    'Accept',
    'X-Requested-With'
  ]
};

loadEnv(true).then(async (e) => {
  console.log(
    '[API]',
    `[DB HOST ${process.env.DB_HOST_READ}]`,
    `[API PASSWORD ACTIVE ${process.env.ACTIVATE_API_PASSWORD}]`
  );

  await db.connect();

  app.use(compression());
  app.use(cors(corsOptions));
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
        console.log(`Unauthorized request for ${req.path} auth: ${auth}`);
        res.statusCode = 401;
        const image = await db.fetchRandomImage();
        res.end(
          JSON.stringify({
            image: image[0].scaled ? image[0].scaled : image[0].image
          })
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

    let cachedBody = mcache.get(key);
    if (cachedBody) {
      returnPaginatedResult(cachedBody, req, res, true);
    } else {
      next();
    }
  };

  app.all('/api*', requireLogin);
  app.all('/api*', checkCache);

  const BASE_PATH = '/api';
  const CONTENT_TYPE_HEADER = 'Content-Type';
  const JSON_HEADER_VALUE = 'application/json';
  const DEFAULT_PAGE_SIZE = 50;
  const DISTRIBUTION_PAGE_SIZE = 250;
  const SORT_DIRECTIONS = ['ASC', 'DESC'];

  const DISTRIBUTION_SORT = [
    'phase',
    'card_mint_count',
    'count',
    'wallet_tdh',
    'wallet_balance',
    'wallet_unique_balance'
  ];

  const NFT_TDH_SORT = [
    'card_tdh',
    'card_tdh__raw',
    'card_balance',
    'total_tdh',
    'total_balance',
    'total_tdh__raw'
  ];

  const MEME_LAB_OWNERS_SORT = ['balance'];

  const TDH_SORT = [
    'boosted_tdh',
    'tdh',
    'tdh__raw',
    'tdh_rank',
    'boosted_memes_tdh',
    'memes_tdh',
    'memes_tdh__raw',
    'boosted_memes_tdh_season1',
    'memes_tdh_season1',
    'memes_tdh_season1__raw',
    'boosted_memes_tdh_season2',
    'memes_tdh_season2',
    'memes_tdh_season2__raw',
    'boosted_memes_tdh_season3',
    'memes_tdh_season3',
    'memes_tdh_season3__raw',
    'memes_balance',
    'memes_balance_season1',
    'memes_balance_season2',
    'memes_balance_season3',
    'boosted_gradients_tdh',
    'gradients_tdh',
    'gradients_tdh__raw',
    'gradients_balance',
    'balance',
    'purchases_value',
    'purchases_count',
    'sales_value',
    'sales_count',
    'purchases_value_memes',
    'purchases_value_memes_season1',
    'purchases_value_memes_season2',
    'purchases_value_memes_season3',
    'purchases_value_gradients',
    'purchases_count_memes',
    'purchases_count_memes_season1',
    'purchases_count_memes_season2',
    'purchases_count_memes_season3',
    'purchases_count_gradients',
    'sales_value_memes',
    'sales_value_memes_season1',
    'sales_value_memes_season2',
    'sales_value_memes_season3',
    'sales_value_gradients',
    'sales_count_memes',
    'sales_count_memes_season1',
    'sales_count_memes_season2',
    'sales_count_memes_season3',
    'sales_count_gradients',
    'transfers_in',
    'transfers_in_memes',
    'transfers_in_memes_season1',
    'transfers_in_memes_season2',
    'transfers_in_memes_season3',
    'transfers_in_gradients',
    'transfers_out',
    'transfers_out_memes',
    'transfers_out_memes_season1',
    'transfers_out_memes_season2',
    'transfers_out_memes_season3',
    'transfers_out_gradients',
    'memes_cards_sets',
    'memes_cards_sets_szn1',
    'memes_cards_sets_szn2',
    'memes_cards_sets_szn3',
    'memes_cards_sets_minus1',
    'memes_cards_sets_minus2',
    'genesis',
    'unique_memes',
    'unique_memes_szn1',
    'unique_memes_szn2',
    'unique_memes_szn3'
  ];

  const TAGS_FILTERS = [
    'memes',
    'memes_set',
    'memes_set_minus1',
    'memes_set_szn1',
    'memes_set_szn2',
    'memes_set_szn3',
    'memes_genesis',
    'gradients'
  ];

  const TRANSACTION_FILTERS = ['sales', 'transfers', 'airdrops'];

  function fullUrl(req: any, next: boolean) {
    let url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    if (!next) {
      return null;
    }

    const newUrl = new URL(url);
    const params = newUrl.searchParams;

    if (params.has('page')) {
      const page = parseInt(params.get('page')!);
      newUrl.searchParams.delete('page');
      newUrl.searchParams.append('page', String(page + 1));
      return newUrl.toString();
    } else {
      if (!url.includes('?')) {
        url += '?';
      }
      return (url += `&page=2`);
    }
  }

  function returnPaginatedResult(
    result: db.DBResponse,
    req: any,
    res: any,
    skipCache?: boolean
  ) {
    result.next = fullUrl(req, result.next);

    if (!skipCache && result.count > 0) {
      mcache.put(cacheKey(req), result, CACHE_TIME_MS);
    }

    res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
    res.end(JSON.stringify(result));
  }

  app.get(`${BASE_PATH}/blocks`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      console.log(
        new Date(),
        `[API]`,
        '[BLOCKS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchBlocks(pageSize, page).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[BLOCKS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(`${BASE_PATH}/uploads`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      console.log(
        new Date(),
        `[API]`,
        '[UPLOADS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchUploads(pageSize, page).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[BLOCKS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(`${BASE_PATH}/artists`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const meme_nfts = req.query.meme_id;

      console.log(
        new Date(),
        `[API]`,
        '[ARTISTS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
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
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[ARTISTS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(`${BASE_PATH}/nfts`, function (req: any, res: any, next: any) {
    try {
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

      const contracts = req.query.contract;
      const nfts = req.query.id;

      console.log(
        new Date(),
        `[API]`,
        '[NFTS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchNFTs(pageSize, page, contracts, nfts, sortDir).then((result) => {
        result.data.map((d: any) => {
          d.metadata = JSON.parse(d.metadata);
        });
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[NFTS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(
    `${BASE_PATH}/nfts_memelab`,
    function (req: any, res: any, next: any) {
      try {
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

        const contracts = req.query.contract;
        const nfts = req.query.id;
        const memeIds = req.query.meme_id;

        console.log(
          new Date(),
          `[API]`,
          '[NFTS MEMELAB]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchLabNFTs(memeIds, pageSize, page, contracts, nfts, sortDir).then(
          (result) => {
            result.data.map((d: any) => {
              d.meme_references = JSON.parse(d.meme_references);
              d.metadata = JSON.parse(d.metadata);
            });
            returnPaginatedResult(result, req, res);
          }
        );
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[NFTS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/memes_extended_data`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const nfts = req.query.id;
        const seasons = req.query.season;

        console.log(
          new Date(),
          `[API]`,
          '[MEMES EXTENDED]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchMemesExtended(pageSize, page, nfts, seasons).then((result) => {
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[MEMES EXTENDED]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/lab_extended_data`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const nfts = req.query.id;
        const collections = req.query.collection;

        console.log(
          new Date(),
          `[API]`,
          '[LAB EXTENDED]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );

        db.fetchLabExtended(pageSize, page, nfts, collections).then(
          (result) => {
            returnPaginatedResult(result, req, res);
          }
        );
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[LAB EXTENDED]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/:address/nfts`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const address = req.params.address;

        console.log(
          new Date(),
          `[API]`,
          '[NFTS FOR ADDRESS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchNFTsForWallet(address, pageSize, page).then((result) => {
          result.data.map((d: any) => {
            d.metadata = JSON.parse(d.metadata);
          });
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[NFTS FOR ADDRESS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/owners_memelab`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const sort =
          req.query.sort && MEME_LAB_OWNERS_SORT.includes(req.query.sort)
            ? req.query.sort
            : 'balance';

        const sortDir =
          req.query.sort_direction &&
          SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
            ? req.query.sort_direction
            : 'desc';

        const wallets = req.query.wallet;
        const nfts = req.query.id;

        console.log(
          new Date(),
          `[API]`,
          '[OWNERS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchLabOwners(pageSize, page, wallets, nfts, sort, sortDir).then(
          (result) => {
            returnPaginatedResult(result, req, res);
          }
        );
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[OWNERS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(`${BASE_PATH}/owners`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const wallets = req.query.wallet;
      const contracts = req.query.contract;
      const nfts = req.query.id;

      console.log(
        new Date(),
        `[API]`,
        '[OWNERS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchOwners(pageSize, page, wallets, contracts, nfts).then(
        (result) => {
          returnPaginatedResult(result, req, res);
        }
      );
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[OWNERS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(`${BASE_PATH}/owners_tags`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const wallets = req.query.wallet;

      console.log(
        new Date(),
        `[API]`,
        '[OWNERS]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchOwnersTags(pageSize, page, wallets).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[OWNERS]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      next(e);
    }
  });

  app.get(
    `${BASE_PATH}/transactions`,
    function (req: any, res: any, next: any) {
      try {
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

        console.log(
          new Date(),
          `[API]`,
          '[TRANSACTIONS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
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
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[TRANSACTIONS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/transactions_memelab`,
    function (req: any, res: any, next: any) {
      try {
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

        console.log(
          new Date(),
          `[API]`,
          '[TRANSACTIONS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchLabTransactions(pageSize, page, wallets, nfts, filter).then(
          (result) => {
            returnPaginatedResult(result, req, res);
          }
        );
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[TRANSACTIONS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/tdh/gradients/`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        console.log(
          new Date(),
          `[API]`,
          '[GRADIENTS TDH]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchGradientTdh(pageSize, page).then((result) => {
          result.data.map((d: any) => {
            d.memes = JSON.parse(d.memes);
            d.memes_ranks = JSON.parse(d.memes_ranks);
            d.gradients = JSON.parse(d.gradients);
            d.gradients_ranks = JSON.parse(d.gradients_ranks);
          });
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[NFT TDH]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/ens/:address/`,
    function (req: any, res: any, next: any) {
      try {
        const address = req.params.address;

        db.fetchEns(address).then((result) => {
          res.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
          res.end(JSON.stringify(result[0]));
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[NFT TDH]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(
    `${BASE_PATH}/tdh/:contract/:nft_id`,
    function (req: any, res: any, next: any) {
      const contract = req.params.contract;
      const nftId = req.params.nft_id;

      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const sort =
          req.query.sort && NFT_TDH_SORT.includes(req.query.sort)
            ? req.query.sort
            : 'card_tdh';

        const sortDir =
          req.query.sort_direction &&
          SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
            ? req.query.sort_direction
            : 'desc';

        const wallets = req.query.wallet;

        console.log(
          new Date(),
          `[API]`,
          '[NFT TDH]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchNftTdh(
          pageSize,
          page,
          contract,
          nftId,
          wallets,
          sort,
          sortDir
        ).then((result) => {
          result.data.map((d: any) => {
            d.memes = JSON.parse(d.memes);
            d.memes_ranks = JSON.parse(d.memes_ranks);
            d.gradients = JSON.parse(d.gradients);
            d.gradients_ranks = JSON.parse(d.gradients_ranks);
          });
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[NFT TDH]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        next(e);
      }
    }
  );

  app.get(`${BASE_PATH}/tdh`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      const wallets = req.query.wallet;
      const sort =
        req.query.sort && TDH_SORT.includes(req.query.sort)
          ? req.query.sort
          : 'boosted_tdh';

      const sortDir =
        req.query.sort_direction &&
        SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
          ? req.query.sort_direction
          : 'desc';

      const filter =
        req.query.filter && TAGS_FILTERS.includes(req.query.filter)
          ? req.query.filter
          : null;

      const hideMuseum =
        req.query.hide_museum && req.query.hide_museum == 'true' ? true : false;

      const hideTeam =
        req.query.hide_team && req.query.hide_team == 'true' ? true : false;

      console.log(
        new Date(),
        `[API]`,
        '[TDH]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchTDH(
        pageSize,
        page,
        wallets,
        sort,
        sortDir,
        filter,
        hideMuseum,
        hideTeam
      ).then((result) => {
        result.data.map((d: any) => {
          d.memes = JSON.parse(d.memes);
          d.memes_ranks = JSON.parse(d.memes_ranks);
          d.gradients = JSON.parse(d.gradients);
          d.gradients_ranks = JSON.parse(d.gradients_ranks);
        });
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[TDH]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  });

  app.get(
    `${BASE_PATH}/owner_metrics`,
    function (req: any, res: any, next: any) {
      try {
        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const wallets = req.query.wallet;
        const sort =
          req.query.sort && TDH_SORT.includes(req.query.sort)
            ? req.query.sort
            : 'boosted_tdh';

        const sortDir =
          req.query.sort_direction &&
          SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
            ? req.query.sort_direction
            : 'desc';

        const filter =
          req.query.filter && TAGS_FILTERS.includes(req.query.filter)
            ? req.query.filter
            : null;

        const hideMuseum =
          req.query.hide_museum && req.query.hide_museum == 'true'
            ? true
            : false;

        const hideTeam =
          req.query.hide_team && req.query.hide_team == 'true' ? true : false;

        console.log(
          new Date(),
          `[API]`,
          '[OWNER METRICS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchOwnerMetrics(
          pageSize,
          page,
          wallets,
          sort,
          sortDir,
          filter,
          hideMuseum,
          hideTeam
        ).then((result) => {
          result.data.map((d: any) => {
            if (d.memes) {
              d.memes = JSON.parse(d.memes);
            }
            if (d.memes_ranks) {
              d.memes_ranks = JSON.parse(d.memes_ranks);
            }
            if (d.gradients) {
              d.gradients = JSON.parse(d.gradients);
            }
            if (d.gradients_ranks) {
              d.gradients_ranks = JSON.parse(d.gradients_ranks);
            }
          });
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[TDH]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        return;
      }
    }
  );

  app.get(`${BASE_PATH}/team`, function (req: any, res: any, next: any) {
    try {
      const pageSize: number =
        req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
          ? parseInt(req.query.page_size)
          : DEFAULT_PAGE_SIZE;
      const page: number = req.query.page ? parseInt(req.query.page) : 1;

      console.log(
        new Date(),
        `[API]`,
        '[TEAM]',
        `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
      );
      db.fetchTeam(pageSize, page).then((result) => {
        returnPaginatedResult(result, req, res);
      });
    } catch (e) {
      console.log(
        new Date(),
        `[API]`,
        '[TEAM]',
        `SOMETHING WENT WRONG [EXCEPTION ${e}]`
      );
      return;
    }
  });

  app.get(
    `${BASE_PATH}/distribution_photos/:contract/:nft_id`,
    function (req: any, res: any, next: any) {
      try {
        const contract = req.params.contract;
        const nftId = req.params.nft_id;

        const pageSize: number =
          req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION PHOTOS]',
          `[CONTRACT ${contract}][ID ${nftId}]`,
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchDistributionPhotos(contract, nftId, pageSize, page).then(
          (result) => {
            returnPaginatedResult(result, req, res);
          }
        );
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION PHOTOS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        return;
      }
    }
  );

  app.get(
    `${BASE_PATH}/distribution_phases/:contract/:nft_id`,
    function (req: any, res: any, next: any) {
      try {
        const contract = req.params.contract;
        const nftId = req.params.nft_id;

        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION PHASES]',
          `[CONTRACT ${contract}][ID ${nftId}]`
        );
        db.fetchDistributionPhases(contract, nftId).then((result) => {
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        return;
      }
    }
  );

  app.get(
    `${BASE_PATH}/distribution/:contract/:nft_id`,
    function (req: any, res: any, next: any) {
      try {
        const contract = req.params.contract;
        const nftId = req.params.nft_id;
        const wallets = req.query.wallet;
        const phases = req.query.phase;

        const pageSize: number =
          req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DISTRIBUTION_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        const sort =
          req.query.sort && DISTRIBUTION_SORT.includes(req.query.sort)
            ? req.query.sort
            : 'phase';

        const sortDir =
          req.query.sort_direction &&
          SORT_DIRECTIONS.includes(req.query.sort_direction.toUpperCase())
            ? req.query.sort_direction
            : 'desc';

        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION]',
          `[CONTRACT ${contract}][ID ${nftId}]`,
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchDistributionForNFT(
          contract,
          nftId,
          wallets,
          phases,
          pageSize,
          page,
          sort,
          sortDir
        ).then((result) => {
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTION]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        return;
      }
    }
  );

  app.get(
    `${BASE_PATH}/distributions`,
    function (req: any, res: any, next: any) {
      try {
        const wallets = req.query.wallet;

        const pageSize: number =
          req.query.page_size && req.query.page_size < DISTRIBUTION_PAGE_SIZE
            ? parseInt(req.query.page_size)
            : DEFAULT_PAGE_SIZE;
        const page: number = req.query.page ? parseInt(req.query.page) : 1;

        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTIONS]',
          `[PAGE_SIZE ${pageSize}][PAGE ${page}]`
        );
        db.fetchDistributions(wallets, pageSize, page).then((result) => {
          returnPaginatedResult(result, req, res);
        });
      } catch (e) {
        console.log(
          new Date(),
          `[API]`,
          '[DISTRIBUTIONS]',
          `SOMETHING WENT WRONG [EXCEPTION ${e}]`
        );
        return;
      }
    }
  );

  app.get(`/`, async function (req: any, res: any, next: any) {
    const image = await db.fetchRandomImage();
    res.send(
      JSON.stringify({
        message: 'For 6529 SEIZE API go to /api',
        image: image[0].image
      })
    );
  });

  app.get(`${BASE_PATH}`, async function (req: any, res: any, next: any) {
    const image = await db.fetchRandomImage();
    res.send(
      JSON.stringify({
        message: '6529 SEIZE API',
        image: image[0].scaled ? image[0].scaled : image[0].image
      })
    );
  });

  app.listen(3000, function () {
    console.log(
      new Date(),
      `[API]`,
      `[CONFIG ${process.env.NODE_ENV}]`,
      '[SERVER RUNNING ON PORT 3000]'
    );
  });
});

export { app };

import * as db from '../../db-api';
import { ids } from '@/ids';

import * as http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import aggregatedActivityRoutes from './aggregated-activity/api.aggregated-activity.routes';
import authRoutes from './auth/auth.routes';
import communityMembersRoutes from './community-members/community-members.routes';
import userGroupsImEligibleForRoutes from './community-members/user-groups-im-elgigible-for.routes';
import userGroupsRoutes from './community-members/user-groups.routes';
import communityMetricsRoutes from './community-metrics/community-metrics.routes';
import delegationsRoutes from './delegations/delegations.routes';
import desktopRoutes from './desktop/routes.desktop';
import distributionPhotosRoutes from './distribution-photos/api.distribution_photos.routes';
import distributionsRoutes from './distributions/api.distributions.routes';
import bookmarkedDropsRoutes from './drops/bookmarked-drops.routes';
import boostedDropsRoutes from './drops/boosted-drops.routes';
import dropIdsRoutes from './drops/drop-ids.routes';
import dropsMediaRoutes from './drops/drops-media.routes';
import dropsRoutes from './drops/drops.routes';
import lightDropsRoutes from './drops/light-drops.routes';
import feedRoutes from './feed/feed.routes';
import gasRoutes from './gas/gas.routes';
import identitiesRoutes from './identities/identities.routes';
import identitySubscriptionsRoutes from './identity-subscriptions/identity-subscriptions.routes';
import mintingClaimsRoutes from './minting-claims/api.minting-claims.routes';
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
import proxiesRoutes from './proxies/proxies.routes';
import pushNotificationsRoutes from './push-notifications/push-notifications.routes';
import bulkRepRoutes from './ratings/bulk-rep.routes';
import ratingsRoutes from './ratings/ratings.routes';
import rememesRoutes from './rememes/rememes.routes';
import royaltiesRoutes from './royalties/royalties.routes';
import tdhEditionsRoutes from './tdh-editions/tdh-editions.routes';
import tdhRoutes from './tdh/api.tdh.routes';
import memesMintStatsRoutes from './memes-mint-stats/api.memes-mint-stats.routes';
import collectedStatsRoutes from './collected-stats/api.collected-stats.routes';
import waveMediaRoutes from './waves/wave-media.routes';
import wavesOverviewRoutes from './waves/waves-overview.routes';
import waveQuickVoteRoutes from './waves/wave-quick-vote.routes';
import publicWavesRoutes from './waves/waves-public.routes';
import wavesRoutes from './waves/waves.routes';
import xtdhRoutes from './xtdh/xtdh.routes';
import nftLinksRoutes from './nft-links/nft-links.routes';

import * as Sentry from '@sentry/serverless';
import { NextFunction, Request, Response } from 'express';
import * as Joi from 'joi';
import * as passport from 'passport';
import {
  ExtractJwt,
  Strategy as JwtStrategy,
  VerifiedCallback
} from 'passport-jwt';
import { ApiCompliantException } from '@/exceptions';
import * as sentryContext from '../../sentry.context';
import { Time, Timer } from '@/time';
import { DropType } from '@/entities/IDrop';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { dropsDb } from '@/drops/drops.db';
import { identitiesDb } from '@/identities/identities.db';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { dbSupplier } from '@/sql-executor';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { asyncRouter } from './async.router';
import { getJwtSecret } from './auth/auth';

import * as awsServerlessExpressMiddleware from 'aws-serverless-express/middleware';
import { randomUUID } from 'crypto';
import * as crypto from 'node:crypto';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import * as process from 'process';
import * as SwaggerUI from 'swagger-ui-express';
import { NFT } from '@/entities/INFT';
import { TDHBlock } from '@/entities/ITDH';
import { Upload } from '@/entities/IUpload';
import { env, loadLocalConfig, loadSecrets } from '@/env';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { getRedisClient, initRedis, redisGet } from '@/redis';
import { parseTdhResultsFromDB } from '@/sql_helpers';
import deployRoutes from '@/api/deploy/deploy.routes';
import alchemyProxyRoutes from './alchemy-proxy/alchemy-proxy.routes';
import {
  corsOptions,
  DEFAULT_PAGE_SIZE,
  DISTRIBUTION_PAGE_SIZE,
  NFTS_PAGE_SIZE,
  PaginatedResponse,
  SORT_DIRECTIONS
} from './api-constants';
import { seizeSettings } from '@/api/seize-settings';
import { MEMES_EXTENDED_SORT, TRANSACTION_FILTERS } from './api-filters';
import {
  cacheKey,
  getPage,
  getPageSize,
  returnPaginatedResult,
  transformPaginatedResponse
} from './api-helpers';
import { ApiResponse } from './api-response';
import { ApiArtistNameItem } from './generated/models/ApiArtistNameItem';
import { ApiBlockItem } from './generated/models/ApiBlockItem';
import { ApiBlocksPage } from './generated/models/ApiBlocksPage';
import { ApiNft } from './generated/models/ApiNft';
import { ApiNftsPage } from './generated/models/ApiNftsPage';
import { ApiSeizeSettings } from './generated/models/ApiSeizeSettings';
import { ApiTransactionPage } from './generated/models/ApiTransactionPage';
import { ApiUploadItem } from './generated/models/ApiUploadItem';
import { ApiUploadsPage } from './generated/models/ApiUploadsPage';
import { githubIssueDropService } from './github/github-issue-drop.service';
import { LOGO_SVG, renderHealthUI } from './health/health-ui.renderer';
import { getHealthData } from './health/health.service';
import { DEFAULT_MAX_SIZE } from './page-request';
import {
  initRateLimiting,
  rateLimitingMiddleware
} from './rate-limiting/rate-limiting.middleware';
import { setNoStoreHeaders } from '@/api/response-headers';
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

const fs = require('fs');
const jsYaml = require('js-yaml');
const path = require('path');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');

const requestLogger = Logger.get('API_REQUEST');
const logger = Logger.get('API');

const API_PORT = 3000;
const SENTRY_ALLOWED_SKEW_SECONDS = 300;
const SENTRY_WEBHOOK_DEDUPE_TTL_SECONDS = 86400;
const GH_WEBHOOK_DEDUPE_TTL_SECONDS = 86400;
const WEBHOOK_PROCESSING_LOCK_TTL_SECONDS = 300;
const SENTRY_ALERT_DROP_MAX_CONTENT_LENGTH = 30000;
const SENTRY_ALERT_DROP_MAX_TITLE_LENGTH = 250;

type SentryWebhookVerificationResult = {
  ok: boolean;
  reason?: string;
  statusCode?: number;
};

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timingSafeEqualHex(aHex: string, bHex: string) {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    const aView = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bView = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return (
      aView.length === bView.length && crypto.timingSafeEqual(aView, bView)
    );
  } catch {
    return false;
  }
}

function parseSentrySignatureCandidates(signatureHeader: string): string[] {
  return signatureHeader
    .split(',')
    .map((part) => part.trim())
    .map((part) => part.replace(/^sha256=/i, '').replace(/^v\d+=/i, ''))
    .map((part) => part.toLowerCase())
    .filter((part) => /^[0-9a-f]{64}$/.test(part));
}

function computeSentryWebhookSignature(
  secret: string,
  timestamp: string,
  bodyBytes: Uint8Array
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(bodyBytes)
    .digest('hex');
}

function verifySentryWebhook(req: any): SentryWebhookVerificationResult {
  const signatureHeader = normalizeHeaderValue(
    req.get('sentry-hook-signature')
  );
  const timestamp = normalizeHeaderValue(req.get('sentry-hook-timestamp'));
  const resource = normalizeHeaderValue(req.get('sentry-hook-resource'));

  if (!signatureHeader) {
    return {
      ok: false,
      reason: 'Missing sentry-hook-signature',
      statusCode: 401
    };
  }
  if (!timestamp) {
    return {
      ok: false,
      reason: 'Missing sentry-hook-timestamp',
      statusCode: 401
    };
  }
  if (resource && !['event_alert', 'error'].includes(resource)) {
    return {
      ok: false,
      reason: `Unexpected sentry-hook-resource: ${resource}`,
      statusCode: 400
    };
  }

  const rawBody: Buffer | undefined = req.rawBody;
  if (!rawBody) {
    return { ok: false, reason: 'Raw body not available', statusCode: 500 };
  }
  const rawBodyBytes = new Uint8Array(
    rawBody.buffer,
    rawBody.byteOffset,
    rawBody.byteLength
  );

  const timestampNumber = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(nowSeconds - timestampNumber) > SENTRY_ALLOWED_SKEW_SECONDS
  ) {
    return {
      ok: false,
      reason: 'Timestamp outside allowed window',
      statusCode: 401
    };
  }

  const rawSecret = env.getStringOrThrow('SENTRY_CLIENT_SECRET');
  const secret = rawSecret.trim();
  if (rawSecret !== secret && process.env.SENTRY_WEBHOOK_DEBUG === 'true') {
    logger.warn(
      `SENTRY_CLIENT_SECRET has leading/trailing whitespace [raw_len ${rawSecret.length}] [trimmed_len ${secret.length}]`
    );
  }
  const expectedSignature = computeSentryWebhookSignature(
    secret,
    timestamp,
    rawBodyBytes
  );
  const expectedWithoutTimestamp = crypto
    .createHmac('sha256', secret)
    .update(rawBodyBytes)
    .digest('hex');
  const providedCandidates = parseSentrySignatureCandidates(signatureHeader);
  const matchesWithTimestamp =
    providedCandidates.length > 0 &&
    providedCandidates.some((candidate) =>
      timingSafeEqualHex(expectedSignature, candidate)
    );
  const matchesWithoutTimestamp =
    providedCandidates.length > 0 &&
    providedCandidates.some((candidate) =>
      timingSafeEqualHex(expectedWithoutTimestamp, candidate)
    );
  const allowBodyOnlyMode =
    process.env.SENTRY_WEBHOOK_ALLOW_BODY_ONLY !== 'false';
  const isValidSignature =
    matchesWithTimestamp || (allowBodyOnlyMode && matchesWithoutTimestamp);

  if (isValidSignature && matchesWithoutTimestamp && !matchesWithTimestamp) {
    logger.warn(
      `Sentry webhook validated using body-only signature mode [resource ${
        resource ?? 'n/a'
      }] [timestamp ${timestamp}]`
    );
  }

  if (!isValidSignature) {
    if (process.env.SENTRY_WEBHOOK_DEBUG === 'true') {
      const parsedBodyBuffer = Buffer.from(
        JSON.stringify(req.body ?? {}),
        'utf8'
      );
      const parsedBodyBytes = new Uint8Array(
        parsedBodyBuffer.buffer,
        parsedBodyBuffer.byteOffset,
        parsedBodyBuffer.byteLength
      );
      const expectedFromParsedBody = computeSentryWebhookSignature(
        secret,
        timestamp,
        parsedBodyBytes
      );
      const matchesParsedBody = providedCandidates.some((candidate) =>
        timingSafeEqualHex(expectedFromParsedBody, candidate)
      );
      const rawBodySha256 = crypto
        .createHash('sha256')
        .update(rawBodyBytes)
        .digest('hex');
      logger.warn(
        `Sentry webhook signature mismatch [resource ${resource ?? 'n/a'}] [timestamp ${timestamp}] [skew_s ${
          nowSeconds - timestampNumber
        }] [content_length ${req.get('content-length') ?? 'n/a'}] [raw_body_sha256 ${rawBodySha256}] [provided_candidates ${
          providedCandidates.length
        }] [provided_prefix ${
          providedCandidates[0]?.slice(0, 12) ?? 'n/a'
        }] [expected_prefix ${expectedSignature.slice(
          0,
          12
        )}] [expected_no_ts_prefix ${expectedWithoutTimestamp.slice(
          0,
          12
        )}] [matches_parsed_body ${
          matchesParsedBody ? 'yes' : 'no'
        }] [matches_without_timestamp ${
          matchesWithoutTimestamp ? 'yes' : 'no'
        }]`
      );
    }
    return { ok: false, reason: 'Invalid signature', statusCode: 401 };
  }

  return { ok: true };
}

function normalizeToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.substring(0, maxLength - 3)}...`;
}

function formatSentryException(event: any): string | null {
  const entries = Array.isArray(event?.entries) ? event.entries : [];
  const exceptionEntry = entries.find(
    (entry: any) => entry?.type === 'exception'
  );
  const exception = exceptionEntry?.data?.values?.[0];
  if (!exception) {
    return null;
  }

  const exceptionType = normalizeToString(exception.type);
  const exceptionValue = normalizeToString(exception.value);
  const stackFrames = Array.isArray(exception?.stacktrace?.frames)
    ? exception.stacktrace.frames
    : [];
  const latestFrame =
    stackFrames.length > 0 ? stackFrames[stackFrames.length - 1] : null;
  const frameFunction = normalizeToString(latestFrame?.function);
  const frameFile = normalizeToString(latestFrame?.filename);
  const frameLine = normalizeToString(latestFrame?.lineno);
  const location = [frameFile, frameLine].filter(Boolean).join(':');

  const lines = [];
  if (exceptionType || exceptionValue) {
    lines.push([exceptionType, exceptionValue].filter(Boolean).join(': '));
  }
  if (frameFunction && location) {
    lines.push(`at ${frameFunction} (${location})`);
  } else if (frameFunction) {
    lines.push(`at ${frameFunction}`);
  } else if (location) {
    lines.push(`at ${location}`);
  }
  if (!lines.length) {
    return null;
  }
  return truncateString(lines.join('\n'), 2000);
}

function formatSentryAlertForDrop(payload: any): {
  title: string;
  content: string;
  eventId: string | null;
  issueId: string | null;
  level: string;
  webUrl: string | null;
} {
  const event = payload?.data?.event ?? {};
  const level = (normalizeToString(event.level) ?? 'error').toUpperCase();
  const eventTitle =
    normalizeToString(event.title) ??
    normalizeToString(event.message) ??
    'Sentry alert';
  const issueId = normalizeToString(event.issue_id);
  const eventId = normalizeToString(event.event_id);
  const project =
    normalizeToString(event.project_slug) ??
    normalizeToString(event.project_name) ??
    normalizeToString(event.project);
  const environment = normalizeToString(event.environment);
  const culprit = normalizeToString(event.culprit);
  const loggerName = normalizeToString(event.logger);
  const transaction = normalizeToString(event.transaction);
  const message = normalizeToString(event.message);
  const webUrl =
    normalizeToString(event.web_url) ??
    normalizeToString(payload?.data?.issue?.url);
  const exceptionPreview = formatSentryException(event);

  const titlePrefix = project
    ? `Sentry ${level} | ${project}`
    : `Sentry ${level}`;
  const title = truncateString(
    `${titlePrefix}: ${eventTitle}`,
    SENTRY_ALERT_DROP_MAX_TITLE_LENGTH
  );

  const lines = [`**${eventTitle}**`, '', `- Level: ${level}`];
  if (project) {
    lines.push(`- Project: ${project}`);
  }
  if (environment) {
    lines.push(`- Environment: ${environment}`);
  }
  if (issueId) {
    lines.push(`- Issue ID: ${issueId}`);
  }
  if (eventId) {
    lines.push(`- Event ID: ${eventId}`);
  }
  if (culprit) {
    lines.push(`- Culprit: ${culprit}`);
  }
  if (loggerName) {
    lines.push(`- Logger: ${loggerName}`);
  }
  if (transaction) {
    lines.push(`- Transaction: ${transaction}`);
  }
  if (webUrl) {
    lines.push(`- URL: ${webUrl}`);
  }
  if (message && message !== eventTitle) {
    lines.push(`- Message: ${message}`);
  }
  if (exceptionPreview) {
    lines.push('', '**Exception**', '```', exceptionPreview, '```');
  }

  const content = truncateString(
    lines.join('\n'),
    SENTRY_ALERT_DROP_MAX_CONTENT_LENGTH
  );

  return { title, content, eventId, issueId, level, webUrl };
}

async function postSentryAlertDrop({
  title,
  content
}: {
  title: string;
  content: string;
}) {
  const waveId = env.getStringOrThrow('ALERTS_WAVE_ID');
  const senderId = env.getStringOrThrow('ALERTS_BOT_PROFILE_ID');
  const dropId = randomUUID();
  const now = Time.currentMillis();

  await dbSupplier().executeNativeQueriesInTransaction(async (connection) => {
    const [wave, senderIdentity] = await Promise.all([
      dropsDb.findWaveByIdOrNull(waveId, connection),
      identitiesDb.getIdentityByProfileId(senderId, connection)
    ]);
    if (!wave) {
      throw new Error(`Configured ALERTS_WAVE_ID ${waveId} not found`);
    }
    if (!senderIdentity) {
      throw new Error(`Configured ALERTS_BOT_PROFILE_ID ${senderId} not found`);
    }

    await dropsDb.insertDrop(
      {
        id: dropId,
        author_id: senderId,
        title,
        parts_count: 1,
        wave_id: waveId,
        reply_to_drop_id: null,
        reply_to_part_id: null,
        created_at: now,
        updated_at: null,
        serial_no: null,
        drop_type: DropType.CHAT,
        signature: null
      },
      connection
    );

    await dropsDb.insertDropParts(
      [
        {
          drop_id: dropId,
          drop_part_id: 1,
          content,
          quoted_drop_id: null,
          quoted_drop_part_id: null,
          wave_id: waveId
        }
      ],
      connection
    );

    await dropsDb.updateHideLinkPreview(
      {
        drop_id: dropId,
        hide_link_preview: true
      },
      { connection }
    );

    const followerIds = await identitySubscriptionsDb.findWaveSubscribers(
      waveId,
      connection
    );
    const followerIdsToNotify = followerIds.filter((id) => id !== senderId);

    await Promise.all(
      followerIdsToNotify.map((id) =>
        identityNotificationsDb.insertNotification(
          {
            identity_id: id,
            additional_identity_id: senderId,
            related_drop_id: dropId,
            related_drop_part_no: null,
            related_drop_2_id: null,
            related_drop_2_part_no: null,
            wave_id: waveId,
            cause: IdentityNotificationCause.PRIORITY_ALERT,
            additional_data: {},
            visibility_group_id: null
          },
          connection
        )
      )
    );
  });
}

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
        const url = (req.url ?? '').split('?')[0];
        if (url === '/gh-hooks' || url === '/dev-alerts') {
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
        return res.json({
          image: image[0].scaled ? image[0].scaled : image[0].image
        });
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
          res
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
      await db.fetchBlocks(pageSize, page).then((result) => {
        return returnPaginatedResult(
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
      return res.json(seizeSettings());
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
        .then((result) => {
          return returnPaginatedResult(
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
        .then((result) => {
          return returnPaginatedResult(
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
    `/memes/artists_names`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      await db.fetchArtistsNamesMemes().then((result) => {
        return res.json(result);
      });
    }
  );

  apiRouter.get(
    `/memelab/artists_names`,
    cacheRequest(),
    async function (req: any, res: Response<ApiResponse<ApiArtistNameItem[]>>) {
      await db.fetchArtistsNamesMemeLab().then((result) => {
        return res.json(result);
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
        .then((result) => {
          return returnPaginatedResult(
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
        .then((result) => {
          result.data.map((d: any) => {
            d.metadata = JSON.parse(d.metadata);
          });
          return returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/nfts/:contract/media`,
    cacheRequest(),
    async function (req: any, res: any) {
      const contract = req.params.contract;

      await db.fetchNFTMedia(contract).then((result) => {
        return res.json(result);
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
          return returnPaginatedResult(result, req, res);
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
        .then((result) => {
          return returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/new_memes_seasons`,
    cacheRequest(),
    async function (req: any, res: any) {
      await db.fetchNewMemesSeasons().then((result) => {
        return res.json(result);
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

      await db.fetchMemesLite(sortDir).then((result) => {
        return returnPaginatedResult(result, req, res);
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

      await db.fetchMemelabLite(sortDir).then((result) => {
        return returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/memes_latest`,
    cacheRequest(),
    async function (req: any, res: any) {
      await db.fetchMemesLatest().then((result) => {
        result.metadata = JSON.parse(result.metadata);
        result.metadata.animation_details =
          typeof result.metadata.animation_details === 'string'
            ? JSON.parse(result.metadata.animation_details)
            : result.metadata.animation_details;
        return res.json(result);
      });
    }
  );

  apiRouter.get(
    `/nfts_search`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const search = req.query.search;

      await db.searchNfts(search, pageSize).then((result) => {
        return res.json(result);
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
        .then((result) => {
          return returnPaginatedResult(result, req, res);
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
        .then((result) => {
          return returnPaginatedResult(result, req, res);
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
        .then((result) => {
          return returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/tdh/gradients/`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req);
      const page = getPage(req);
      await db.fetchGradientTdh(pageSize, page).then((result) => {
        result = parseTdhResultsFromDB(result);
        return returnPaginatedResult(result, req, res);
      });
    }
  );

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
        .then((result) => {
          return returnPaginatedResult(result, req, res);
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

      await db.fetchConsolidations(pageSize, page, block).then((result) => {
        result.data.map((a: any) => {
          a.wallets = JSON.parse(a.wallets);
        });
        return returnPaginatedResult(result, req, res);
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
        .then((result) => {
          result.data.map((a: any) => {
            a.description = JSON.parse(a.description);
          });
          return returnPaginatedResult(result, req, res);
        });
    }
  );

  apiRouter.get(
    `/rememes_uploads`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
      const page = getPage(req);

      await db.fetchRememesUploads(pageSize, page).then((result) => {
        result.data.forEach((e: any) => {
          e.date = e.created_at;
          delete e.created_at;
        });
        return returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/tdh_global_history`,
    cacheRequest(),
    async function (req: any, res: any) {
      const pageSize = getPageSize(req, DISTRIBUTION_PAGE_SIZE);
      const page = getPage(req);
      await db.fetchTDHGlobalHistory(pageSize, page).then((result) => {
        result.data.map((d: any) => {
          const date = new Date(d.date);
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const day = String(date.getUTCDate()).padStart(2, '0');
          d.date = `${year}-${month}-${day}`;
        });
        return returnPaginatedResult(result, req, res);
      });
    }
  );

  apiRouter.get(
    `/recent_tdh_history/:consolidation_key`,
    cacheRequest(),
    async function (req: any, res: any) {
      const consolidationKey = req.params.consolidation_key;
      await db.fetchRecentTDHHistory(consolidationKey).then((result) => {
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
        return res.json(result);
      });
    }
  );

  apiRouter.get(``, async function (req: any, res: any) {
    const image = await db.fetchRandomImage();
    return res.json({
      message: 'WELCOME TO 6529 API',
      health: '/health',
      image: image[0].scaled ? image[0].scaled : image[0].image
    });
  });

  rootRouter.get('/health', async (req, res) => {
    const healthData = await getHealthData();

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.json(healthData);
  });

  rootRouter.post('/dev-alerts', async (req: any, res: any) => {
    const verification = verifySentryWebhook(req);
    if (!verification.ok) {
      logger.warn(`Rejected Sentry webhook: ${verification.reason}`);
      return res.status(verification.statusCode).send(verification.reason);
    }

    const body = req.body;
    const action = body?.action;
    if (action !== 'triggered') {
      return res.send({});
    }

    const formattedAlert = formatSentryAlertForDrop(body);
    const redis = getRedisClient();
    const cacheKey = formattedAlert.eventId
      ? `sentry-webhook:${formattedAlert.eventId}`
      : null;
    const processingKey = cacheKey ? `${cacheKey}:processing` : null;
    let lockAcquired = false;
    if (redis && cacheKey && processingKey) {
      const alreadyProcessed = await redis.get(cacheKey);
      if (alreadyProcessed) {
        logger.info(
          `Duplicate Sentry webhook for event ${formattedAlert.eventId}, skipping`
        );
        return res.send({});
      }
      const lockWasSet = await redis.set(processingKey, '1', {
        NX: true,
        EX: WEBHOOK_PROCESSING_LOCK_TTL_SECONDS
      });
      if (!lockWasSet) {
        logger.info(
          `Sentry webhook for event ${formattedAlert.eventId} is already being processed, skipping`
        );
        return res.send({});
      }
      lockAcquired = true;
    }

    logger.info(
      `Sentry alert received [level ${formattedAlert.level}] [issue ${
        formattedAlert.issueId ?? 'unknown'
      }] [event ${formattedAlert.eventId ?? 'unknown'}] [url ${
        formattedAlert.webUrl ?? 'n/a'
      }]`
    );

    try {
      await postSentryAlertDrop({
        title: formattedAlert.title,
        content: formattedAlert.content
      });
      if (redis && cacheKey) {
        try {
          await redis.set(cacheKey, '1', {
            EX: SENTRY_WEBHOOK_DEDUPE_TTL_SECONDS
          });
        } catch (err) {
          logger.warn(
            `Failed to persist Sentry dedupe key for event ${formattedAlert.eventId}: ${err}`
          );
        }
      }
      logger.info(
        `Sentry alert posted to wave ${env.getStringOrThrow('ALERTS_WAVE_ID')}`
      );
    } catch (err) {
      logger.error(`Failed to post Sentry alert drop: ${err}`);
      return res.status(500).send('Failed to post alert');
    } finally {
      if (redis && processingKey && lockAcquired) {
        try {
          await redis.del(processingKey);
        } catch (err) {
          logger.warn(
            `Failed to release Sentry processing lock for event ${formattedAlert.eventId}: ${err}`
          );
        }
      }
    }

    return res.send({});
  });

  rootRouter.post('/gh-hooks', async (req: any, res: any) => {
    function timingSafeEqual(a: string, b: string) {
      const aBuf = Buffer.from(a);
      const bBuf = Buffer.from(b);
      const aView = new Uint8Array(
        aBuf.buffer,
        aBuf.byteOffset,
        aBuf.byteLength
      );
      const bView = new Uint8Array(
        bBuf.buffer,
        bBuf.byteOffset,
        bBuf.byteLength
      );
      if (aView.length !== bView.length) return false;
      return crypto.timingSafeEqual(aView, bView);
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
      const cacheKey = `gh-webhook:${html_url}`;
      const processingKey = `${cacheKey}:processing`;
      let lockAcquired = false;
      if (redis) {
        const alreadyProcessed = await redis.get(cacheKey);
        if (alreadyProcessed) {
          logger.info(`Duplicate webhook for ${html_url}, skipping`);
          return res.send({});
        }
        const lockWasSet = await redis.set(processingKey, '1', {
          NX: true,
          EX: WEBHOOK_PROCESSING_LOCK_TTL_SECONDS
        });
        if (!lockWasSet) {
          logger.info(
            `Webhook for ${html_url} is already being processed, skipping`
          );
          return res.send({});
        }
        lockAcquired = true;
      }
      logger.info(`New issue was opened: ${html_url}`);
      try {
        await githubIssueDropService.postGhIssueDrop(html_url);
        if (redis) {
          try {
            await redis.set(cacheKey, '1', {
              EX: GH_WEBHOOK_DEDUPE_TTL_SECONDS
            });
          } catch (err) {
            logger.warn(
              `Failed to persist GitHub webhook dedupe key for ${html_url}: ${err}`
            );
          }
        }
      } catch (err) {
        logger.error(`Failed to post drop for issue ${html_url}: ${err}`);
      } finally {
        if (redis && lockAcquired) {
          try {
            await redis.del(processingKey);
          } catch (err) {
            logger.warn(
              `Failed to release GitHub webhook processing lock for ${html_url}: ${err}`
            );
          }
        }
      }
    }
    res.send({});
  });

  rootRouter.use('/deploy', deployRoutes);

  rootRouter.get('/health/ui', async (req, res) => {
    const healthData = await getHealthData();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const html = renderHealthUI(healthData, baseUrl);

    setNoStoreHeaders(res);
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
    return res.json({
      message: 'WELCOME TO 6529 API',
      api: '/api',
      health: '/health',
      image: image[0].scaled ? image[0].scaled : image[0].image
    });
  });

  apiRouter.use(`/boosted-drops`, boostedDropsRoutes);
  apiRouter.use(`/drop-ids`, dropIdsRoutes);
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
  apiRouter.use(`/memes-mint-stats`, memesMintStatsRoutes);
  apiRouter.use(`/collected-stats`, collectedStatsRoutes);
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
  apiRouter.use(`/minting-claims`, mintingClaimsRoutes);
  apiRouter.use(`/wave`, waveQuickVoteRoutes);
  apiRouter.use(`/waves`, waveQuickVoteRoutes);
  apiRouter.use(`/waves`, wavesRoutes);
  apiRouter.use(`/public/waves`, publicWavesRoutes);
  apiRouter.use(`/policies`, policiesRoutes);
  apiRouter.use(`/push-notifications`, pushNotificationsRoutes);
  apiRouter.use(`/xtdh`, xtdhRoutes);
  apiRouter.use(`/nft-link`, nftLinksRoutes);

  rootRouter.use(BASE_PATH, apiRouter);
  rootRouter.use(`/desktop`, desktopRoutes);
  rootRouter.use(`/oracle`, oracleRoutes);
  rootRouter.use(`/rpc`, rpcRoutes);
  rootRouter.use(`/sitemap`, sitemapRoutes);
  rootRouter.use(`/alchemy-proxy`, alchemyProxyRoutes);

  // Apply rate limiting after cache check (cached responses bypass rate limiting)
  app.use(rateLimitingMiddleware());
  app.use(rootRouter);

  const openapiYamlCandidates = [
    path.join(__dirname, 'openapi.yaml'),      // Lambda (/var/task/) or esbuild bundle (dist/)
    path.join(__dirname, '../openapi.yaml')    // ts-node (src/)
  ];
  const openapiYamlPath = openapiYamlCandidates.find((p) => fs.existsSync(p));
  if (!openapiYamlPath) {
    throw new Error(
      `openapi.yaml not found. Tried: ${openapiYamlCandidates.join(', ')}`
    );
  }
  const swaggerDocument = jsYaml.load(fs.readFileSync(openapiYamlPath, 'utf8'));
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
  app.use(customErrorMiddleware());

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
      await getInitializationPromise();
      return next();
    } catch (err) {
      logger.error('[REQUEST DURING FAILED INIT]', err);
      return res.status(500).json({ error: 'Initialization failed' });
    }
  };
}

let initializationPromise: Promise<void> | null = null;

function getInitializationPromise(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = initializeApp()
    .then(() => {
      isInitialized = true;
    })
    .catch((err) => {
      logger.error('[INITIALIZATION FAILED]', err);
      throw err;
    });

  return initializationPromise;
}

app.use(initializationGuard());

export async function ensureInitialized(): Promise<void> {
  await getInitializationPromise();
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  ensureInitialized().catch((err) => {
    logger.error('[EAGER INIT FAILED]', err);
  });
}

export { app };

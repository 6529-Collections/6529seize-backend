import { Request } from 'express';
import type { AccessTokenSession } from '@/auth-context';
import { Logger } from '@/logging';
import {
  getAllowedWebAuthCredentialOrigins,
  getWebAppSignatureDomainsForApiHost,
  toRecordedRequestOrigin
} from '@/api/web-app-origins';

// Which origins a device grant (POST /device-grants) or an encrypted-messages
// device grant (POST /e2ee/devices) may sign, per API host, and how a
// registration came to the server. DEVICE_GRANT_ORIGIN_POLICY=enforce
// refuses a registration whose origin is not recognised; anything else,
// including no value, only records the verdict (log line and EMF metric).

const logger = Logger.get('DEVICE_GRANT_ORIGINS');

const NAMESPACE = '6529/DeviceGrants';
const POLICY_ENV = 'DEVICE_GRANT_ORIGIN_POLICY';

/** The origin 6529 Desktop signs in its grants. */
export const DESKTOP_GRANT_ORIGIN = '6529 Desktop';

/** App-client origins that are not web hosts. Web hosts come from config. */
const APP_GRANT_ORIGINS: readonly string[] = [DESKTOP_GRANT_ORIGIN];

/**
 * API hosts of the deployed environments, to tell another environment's web
 * host from an unknown one in the log. Checked after this API's own hosts.
 */
const ENVIRONMENT_API_HOSTS: readonly string[] = [
  'api.6529.io',
  'api.staging.6529.io'
];

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]'
]);

const MAX_LOGGED_API_HOST_LENGTH = 255;

export type GrantOriginPolicy = 'log' | 'enforce';

/**
 * web_origin: a first-party web host of this API. app_origin: an app client
 * label ("6529 Desktop"). The rest are not recognised: other_environment
 * (another API environment's web host), loopback (localhost and friends),
 * unrecognized (anything else).
 */
export type GrantOriginReason =
  | 'web_origin'
  | 'app_origin'
  | 'other_environment'
  | 'loopback'
  | 'unrecognized';

/** How a request Origin header relates to this API's web origins. */
export type RequestOriginKind =
  | 'web_origin'
  | 'other_environment'
  | 'loopback'
  | 'other'
  | 'none';

export type GrantRegistrationRoute = 'device_grants' | 'e2ee_devices';

export interface GrantOriginVerdict {
  readonly recognized: boolean;
  readonly reason: GrantOriginReason;
}

export interface GrantOriginCheck extends GrantOriginVerdict {
  readonly policy: GrantOriginPolicy;
  /** True only under the enforce policy, for an unrecognised origin. */
  readonly refused: boolean;
}

/** What the server knows about the request that registers a grant. */
export interface GrantRegistrationRequest {
  readonly apiHost: unknown;
  /** The request Origin in its recorded form (toRecordedRequestOrigin). */
  readonly requestOrigin: string | null;
  /** The caller's access-token session claims, when the token has them. */
  readonly session: AccessTokenSession | null;
}

/** Columns that record how a grant or device was registered. */
export interface GrantRegistrationRecord {
  readonly registered_client_type: string | null;
  readonly registered_binding: string | null;
  readonly registered_request_origin: string | null;
  readonly registered_session_id: string | null;
}

let warnedPolicyValue: string | null = null;

/** The configured policy; absent or unknown values mean log only. */
export function getGrantOriginPolicy(): GrantOriginPolicy {
  const raw = process.env[POLICY_ENV]?.trim().toLowerCase() ?? '';
  if (raw === 'enforce') {
    return 'enforce';
  }
  if (raw !== '' && raw !== 'log' && warnedPolicyValue !== raw) {
    warnedPolicyValue = raw;
    logger.warn(
      `[DEVICE GRANT ORIGIN POLICY UNKNOWN] [VALUE ${JSON.stringify(raw)}] [USING log]`
    );
  }
  return 'log';
}

/**
 * Origins a grant registered through this API host may sign: the hosts of
 * the web origins credentialed sign-in accepts here (built-in default for
 * the host plus WEB_APP_ORIGIN, WEB_APP_ADDITIONAL_ORIGINS and
 * AUTH_WEB_CREDENTIAL_ORIGINS) and the app-client labels.
 */
export function getRecognizedGrantOrigins(apiHostHeader: unknown): string[] {
  return Array.from(
    new Set([
      ...getWebAppSignatureDomainsForApiHost(apiHostHeader),
      ...APP_GRANT_ORIGINS
    ])
  );
}

function isOtherEnvironmentWebHost(value: string): boolean {
  return ENVIRONMENT_API_HOSTS.some((apiHost) =>
    getWebAppSignatureDomainsForApiHost(apiHost).includes(value)
  );
}

function isLoopbackHost(value: string): boolean {
  try {
    const url = new URL(`http://${value}`);
    return url.host === value && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether a signed grant origin is recognised for this API host, and why. */
export function evaluateGrantOrigin(
  origin: string,
  apiHostHeader: unknown
): GrantOriginVerdict {
  if (APP_GRANT_ORIGINS.includes(origin)) {
    return { recognized: true, reason: 'app_origin' };
  }
  if (getWebAppSignatureDomainsForApiHost(apiHostHeader).includes(origin)) {
    return { recognized: true, reason: 'web_origin' };
  }
  if (isOtherEnvironmentWebHost(origin)) {
    return { recognized: false, reason: 'other_environment' };
  }
  if (isLoopbackHost(origin)) {
    return { recognized: false, reason: 'loopback' };
  }
  return { recognized: false, reason: 'unrecognized' };
}

/** How the recorded request Origin relates to this API's web origins. */
export function classifyRequestOrigin(
  requestOrigin: string | null,
  apiHostHeader: unknown
): RequestOriginKind {
  if (!requestOrigin) {
    return 'none';
  }
  if (
    getAllowedWebAuthCredentialOrigins(apiHostHeader).includes(requestOrigin)
  ) {
    return 'web_origin';
  }
  if (
    ENVIRONMENT_API_HOSTS.some((apiHost) =>
      getAllowedWebAuthCredentialOrigins(apiHost).includes(requestOrigin)
    )
  ) {
    return 'other_environment';
  }
  try {
    const url = new URL(requestOrigin);
    return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)
      ? 'loopback'
      : 'other';
  } catch {
    return 'other';
  }
}

/** The registration facts of an API request and the caller's token. */
export function grantRegistrationRequestOf(
  req: Pick<Request, 'headers'>,
  session: AccessTokenSession | null
): GrantRegistrationRequest {
  return {
    apiHost: req.headers.host,
    requestOrigin: toRecordedRequestOrigin(req.headers.origin),
    session
  };
}

/** The registration columns to store; all null when nothing is known. */
export function toGrantRegistrationRecord(
  request: GrantRegistrationRequest | null | undefined
): GrantRegistrationRecord {
  return {
    registered_client_type: request?.session?.clientType ?? null,
    registered_binding: request?.session?.binding ?? null,
    registered_request_origin: request?.requestOrigin ?? null,
    registered_session_id: request?.session?.sessionId ?? null
  };
}

function loggableApiHost(apiHost: unknown): string | null {
  return typeof apiHost === 'string'
    ? apiHost.slice(0, MAX_LOGGED_API_HOST_LENGTH)
    : null;
}

function recordGrantOriginCheck({
  route,
  origin,
  grantId,
  request,
  check
}: {
  readonly route: GrantRegistrationRoute;
  readonly origin: string;
  readonly grantId: string;
  readonly request: GrantRegistrationRequest | null | undefined;
  readonly check: GrantOriginCheck;
}): void {
  const clientType = request?.session?.clientType ?? 'unknown';
  const binding = request?.session?.binding ?? 'unknown';
  const requestOrigin = request?.requestOrigin ?? null;
  const requestOriginKind = classifyRequestOrigin(
    requestOrigin,
    request?.apiHost
  );
  const verdict = check.recognized ? 'recognized' : 'unrecognized';
  const decision = check.refused ? 'refused' : 'accepted';
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.device_grant_origin.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [
                ['Route', 'Verdict'],
                ['Route', 'Reason'],
                ['Route', 'ClientType', 'Binding']
              ],
              Metrics: [{ Name: 'GrantOriginChecks', Unit: 'Count' }]
            }
          ]
        },
        Route: route,
        Verdict: verdict,
        Reason: check.reason,
        Policy: check.policy,
        Decision: decision,
        ClientType: clientType,
        Binding: binding,
        RequestOriginKind: requestOriginKind,
        RequestOrigin: requestOrigin,
        Origin: origin,
        GrantId: grantId,
        ApiHost: loggableApiHost(request?.apiHost),
        GrantOriginChecks: 1
      })}\n`
    );
    if (!check.recognized) {
      logger.warn(
        `[DEVICE GRANT ORIGIN UNRECOGNIZED] [ROUTE ${route}] [REASON ${check.reason}] [POLICY ${check.policy}] [DECISION ${decision}] [CLIENT_TYPE ${clientType}] [BINDING ${binding}] [ORIGIN ${JSON.stringify(origin)}] [REQUEST_ORIGIN ${JSON.stringify(requestOrigin)}] [REQUEST_ORIGIN_KIND ${requestOriginKind}] [GRANT ${grantId}]`
      );
    }
  } catch {
    // Telemetry must never change a request.
    logger.error('Device grant origin check could not be recorded');
  }
}

/**
 * Checks the origin a verified grant signed against this API host's
 * recognised origins and records the verdict. The caller refuses the
 * registration only when the result says `refused` (enforce policy and an
 * unrecognised origin); under the default log policy nothing changes.
 */
export function checkGrantOrigin({
  route,
  origin,
  grantId,
  request
}: {
  readonly route: GrantRegistrationRoute;
  readonly origin: string;
  readonly grantId: string;
  readonly request: GrantRegistrationRequest | null | undefined;
}): GrantOriginCheck {
  const verdict = evaluateGrantOrigin(origin, request?.apiHost);
  const policy = getGrantOriginPolicy();
  const check: GrantOriginCheck = {
    ...verdict,
    policy,
    refused: policy === 'enforce' && !verdict.recognized
  };
  recordGrantOriginCheck({ route, origin, grantId, request, check });
  return check;
}

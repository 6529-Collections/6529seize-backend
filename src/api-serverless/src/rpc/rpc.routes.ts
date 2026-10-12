import { Request, Response } from 'express';
import axios from 'axios';
import { asyncRouter } from '../async.router';
import { Logger } from '../../../logging';
import {
  buildRpcError,
  INVALID_REQUEST_MESSAGE,
  isPlainObject,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_LIMIT_EXCEEDED,
  RPC_MAX_BATCH_SIZE,
  RPC_MAX_REQUEST_BYTES,
  RpcCall,
  RpcErrorObject,
  RpcId,
  validateRpcCall
} from './rpc-request-validation';

const router = asyncRouter();

const aws4 = require('aws4');

const logger = Logger.get('RPC_ROUTES');

const UPSTREAM_URL = new URL(
  'https://nd-zpz7imf76bhw3cdjdkwwaghq4e.ethereum.managedblockchain.us-east-1.amazonaws.com'
);

export const RPC_UPSTREAM_TIMEOUT_MS = 10_000;
// Large enough for a full-transaction mainnet block, small enough to bound memory.
export const RPC_MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
// Keeps an assembled batch response below the Lambda response payload limit.
export const RPC_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const MAX_ERROR_MESSAGE_LENGTH = 256;
const MAX_ERROR_DATA_LENGTH = 32 * 1024;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;

type RpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly result: unknown }
  | ReturnType<typeof buildRpcError>;

function upstreamFailure(id: RpcId): RpcResponse {
  return buildRpcError(id, JSON_RPC_INTERNAL_ERROR, 'Upstream RPC error');
}

function signedHeaders(body: string) {
  const opts = {
    host: UPSTREAM_URL.hostname,
    path: UPSTREAM_URL.pathname,
    service: 'managedblockchain',
    region: 'us-east-1',
    method: 'POST',
    headers: {
      Host: UPSTREAM_URL.hostname,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  };
  aws4.sign(opts);
  return opts.headers;
}

/**
 * Keeps only the code, a bounded message and (for revert data) a bounded hex
 * string from a node-reported JSON-RPC error. Anything else is dropped.
 */
function sanitizeNodeError(error: unknown): RpcErrorObject | null {
  if (!isPlainObject(error)) {
    return null;
  }
  const { code, message, data } = error;
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return null;
  }
  if (typeof message !== 'string') {
    return null;
  }
  const sanitized = {
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
  };
  if (
    typeof data === 'string' &&
    data.length <= MAX_ERROR_DATA_LENGTH &&
    HEX_DATA.test(data)
  ) {
    return { ...sanitized, data };
  }
  return sanitized;
}

function toClientResponse(id: RpcId, upstream: unknown): RpcResponse {
  if (!isPlainObject(upstream)) {
    return upstreamFailure(id);
  }
  if (upstream.error !== undefined && upstream.error !== null) {
    const error = sanitizeNodeError(upstream.error);
    return error ? { jsonrpc: '2.0', id, error } : upstreamFailure(id);
  }
  if ('result' in upstream) {
    return { jsonrpc: '2.0', id, result: upstream.result };
  }
  return upstreamFailure(id);
}

function describeFailure(error: unknown): string {
  const failure = (isPlainObject(error) ? error : {}) as {
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown };
  };
  const status = failure.response?.status;
  return `status=${String(status)} code=${String(failure.code)} message=${String(failure.message)}`;
}

async function forwardCall(call: RpcCall): Promise<RpcResponse> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: call.id,
    method: call.method,
    params: call.params
  });
  try {
    const response = await axios.post(UPSTREAM_URL.origin, body, {
      headers: signedHeaders(body),
      timeout: RPC_UPSTREAM_TIMEOUT_MS,
      signal: AbortSignal.timeout(RPC_UPSTREAM_TIMEOUT_MS),
      maxContentLength: RPC_MAX_UPSTREAM_RESPONSE_BYTES,
      maxBodyLength: RPC_MAX_REQUEST_BYTES,
      maxRedirects: 0
    });
    return toClientResponse(call.id, response.data);
  } catch (error) {
    // Upstream bodies and messages are logged server-side only, never returned.
    logger.error(`RPC upstream request failed: ${describeFailure(error)}`);
    return upstreamFailure(call.id);
  }
}

async function processItem(item: unknown): Promise<RpcResponse> {
  const validation = validateRpcCall(item);
  return validation.ok ? forwardCall(validation.call) : validation.response;
}

interface Rejection {
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

const INVALID_ENVELOPE: Rejection = {
  status: 400,
  code: JSON_RPC_INVALID_REQUEST,
  message: INVALID_REQUEST_MESSAGE
};
const BATCH_TOO_LARGE: Rejection = {
  status: 400,
  code: JSON_RPC_INVALID_REQUEST,
  message: `Batch too large, max ${RPC_MAX_BATCH_SIZE} requests`
};
const REQUEST_TOO_LARGE: Rejection = {
  status: 413,
  code: JSON_RPC_INVALID_REQUEST,
  message: 'Request too large'
};
const RESPONSE_TOO_LARGE: Rejection = {
  status: 413,
  code: JSON_RPC_LIMIT_EXCEEDED,
  message: 'Response too large, reduce the batch size'
};

function sendRejection(res: Response, rejection: Rejection) {
  return res
    .status(rejection.status)
    .json(buildRpcError(null, rejection.code, rejection.message));
}

/** Whole-request limits that are checked before anything is sent upstream. */
function rejectRequest(body: unknown): Rejection | null {
  const isBatch = Array.isArray(body);
  if (!isBatch && !isPlainObject(body)) {
    return INVALID_ENVELOPE;
  }
  const count = isBatch ? body.length : 1;
  if (count === 0) {
    return INVALID_ENVELOPE;
  }
  if (count > RPC_MAX_BATCH_SIZE) {
    return BATCH_TOO_LARGE;
  }
  if (Buffer.byteLength(JSON.stringify(body)) > RPC_MAX_REQUEST_BYTES) {
    return REQUEST_TOO_LARGE;
  }
  return null;
}

router.post('/', async (req: Request, res: Response) => {
  const body: unknown = req.body;
  const rejection = rejectRequest(body);
  if (rejection) {
    return sendRejection(res, rejection);
  }
  const isBatch = Array.isArray(body);
  const items: unknown[] = isBatch ? body : [body];
  const results = await Promise.all(items.map(processItem));
  const serialized = JSON.stringify(isBatch ? results : results[0]);
  if (Buffer.byteLength(serialized) > RPC_MAX_RESPONSE_BYTES) {
    return sendRejection(res, RESPONSE_TOO_LARGE);
  }
  return res.status(200).type('json').send(serialized);
});

export default router;

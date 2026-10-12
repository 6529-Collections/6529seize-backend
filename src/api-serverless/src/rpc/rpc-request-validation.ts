/**
 * Request validation for the public `/rpc` proxy.
 *
 * The proxy only relays read-only Ethereum JSON-RPC calls. Anything that is not
 * explicitly allowlisted here is answered locally with a JSON-RPC error and is
 * never sent to the upstream node.
 */

// Standard read-only calls used by wallets and dapps. Write-side methods
// (eth_sendRawTransaction, eth_sendTransaction, ...), log scans (eth_getLogs),
// subscriptions and every debug_/trace_/admin_/personal_/txpool_ namespace are
// intentionally absent.
export const RPC_ALLOWED_METHOD_LIST: readonly string[] = [
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash'
];

export const RPC_ALLOWED_METHODS: ReadonlySet<string> = new Set(
  RPC_ALLOWED_METHOD_LIST
);

// Upstream calls are issued one per batch entry, so this also bounds fan-out.
export const RPC_MAX_BATCH_SIZE = 25;
export const RPC_MAX_REQUEST_BYTES = 256 * 1024;

export const JSON_RPC_INVALID_REQUEST = -32600;
export const INVALID_REQUEST_MESSAGE = 'Invalid Request';
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_LIMIT_EXCEEDED = -32005;

export type RpcId = string | number | null;

export interface RpcCall {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown[];
}

export interface RpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: string;
}

export interface RpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: RpcId;
  readonly error: RpcErrorObject;
}

export type RpcCallValidation =
  | { readonly ok: true; readonly call: RpcCall }
  | { readonly ok: false; readonly response: RpcErrorResponse };

export function buildRpcError(
  id: RpcId,
  code: number,
  message: string,
  data?: string
): RpcErrorResponse {
  const error: RpcErrorObject =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(item: Record<string, unknown>): RpcId | undefined {
  const id = item.id;
  if (id === null || typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id;
  }
  return undefined;
}

function invalid(id: RpcId, code: number, message: string): RpcCallValidation {
  return { ok: false, response: buildRpcError(id, code, message) };
}

/**
 * Validates one JSON-RPC 2.0 call. Only the fields we understand are kept, so
 * nothing else from the caller is ever forwarded upstream.
 */
export function validateRpcCall(item: unknown): RpcCallValidation {
  if (!isPlainObject(item)) {
    return invalid(null, JSON_RPC_INVALID_REQUEST, INVALID_REQUEST_MESSAGE);
  }
  // Notifications (no id) never receive a response, which makes no sense for a
  // read-only proxy, so a usable id is required.
  const id = readId(item);
  if (id === undefined) {
    return invalid(null, JSON_RPC_INVALID_REQUEST, INVALID_REQUEST_MESSAGE);
  }
  if (item.jsonrpc !== '2.0' || typeof item.method !== 'string') {
    return invalid(id, JSON_RPC_INVALID_REQUEST, INVALID_REQUEST_MESSAGE);
  }
  if (!RPC_ALLOWED_METHODS.has(item.method)) {
    return invalid(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found');
  }
  const params = item.params === undefined ? [] : item.params;
  if (!Array.isArray(params)) {
    return invalid(id, JSON_RPC_INVALID_PARAMS, 'Invalid params');
  }
  return { ok: true, call: { id, method: item.method, params } };
}

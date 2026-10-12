import fc from 'fast-check';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  RPC_ALLOWED_METHOD_LIST,
  RPC_ALLOWED_METHODS,
  validateRpcCall
} from './rpc-request-validation';

const BLOCKED_METHODS = [
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_accounts',
  'eth_getLogs',
  'eth_newFilter',
  'eth_subscribe',
  'eth_unsubscribe',
  'eth_createAccessList',
  'debug_traceTransaction',
  'debug_traceCall',
  'trace_block',
  'trace_call',
  'admin_peers',
  'admin_nodeInfo',
  'personal_unlockAccount',
  'txpool_content',
  'web3_clientVersion',
  'miner_start',
  'engine_newPayloadV3',
  'rpc_modules',
  'toString',
  'constructor',
  '__proto__',
  'hasOwnProperty',
  'ETH_CHAINID',
  'eth_chainId ',
  ''
];

const INVALID_REQUEST = 'Invalid Request';

function call(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_chainId',
    params: [],
    ...overrides
  };
}

describe('validateRpcCall allowlist', () => {
  it.each(RPC_ALLOWED_METHOD_LIST)('accepts %s', (method) => {
    const result = validateRpcCall(call({ method }));
    expect(result).toEqual({
      ok: true,
      call: { id: 1, method, params: [] }
    });
  });

  it('only allows read-only methods', () => {
    for (const method of RPC_ALLOWED_METHOD_LIST) {
      expect(method).toMatch(/^(eth|net)_/);
      expect(method).not.toMatch(/send|sign|subscribe|filter|Logs/i);
    }
  });

  it.each(BLOCKED_METHODS)('rejects %j with method not found', (method) => {
    const result = validateRpcCall(call({ id: 'abc', method }));
    expect(result).toEqual({
      ok: false,
      response: {
        jsonrpc: '2.0',
        id: 'abc',
        error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found' }
      }
    });
  });

  it('rejects every method outside the allowlist', () => {
    fc.assert(
      fc.property(
        fc.string().filter((method) => !RPC_ALLOWED_METHODS.has(method)),
        fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
        (method, id) => {
          const result = validateRpcCall(call({ method, id }));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.response.id).toBe(id);
            expect(result.response.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
          }
        }
      )
    );
  });
});

describe('validateRpcCall shape', () => {
  it.each([null, undefined, 1, 'eth_chainId', true, [], [call()]])(
    'rejects non-object request %j with a null id',
    (value) => {
      expect(validateRpcCall(value)).toEqual({
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: null,
          error: { code: JSON_RPC_INVALID_REQUEST, message: INVALID_REQUEST }
        }
      });
    }
  );

  it.each([undefined, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an unusable id %j',
    (id) => {
      const result = validateRpcCall(call({ id }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.id).toBeNull();
        expect(result.response.error.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    }
  );

  it('rejects a call without an id', () => {
    const { id: _id, ...withoutId } = call();
    const result = validateRpcCall(withoutId);
    expect(result.ok).toBe(false);
  });

  it.each([undefined, '1.0', 2, null, '2.0 '])(
    'rejects jsonrpc %j and keeps the id',
    (version) => {
      const result = validateRpcCall(call({ id: 7, jsonrpc: version }));
      expect(result).toEqual({
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: 7,
          error: { code: JSON_RPC_INVALID_REQUEST, message: INVALID_REQUEST }
        }
      });
    }
  );

  it.each([undefined, null, 1, {}, [], ['eth_chainId']])(
    'rejects non-string method %j',
    (method) => {
      const result = validateRpcCall(call({ method }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    }
  );

  it.each([{}, 'latest', 1, null, true])(
    'rejects non-array params %j',
    (params) => {
      const result = validateRpcCall(
        call({ id: 3, method: 'eth_getBalance', params })
      );
      expect(result).toEqual({
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: 3,
          error: { code: JSON_RPC_INVALID_PARAMS, message: 'Invalid params' }
        }
      });
    }
  );

  it('defaults missing params to an empty array', () => {
    const { params: _params, ...withoutParams } = call({
      method: 'eth_blockNumber'
    });
    expect(validateRpcCall(withoutParams)).toEqual({
      ok: true,
      call: { id: 1, method: 'eth_blockNumber', params: [] }
    });
  });

  it('accepts null, string and numeric ids', () => {
    for (const id of [null, 'abc', 0, 42, -1, 1.5]) {
      const result = validateRpcCall(call({ id }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.call.id).toBe(id);
      }
    }
  });

  it('keeps only known fields', () => {
    const result = validateRpcCall(
      call({
        method: 'eth_getBalance',
        params: ['0x0000000000000000000000000000000000000000', 'latest'],
        extra: 'dropped',
        headers: { Authorization: 'dropped' }
      })
    );
    expect(result).toEqual({
      ok: true,
      call: {
        id: 1,
        method: 'eth_getBalance',
        params: ['0x0000000000000000000000000000000000000000', 'latest']
      }
    });
  });

  it('never throws and always returns a well-formed result', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = validateRpcCall(value);
        if (result.ok) {
          expect(RPC_ALLOWED_METHODS.has(result.call.method)).toBe(true);
          expect(Array.isArray(result.call.params)).toBe(true);
        } else {
          expect(result.response.jsonrpc).toBe('2.0');
          expect(typeof result.response.error.code).toBe('number');
          expect(typeof result.response.error.message).toBe('string');
        }
      })
    );
  });
});

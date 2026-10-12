import { getNextgenRpcErrorCode } from '@/api/nextgen/nextgen-rpc-error';

describe('NextGen RPC error diagnostics', () => {
  it.each([
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'TIMEOUT',
    'CALL_EXCEPTION',
    'BAD_DATA',
    'UNSUPPORTED_OPERATION'
  ])('retains the known %s code without provider details', (code) => {
    expect(
      getNextgenRpcErrorCode({
        code,
        message: 'https://rpc.example.test/private-key',
        info: { url: 'https://rpc.example.test/private-key' }
      })
    ).toBe(code);
  });

  it.each([
    null,
    undefined,
    'https://rpc.example.test/private-key',
    new Error('https://rpc.example.test/private-key'),
    { code: 'https://rpc.example.test/private-key' },
    { code: -32000 },
    { code: 'NEW_PROVIDER_ERROR' }
  ])('does not expose arbitrary provider errors: %#', (error) => {
    expect(getNextgenRpcErrorCode(error)).toBe('UNKNOWN_ERROR');
  });
});

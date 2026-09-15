import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuthenticationContext } from '@/auth-context';
import { getAuthenticationContext } from '@/api/auth/auth';
import { PreflightMarketBatchRequest } from '@/api/generated/routes/operations';
import { MarketValidationError } from '@/marketplace/provider.types';
import { handlePreflightMarketBatch } from './marketplace-batch-preflight.handler';
import { preflightMarketBatch } from './marketplace-batch-preflight';

jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('./marketplace-batch-preflight', () => ({
  preflightMarketBatch: jest.fn()
}));
const ID = '10000000-0000-4000-8000-000000000001';
const BODY = {
  expected_revision: 'a'.repeat(64),
  transaction_digest: 'b'.repeat(64)
};
function request(body: unknown = BODY) {
  return {
    params: { id: ID },
    body,
    query: {},
    get: jest.fn(),
    res: { set: jest.fn() }
  } as unknown as PreflightMarketBatchRequest;
}
beforeEach(() =>
  jest
    .mocked(getAuthenticationContext)
    .mockResolvedValue(AuthenticationContext.notAuthenticated())
);
afterEach(() => jest.clearAllMocks());

test('accepts only small review identity input, sets no-store and scrubs request bodies', async () => {
  const req = request();
  const result = {
    operation_id: ID,
    revision: BODY.expected_revision,
    transaction_digest: BODY.transaction_digest,
    estimated_gas: '123',
    block_number: 12,
    block_hash: `0x${'c'.repeat(64)}`,
    block_timestamp: 1800
  };
  jest.mocked(preflightMarketBatch).mockResolvedValue(result);
  await expect(handlePreflightMarketBatch(req)).resolves.toEqual(result);
  expect(preflightMarketBatch).toHaveBeenCalledWith(
    ID,
    expect.any(AuthenticationContext),
    BODY
  );
  expect(req.body).toBeUndefined();
  expect(req.res?.set).toHaveBeenCalledWith({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
});

test.each([
  'data',
  'method',
  'url',
  'from',
  'to',
  'value',
  'block_number',
  'purpose',
  'gas',
  'stateOverride'
])('rejects caller supplied %s before service work', async (key) => {
  const req = request({ ...BODY, [key]: 'private input' });
  await expect(handlePreflightMarketBatch(req)).rejects.toThrow(
    'Invalid collecting or trade request.'
  );
  expect(preflightMarketBatch).not.toHaveBeenCalled();
  expect(req.body).toBeUndefined();
});

test.each([
  {},
  { ...BODY, expected_revision: 'A'.repeat(64) },
  { ...BODY, transaction_digest: '0x123' }
])('rejects malformed binding', async (body) => {
  await expect(handlePreflightMarketBatch(request(body))).rejects.toThrow();
  expect(preflightMarketBatch).not.toHaveBeenCalled();
});

test('provider failure response does not include provider body, URL or seller data', async () => {
  jest
    .mocked(preflightMarketBatch)
    .mockRejectedValue(new Error('private seller signature and provider URL'));
  const req = request();
  await expect(handlePreflightMarketBatch(req)).rejects.toMatchObject({
    code: 'MARKET_UNAVAILABLE',
    message: 'The operation could not be verified. Refresh before trying again.'
  });
  expect(req.body).toBeUndefined();
});

test('maps a safe simulation revert to a review conflict', async () => {
  jest
    .mocked(preflightMarketBatch)
    .mockRejectedValue(
      new MarketValidationError('ORDER_MISMATCH', 'Review the batch again.')
    );
  const error = await handlePreflightMarketBatch(request()).catch(
    (error) => error
  );
  expect(error.getStatusCode()).toBe(409);
  expect(error.code).toBe('ORDER_MISMATCH');
});

test('generated route requires auth, has no cache and exposes no generic RPC parameters', () => {
  const yaml = require('js-yaml') as {
    load(source: string): {
      paths: Record<string, { post: Record<string, unknown> }>;
    };
  };
  const document = yaml.load(
    readFileSync(resolve(__dirname, '../../openapi.yaml'), 'utf8')
  );
  const route = document.paths['/market/operations/{id}/preflight'].post;
  expect(route.security).toEqual([{ bearerAuth: [] }]);
  expect(route['x-6529-router']).toMatchObject({
    enabled: true,
    auth: 'required',
    cache: false
  });
  const generated = readFileSync(
    resolve(__dirname, '../generated/routes/openapi-generated.routes.ts'),
    'utf8'
  );
  expect(generated).toContain('handlePreflightMarketBatch');
});

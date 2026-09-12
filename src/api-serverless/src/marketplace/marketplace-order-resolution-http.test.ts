import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Operations from '@/api/generated/routes/operations';
import {
  ApiMarketTradeOrder,
  ApiMarketTradeOrderSideEnum
} from '@/api/generated/models/ApiMarketTradeOrder';
import { AuthenticationContext } from '@/auth-context';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiCompliantException } from '@/exceptions';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { handleGetMarketOrder } from './marketplace.handlers';
import { resolveMarketOrder } from './marketplace-order-resolution';

jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('./marketplace-order-resolution', () => ({
  ...jest.requireActual('./marketplace-order-resolution'),
  resolveMarketOrder: jest.fn()
}));

const yaml = require('js-yaml') as { load(value: string): unknown };
const ORDER_HASH = `0x${'ab'.repeat(32)}`;
const ASSET_KEY = '1:0x33fd426905f149f8376e227d0c9d3340aad17af1:8';
const QUERY = {
  asset_key: ASSET_KEY,
  protocol_address: MARKET_SEAPORT,
  side: 'LISTING'
};
const PRIVATE_INPUT = 'synthetic-private-provider-input';

function order(side: ApiMarketTradeOrderSideEnum): ApiMarketTradeOrder {
  return {
    identity: { protocol_address: MARKET_SEAPORT, order_hash: ORDER_HASH },
    asset_key: ASSET_KEY,
    maker: `0x${'11'.repeat(20)}`,
    recipient: MARKET_ZERO_ADDRESS,
    side,
    quantity: '3',
    purchase_quantity: '1',
    quantity_step: '1',
    available_quantity: '3',
    currency:
      side === ApiMarketTradeOrderSideEnum.Offer
        ? MARKET_WETH
        : MARKET_ZERO_ADDRESS,
    total_wei: '9007199254740993000',
    net_wei: '9007199254740990000',
    fees: [{ recipient: `0x${'22'.repeat(20)}`, amount_wei: '3000' }],
    start_time: '1',
    end_time: '2000000000'
  };
}

function request(query: unknown = QUERY, orderHash: unknown = ORDER_HASH) {
  const set = jest.fn();
  const req = {
    params: { order_hash: orderHash },
    query,
    body: { unexpected: PRIVATE_INPUT },
    get: jest.fn(),
    res: { set }
  } as unknown as Operations.GetMarketOrderRequest;
  return { req, set };
}

function expectPrivateResponse(set: jest.Mock) {
  expect(set).toHaveBeenCalledWith({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
}

async function failure(req: Operations.GetMarketOrderRequest) {
  try {
    await handleGetMarketOrder(req);
  } catch (error) {
    if (!(error instanceof ApiCompliantException)) throw error;
    expect(error.message).not.toContain(PRIVATE_INPUT);
    expect(JSON.stringify(error)).not.toContain(PRIVATE_INPUT);
    expect(req.body).toBeUndefined();
    return error;
  }
  throw new Error('Expected an API-compliant failure.');
}

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getAuthenticationContext)
    .mockResolvedValue(AuthenticationContext.notAuthenticated());
  jest
    .mocked(resolveMarketOrder)
    .mockResolvedValue(order(ApiMarketTradeOrderSideEnum.Listing));
});

describe('exact order resolution HTTP boundary', () => {
  it.each([
    ApiMarketTradeOrderSideEnum.Listing,
    ApiMarketTradeOrderSideEnum.Offer
  ])(
    'resolves one %s for an anonymous reader without changing exact terms',
    async (side) => {
      const resolved = order(side);
      jest.mocked(resolveMarketOrder).mockResolvedValue(resolved);
      const { req, set } = request({ ...QUERY, side });

      const response: Operations.GetMarketOrderResponse =
        await handleGetMarketOrder(req);

      expect(response).toBe(resolved);
      expect(resolveMarketOrder).toHaveBeenCalledTimes(1);
      expect(resolveMarketOrder).toHaveBeenCalledWith({
        ...QUERY,
        side,
        order_hash: ORDER_HASH
      });
      expect(getAuthenticationContext).toHaveBeenCalledWith(req);
      expectPrivateResponse(set);
      expect(req.body).toBeUndefined();
    }
  );

  it.each([
    {},
    { ...QUERY, asset_key: undefined },
    { ...QUERY, protocol_address: undefined },
    { ...QUERY, side: undefined },
    { ...QUERY, asset_key: '' },
    { ...QUERY, asset_key: 'a'.repeat(151) },
    { ...QUERY, asset_key: [ASSET_KEY] },
    { ...QUERY, protocol_address: '0x1234' },
    { ...QUERY, protocol_address: `0x${'gg'.repeat(20)}` },
    { ...QUERY, protocol_address: [MARKET_SEAPORT] },
    { ...QUERY, side: 'listing' },
    { ...QUERY, side: ['LISTING', 'OFFER'] },
    { ...QUERY, quantity: '2' },
    { ...QUERY, profile_id: PRIVATE_INPUT },
    { ...QUERY, cursor: 'cursor' }
  ])(
    'rejects malformed or extra query fields before resolving: %j',
    async (query) => {
      const { req, set } = request(query);
      const error = await failure(req);
      expect(error.getStatusCode()).toBe(400);
      expect(resolveMarketOrder).not.toHaveBeenCalled();
      expectPrivateResponse(set);
    }
  );

  it.each([null, '', '0x1234', `0x${'gg'.repeat(32)}`, [ORDER_HASH]])(
    'rejects an invalid required order hash before resolving: %j',
    async (hash) => {
      const { req, set } = request(QUERY, hash);
      const error = await failure(req);
      expect(error.getStatusCode()).toBe(400);
      expect(resolveMarketOrder).not.toHaveBeenCalled();
      expectPrivateResponse(set);
    }
  );

  it('rejects a missing path identity instead of resolving a default order', async () => {
    const { req, set } = request();
    req.params = {} as Operations.GetMarketOrderPathParams;
    expect((await failure(req)).getStatusCode()).toBe(400);
    expect(resolveMarketOrder).not.toHaveBeenCalled();
    expectPrivateResponse(set);
  });

  it('replaces unexpected provider details with a safe retryable error', async () => {
    jest
      .mocked(resolveMarketOrder)
      .mockRejectedValue(
        Object.assign(new Error(PRIVATE_INPUT), { body: PRIVATE_INPUT })
      );
    const { req, set } = request();
    const error = await failure(req);
    expect(error.getStatusCode()).toBe(503);
    expect(error.code).toBe('MARKET_UNAVAILABLE');
    expectPrivateResponse(set);
  });

  it.each([
    ['ORDER_MISMATCH', 409],
    ['PROVIDER_UNAVAILABLE', 503]
  ] as const)('preserves safe %s resolution failures', async (code, status) => {
    jest.mocked(resolveMarketOrder).mockRejectedValue(
      Object.assign(new MarketValidationError(code, 'Refresh this order.'), {
        body: PRIVATE_INPUT
      })
    );
    const { req, set } = request();
    const error = await failure(req);
    expect(error.getStatusCode()).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe('Refresh this order.');
    expectPrivateResponse(set);
  });
});

interface OpenApiOperation {
  readonly security: readonly Record<string, unknown>[];
  readonly 'x-6529-router': Record<string, unknown>;
  readonly parameters: readonly {
    readonly name: string;
    readonly in: string;
    readonly required: boolean;
  }[];
  readonly responses: Record<string, unknown>;
}

describe('exact order resolution OpenAPI contract', () => {
  const document = yaml.load(
    readFileSync(resolve(__dirname, '../../openapi.yaml'), 'utf8')
  ) as { paths: Record<string, { get: OpenApiOperation }> };
  const operation = document.paths['/market/orders/{order_hash}'].get;

  it('overrides global authentication and opts out of router caching', () => {
    expect(operation.security).toEqual([{}]);
    expect(operation['x-6529-router']).toMatchObject({
      enabled: true,
      auth: 'none',
      cache: false,
      handler: {
        import: '@/api/marketplace/marketplace.handlers',
        name: 'handleGetMarketOrder'
      }
    });
  });

  it('requires every component of the exact order and asset identity', () => {
    expect(
      operation.parameters.map(({ name, in: location, required }) => ({
        name,
        in: location,
        required
      }))
    ).toEqual([
      { name: 'order_hash', in: 'path', required: true },
      { name: 'asset_key', in: 'query', required: true },
      { name: 'protocol_address', in: 'query', required: true },
      { name: 'side', in: 'query', required: true }
    ]);
  });

  it('returns a single public order DTO and documents validation and retry failures', () => {
    expect(operation.responses).toMatchObject({
      '200': {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ApiMarketTradeOrder' }
          }
        }
      },
      '400': expect.any(Object),
      '409': expect.any(Object),
      '503': expect.any(Object)
    });
  });
});

const mockGateway = { submit: jest.fn() };
const mockService = {
  submit: jest.fn(),
  awaiting: jest.fn(),
  createPending: jest.fn(),
  get: jest.fn(),
  addSignature: jest.fn(),
  retry: jest.fn(),
  cancel: jest.fn()
};

jest.mock('../auth/auth', () => ({
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getWalletOrThrow: (req: { headers: Record<string, string | undefined> }) => {
    const wallet = req.headers['x-test-wallet'];
    if (!wallet) throw new Error('Wallet not found');
    return wallet;
  }
}));
jest.mock('@/chain-relay/chain-relay.service', () => ({
  ...jest.requireActual('@/chain-relay/chain-relay.service'),
  chainRelayService: mockService
}));

import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Wallet } from 'ethers';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  PendingOperation,
  PendingStatus
} from '@/chain-relay/chain-pending-operations.db';
import { ChainRelayService } from '@/chain-relay/chain-relay.service';
import chainRoutes from './chain.routes';

const TX = '0x' + '5a'.repeat(32);
const ANCHOR = new Wallet('0x' + '11'.repeat(32)).address.toLowerCase();
const JOINER = new Wallet('0x' + '22'.repeat(32)).address.toLowerCase();
const STRANGER = new Wallet('0x' + '33'.repeat(32)).address.toLowerCase();
const SIG_A = '0x' + 'aa'.repeat(65);
const SIG_B = '0x' + 'bb'.repeat(65);

function op(status: PendingStatus): PendingOperation {
  return {
    tx_id: TX,
    op_type: 'IDENTITY_JOIN',
    principal: null,
    unsigned_hex: '0x0102',
    typed_data_json: '{"primaryType":"IdentityJoin"}',
    created_by: ANCHOR,
    expires_at: Date.now() + 3_600_000,
    status,
    result_json: null,
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    signers: [
      { role: 0, key_type: 1, signer: ANCHOR, sig: SIG_A, signed_at: 1_000 },
      { role: 4, key_type: 1, signer: JOINER, sig: SIG_B, signed_at: 2_000 }
    ]
  };
}

describe('/chain routes', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/chain', chainRoutes);
    app.use(customErrorMiddleware());
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The real relay's submit, in front of a gateway that answers.
    const relay = new ChainRelayService(mockGateway as never, {} as never);
    mockService.submit.mockImplementation((request) => relay.submit(request));
    mockGateway.submit.mockResolvedValue({ txId: TX, accepted: true });
  });

  const call = async (
    method: string,
    path: string,
    wallet: string,
    body?: unknown
  ) => {
    const response = await fetch(`${url}/chain${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-wallet': wallet },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>
    };
  };

  describe('POST /chain/submit', () => {
    const signatures = [{ role: 0, key_type: 1, sig: SIG_A }];

    it('passes the given tx_id on, in either form', async () => {
      expect(
        (await call('POST', '/submit', ANCHOR, { tx_id: TX, signed: '0xabcd' }))
          .status
      ).toBe(200);
      expect(mockGateway.submit).toHaveBeenLastCalledWith({
        signed: '0xabcd',
        txId: TX
      });
      const answer = await call('POST', '/submit', ANCHOR, {
        tx_id: TX,
        unsigned: '0x0102',
        signatures
      });
      expect(answer).toEqual({
        status: 200,
        body: { txId: TX, accepted: true }
      });
      expect(mockGateway.submit).toHaveBeenLastCalledWith({
        unsigned: '0x0102',
        signatures: [{ role: 0, keyType: 1, sig: SIG_A }],
        txId: TX
      });
    });

    it('answers 400 naming tx_id, and sends nothing, without it', async () => {
      for (const body of [
        { signed: '0xabcd' },
        { unsigned: '0x0102', signatures },
        { tx_id: '0x12', signed: '0xabcd' }
      ]) {
        const answer = await call('POST', '/submit', ANCHOR, body);
        expect(answer.status).toBe(400);
        expect(answer.body.error).toContain('tx_id');
      }
      expect(mockGateway.submit).not.toHaveBeenCalled();
    });

    it('answers an unknown outcome with the txId, apart from a refusal', async () => {
      const unknown = new ChainGatewayError(
        `/v1/submit: the outcome is unknown (timeout): ask getTx for ${TX}`,
        null,
        'outcome_unknown',
        '/v1/submit'
      );
      unknown.txId = TX;
      mockGateway.submit.mockRejectedValueOnce(unknown);
      const answer = await call('POST', '/submit', ANCHOR, {
        tx_id: TX,
        signed: '0xabcd'
      });
      expect(answer.status).toBe(502);
      expect(answer.body).toEqual({
        error: expect.stringContaining(TX),
        code: 'CHAIN_OUTCOME_UNKNOWN',
        tx_id: TX,
        outcome: 'unknown'
      });
      mockGateway.submit.mockRejectedValueOnce(
        new ChainGatewayError('no', 422, 'inadmissible', '/v1/submit')
      );
      const refused = await call('POST', '/submit', ANCHOR, {
        tx_id: TX,
        signed: '0xabcd'
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'CHAIN_REFUSED',
        tx_id: TX,
        outcome: 'refused'
      });
    });
  });

  describe('every route that returns an operation', () => {
    const pendingBody = {
      tx_id: TX,
      op_type: 'IDENTITY_JOIN',
      principal: null,
      unsigned: '0x0102',
      typed_data: {
        domain: {},
        primaryType: 'IdentityJoin',
        types: {},
        message: {}
      },
      expires_at: 2_000_000,
      required: [
        { role: 0, key_type: 1, signer: ANCHOR },
        { role: 4, key_type: 1, signer: JOINER }
      ],
      signatures: [{ role: 0, key_type: 1, sig: SIG_A }]
    };
    const routes: {
      name: string;
      method: string;
      path: string;
      body?: unknown;
      mock: jest.Mock;
      pick: (body: Record<string, any>) => Record<string, any>;
    }[] = [
      {
        name: 'GET /pending',
        method: 'GET',
        path: '/pending',
        mock: mockService.awaiting,
        pick: (body) => body.data[0]
      },
      {
        name: 'GET /pending/:tx_id',
        method: 'GET',
        path: `/pending/${TX}`,
        mock: mockService.get,
        pick: (body) => body
      },
      {
        name: 'POST /pending',
        method: 'POST',
        path: '/pending',
        body: pendingBody,
        mock: mockService.createPending,
        pick: (body) => body
      },
      {
        name: 'POST /pending/:tx_id/signatures',
        method: 'POST',
        path: `/pending/${TX}/signatures`,
        body: { role: 4, key_type: 1, sig: SIG_B },
        mock: mockService.addSignature,
        pick: (body) => body
      },
      {
        name: 'POST /pending/:tx_id/retry',
        method: 'POST',
        path: `/pending/${TX}/retry`,
        body: {},
        mock: mockService.retry,
        pick: (body) => body
      },
      {
        name: 'DELETE /pending/:tx_id',
        method: 'DELETE',
        path: `/pending/${TX}`,
        mock: mockService.cancel,
        pick: (body) => body
      }
    ];
    const sigsSeenBy = async (
      route: (typeof routes)[number],
      status: PendingStatus,
      wallet: string
    ) => {
      const held = op(status);
      route.mock.mockResolvedValue(
        route.path === '/pending' && route.method === 'GET' ? [held] : held
      );
      const answer = await call(route.method, route.path, wallet, route.body);
      expect(answer.status).toBeLessThan(300);
      const shown = route.pick(answer.body);
      expect(shown.signers.map((it: { signed: boolean }) => it.signed)).toEqual(
        [true, true]
      );
      return shown.signers.map((it: { sig: string | null }) => it.sig);
    };

    it.each(routes.map((it) => [it.name, it] as const))(
      '%s shows held signatures only to its signers while it is pending',
      async (_name, route) => {
        expect(await sigsSeenBy(route, 'PENDING', STRANGER)).toEqual([
          null,
          null
        ]);
        expect(await sigsSeenBy(route, 'PENDING', ANCHOR)).toEqual([
          SIG_A,
          SIG_B
        ]);
        expect(
          await sigsSeenBy(
            route,
            'PENDING',
            JOINER.toUpperCase().replace('0X', '0x')
          )
        ).toEqual([SIG_A, SIG_B]);
        for (const status of ['CANCELLED', 'SUBMITTED', 'FAILED'] as const) {
          expect(await sigsSeenBy(route, status, ANCHOR)).toEqual([null, null]);
        }
      }
    );
  });
});

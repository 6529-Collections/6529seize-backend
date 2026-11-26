const mockGateway = { submit: jest.fn() };
const mockService = { submit: jest.fn() };

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
import { customErrorMiddleware } from '@/api/api-error-middleware';
import { ChainRelayService } from '@/chain-relay/chain-relay.service';
import { Time } from '@/time';
import {
  WAVES_NOT_SWITCHED_ON_CODE,
  WAVES_NOT_SWITCHED_ON_MESSAGE
} from '@/chain-relay/chain-relay-waves';
import {
  POLL_CREATE_OP_TYPE,
  WAVES_POLLS_PAUSED_CODE,
  WAVES_POLLS_PAUSED_MESSAGE
} from '@/waves-freeze/waves-chain-polls';
import chainRoutes from './chain.routes';

const NAMES = [
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_CHAIN_POLLS'
];
const SWITCH_ON = Date.UTC(2026, 10, 28);
const TX = '0x' + '5a'.repeat(32);
const WALLET = '0x' + '1a'.repeat(20);
const SIG = '0x' + '1b'.repeat(65);
const VOTE_SET = 0x0606;
const RATING_SET = 0x0701;

const hexOf = (value: number | bigint, bytes: number) =>
  BigInt(value)
    .toString(16)
    .padStart(bytes * 2, '0');

/** A wallet-signed transaction's unsigned bytes, made-up values. */
function envelope(opType: number): string {
  return (
    '0x' +
    [
      '4001',
      '0001',
      '5a'.repeat(32),
      hexOf(7, 4),
      'a1'.repeat(32),
      hexOf(1, 1),
      '00'.repeat(12) + WALLET.slice(2),
      '00',
      hexOf(0, 4),
      hexOf(3, 8),
      hexOf(1_800_000_000_000, 8),
      hexOf(1_800_003_600_000, 8),
      '00',
      '03',
      '00',
      hexOf(BigInt('1000000000000000000'), 16),
      hexOf(100_000, 8),
      hexOf(0, 16),
      hexOf(opType, 2),
      '0001',
      'ab'.repeat(87)
    ].join('')
  );
}

describe('POST /chain/submit and new polls from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let server: Server;
  let url: string;
  let now: jest.SpyInstance;

  beforeAll(async () => {
    for (const name of NAMES) original[name] = process.env[name];
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
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    // The real relay's submit, in front of a gateway that answers.
    const relay = new ChainRelayService(mockGateway as never, {} as never, () =>
      Time.currentMillis()
    );
    mockService.submit.mockImplementation((request) => relay.submit(request));
    mockGateway.submit.mockResolvedValue({ txId: TX, accepted: true });
  });

  afterEach(() => {
    now.mockRestore();
  });

  const submit = async (body: Record<string, unknown>) => {
    const response = await fetch(`${url}/chain/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-wallet': WALLET },
      body: JSON.stringify({ tx_id: TX, ...body })
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    };
  };

  const pollForms = () => {
    const unsigned = envelope(POLL_CREATE_OP_TYPE);
    return [
      { unsigned, signatures: [{ role: 0, key_type: 1, sig: SIG }] },
      {
        signed:
          unsigned +
          hexOf(1, 4) +
          '0001' +
          hexOf(65, 4) +
          SIG.slice(2) +
          hexOf(0, 4)
      }
    ];
  };

  it('answers 423 to a POLL_CREATE after the switch-on with the setting off, and sends nothing', async () => {
    for (const body of pollForms()) {
      expect(await submit(body)).toEqual({
        status: 423,
        body: {
          error: WAVES_POLLS_PAUSED_MESSAGE,
          code: WAVES_POLLS_PAUSED_CODE
        }
      });
    }
    expect(mockService.submit).not.toHaveBeenCalled();
    expect(mockGateway.submit).not.toHaveBeenCalled();
  });

  it('relays a POLL_CREATE with the setting on', async () => {
    process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
    for (const body of pollForms()) {
      expect((await submit(body)).status).toBe(200);
    }
    expect(mockGateway.submit).toHaveBeenCalledTimes(2);
  });

  it('keeps POLL_CREATE closed at the relay before the switch-on', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    for (const body of pollForms()) {
      expect(await submit(body)).toEqual({
        status: 423,
        body: {
          error: WAVES_NOT_SWITCHED_ON_MESSAGE,
          code: WAVES_NOT_SWITCHED_ON_CODE
        }
      });
    }
    expect(mockService.submit).toHaveBeenCalledTimes(2);
    expect(mockGateway.submit).not.toHaveBeenCalled();
  });

  it('relays a wave vote after the switch-on', async () => {
    const answer = await submit({
      unsigned: envelope(VOTE_SET),
      signatures: [{ role: 0, key_type: 1, sig: SIG }]
    });
    expect(answer.status).toBe(200);
    expect(mockGateway.submit).toHaveBeenCalledTimes(1);
  });

  it('relays a non-wave operation before the switch-on', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    const answer = await submit({
      unsigned: envelope(RATING_SET),
      signatures: [{ role: 0, key_type: 1, sig: SIG }]
    });
    expect(answer.status).toBe(200);
    expect(mockGateway.submit).toHaveBeenCalledTimes(1);
  });
});

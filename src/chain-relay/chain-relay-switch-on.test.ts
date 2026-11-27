import { ChainSubmitRequest } from '@/chain-gateway/chain-gateway.types';
import {
  isWavesOperation,
  WAVES_NOT_SWITCHED_ON_CODE,
  WAVES_NOT_SWITCHED_ON_MESSAGE,
  WavesNotSwitchedOnException
} from './chain-relay-waves';
import { ChainPendingOperationsDb } from './chain-pending-operations.db';
import { ChainRelayService, RelaySubmitRequest } from './chain-relay.service';

const FLAG = 'FEATURE_WAVES_ON_CHAIN';
const AT = 'WAVES_SWITCH_ON_AT';
const SWITCH_ON = Date.UTC(2026, 10, 28);

const IDENTITY_CREATE = 0x0101;
const PROFILE_REPLACE = 0x0102;
const CAPABILITY_GRANT = 0x0301;
const RATING_SET = 0x0701;
const BALANCE_TRANSFER = 0x0901;
const GROUP_CREATE = 0x0401;
const ROLE_GRANT = 0x0403;
const WAVE_CREATE = 0x0501;
const MODERATION_DECIDE = 0x0504;
const SUBMISSION_CREATE = 0x0604;
const VOTE_SET = 0x0606;
const POLL_CREATE = 0x0607;
const POLL_BALLOT_SET = 0x0608;
const DECISION_CREATE = 0x0610;

const TX = '0x' + 'f0'.repeat(32);
const WALLET = '0x' + '1a'.repeat(20);
const GRANT = '0x' + 'c3'.repeat(32);
const KEY_ID = '0x' + 'd4'.repeat(32);

const hexOf = (value: number | bigint, bytes: number) =>
  BigInt(value)
    .toString(16)
    .padStart(bytes * 2, '0');

/** A transaction's unsigned bytes, made-up values: a wallet's by default. */
function envelope(opType: number, sessionKey = false): string {
  return (
    '0x' +
    [
      '4001',
      '0001',
      '5a'.repeat(32),
      hexOf(7, 4),
      'a1'.repeat(32),
      hexOf(sessionKey ? 2 : 1, 1),
      sessionKey ? KEY_ID.slice(2) : '00'.repeat(12) + WALLET.slice(2),
      sessionKey ? '01' + GRANT.slice(2) : '00',
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
      'ab'.repeat(85)
    ].join('')
  );
}

/** A wallet's whole signed transaction: one role-0 signature entry. */
function walletSigned(opType: number): RelaySubmitRequest {
  return {
    txId: TX,
    signed:
      envelope(opType) +
      hexOf(1, 4) +
      hexOf(0, 1) +
      hexOf(1, 1) +
      hexOf(65, 4) +
      '1b'.repeat(65) +
      hexOf(0, 4)
  };
}

function setup(nowMs: number) {
  let now = nowMs;
  const gateway = {
    submit: jest.fn(async (_request: ChainSubmitRequest) => ({
      txId: TX,
      accepted: true
    })),
    getIdentityByWallet: jest.fn()
  };
  const limiter = { checkRateLimit: jest.fn() };
  const service = new ChainRelayService(
    gateway as never,
    {} as ChainPendingOperationsDb,
    () => now,
    {},
    limiter as never,
    () => ({}) as never
  );
  return {
    gateway,
    limiter,
    service,
    setNow: (ms: number) => {
      now = ms;
    }
  };
}

describe('the operation relay before the waves switch-on', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, AT]) original[name] = process.env[name];
  });
  beforeEach(() => {
    delete process.env[FLAG];
    process.env[AT] = new Date(SWITCH_ON).toISOString();
  });
  afterAll(() => {
    for (const name of [FLAG, AT]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const WAVES_OPS: [string, number][] = [
    ['GROUP_CREATE', GROUP_CREATE],
    ['ROLE_GRANT', ROLE_GRANT],
    ['WAVE_CREATE', WAVE_CREATE],
    ['MODERATION_DECIDE', MODERATION_DECIDE],
    ['SUBMISSION_CREATE', SUBMISSION_CREATE],
    ['VOTE_SET', VOTE_SET],
    ['POLL_CREATE', POLL_CREATE],
    ['POLL_BALLOT_SET', POLL_BALLOT_SET],
    ['DECISION_CREATE', DECISION_CREATE]
  ];
  const OTHER_OPS: [string, number][] = [
    ['IDENTITY_CREATE', IDENTITY_CREATE],
    ['PROFILE_REPLACE', PROFILE_REPLACE],
    ['CAPABILITY_GRANT', CAPABILITY_GRANT],
    ['RATING_SET', RATING_SET],
    ['BALANCE_TRANSFER', BALANCE_TRANSFER]
  ];

  it('counts modules 0x04, 0x05 and 0x06 as waves operations, and no other', () => {
    for (const [, opType] of WAVES_OPS)
      expect(isWavesOperation(opType)).toBe(true);
    for (const [, opType] of OTHER_OPS)
      expect(isWavesOperation(opType)).toBe(false);
  });

  it.each(WAVES_OPS)(
    'refuses %s before the switch-on with 423, sending nothing',
    async (_name, opType) => {
      const { service, gateway } = setup(SWITCH_ON - 1);
      const error = await service.submit(walletSigned(opType)).catch((e) => e);
      expect(error).toBeInstanceOf(WavesNotSwitchedOnException);
      expect(error.getStatusCode()).toBe(423);
      expect(error.code).toBe(WAVES_NOT_SWITCHED_ON_CODE);
      expect(error.message).toBe(WAVES_NOT_SWITCHED_ON_MESSAGE);
      expect(gateway.submit).not.toHaveBeenCalled();
    }
  );

  it("refuses a session key's vote before the switch-on, before its grant checks", async () => {
    const { service, gateway } = setup(SWITCH_ON - 1);
    await expect(
      service.submit({
        txId: TX,
        unsigned: envelope(VOTE_SET, true),
        signatures: [{ role: 0, keyType: 2, sig: '0x' + 'e5'.repeat(64) }]
      })
    ).rejects.toBeInstanceOf(WavesNotSwitchedOnException);
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('relays the same waves operation once the switch-on time comes, in the same process', async () => {
    const { service, gateway, setNow } = setup(SWITCH_ON - 1);
    await expect(service.submit(walletSigned(VOTE_SET))).rejects.toBeInstanceOf(
      WavesNotSwitchedOnException
    );
    setNow(SWITCH_ON);
    await expect(service.submit(walletSigned(VOTE_SET))).resolves.toEqual({
      txId: TX,
      accepted: true,
      outcome: 'accepted'
    });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('relays waves operations with FEATURE_WAVES_ON_CHAIN=true, set while running', async () => {
    const { service, gateway } = setup(SWITCH_ON - 1);
    await expect(
      service.submit(walletSigned(WAVE_CREATE))
    ).rejects.toBeInstanceOf(WavesNotSwitchedOnException);
    process.env[FLAG] = 'true';
    await expect(service.submit(walletSigned(WAVE_CREATE))).resolves.toEqual(
      expect.objectContaining({ outcome: 'accepted' })
    );
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it.each(OTHER_OPS)(
    'relays %s before the switch-on (identity and the rest)',
    async (_name, opType) => {
      const { service, gateway } = setup(SWITCH_ON - 1);
      await expect(service.submit(walletSigned(opType))).resolves.toEqual(
        expect.objectContaining({ outcome: 'accepted' })
      );
      expect(gateway.submit).toHaveBeenCalledTimes(1);
    }
  );

  it('relays bytes whose head cannot be read: the chain refuses them', async () => {
    const { service, gateway } = setup(SWITCH_ON - 1);
    await expect(
      service.submit({ txId: TX, signed: '0xabcd' })
    ).resolves.toEqual(expect.objectContaining({ outcome: 'accepted' }));
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    '',
    'false',
    '0',
    String(Math.floor(SWITCH_ON / 1000)),
    String(SWITCH_ON * 1000),
    '2026-11-31T00:00:00Z',
    '2026-11-28T00:00:00',
    '28 Nov 2026'
  ])('never switches on with WAVES_SWITCH_ON_AT=%p', async (raw) => {
    if (raw === undefined) delete process.env[AT];
    else process.env[AT] = raw;
    const { service, gateway } = setup(Date.UTC(2099, 0, 1));
    await expect(service.submit(walletSigned(VOTE_SET))).rejects.toBeInstanceOf(
      WavesNotSwitchedOnException
    );
    expect(gateway.submit).not.toHaveBeenCalled();
  });
});

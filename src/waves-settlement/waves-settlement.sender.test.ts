import { recoverAddress, TypedDataEncoder } from 'ethers';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  ChainDraft,
  ChainDraftRequest,
  ChainSubmitRequest,
  ChainSubmitResult,
  ChainTx
} from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import {
  settlementSignerFromEnv,
  SettlementSignerResult
} from './settlement-signer';
import {
  SettlementSend,
  SettlementSendStatus,
  SettlementSendStore
} from './waves-settlement.db';
import {
  ChainSettlement,
  SETTLEMENT_RESEND_AFTER_MS,
  WavesSettlementSender
} from './waves-settlement.sender';

// The well-known first test account of Hardhat and Anvil; it holds nothing.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ZERO32 = '0x' + '00'.repeat(32);
const START = 1_764_000_000_000;
const MINUTE = 60_000;

const DOMAIN = {
  name: '6529 Network',
  version: '1',
  salt: '0x' + 'ab'.repeat(32)
};
const TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'salt', type: 'bytes32' }
  ],
  SettlementRequest: [
    { name: 'header', type: 'TxHeader' },
    { name: 'body', type: 'SettlementRequestBody' }
  ],
  SettlementRequestBody: [
    { name: 'decisionId', type: 'bytes32' },
    { name: 'occurrence', type: 'uint32' },
    { name: 'maxEntries', type: 'uint16' }
  ],
  TxHeader: [
    { name: 'ruleVersion', type: 'uint32' },
    { name: 'principal', type: 'bytes32' },
    { name: 'keyType', type: 'uint8' },
    { name: 'keyId', type: 'bytes32' },
    { name: 'authRef', type: 'bytes32' },
    { name: 'nonceLane', type: 'uint32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'ethRefNumber', type: 'uint64' },
    { name: 'ethRefHash', type: 'bytes32' },
    { name: 'feeMode', type: 'uint8' },
    { name: 'sponsorRef', type: 'bytes32' },
    { name: 'maxFee', type: 'uint128' },
    { name: 'maxWork', type: 'uint64' },
    { name: 'tipPerRU', type: 'uint128' }
  ]
};

function decisionId(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

interface FakeDecision {
  occurrence: number;
  due: boolean;
  count: { status: string; stage: string; next: number } | null;
  maxEntries: number;
}

/** The chain as the gateway shows it: due decisions, drafts, the pool. */
class FakeGateway {
  readonly decisions = new Map<string, FakeDecision>();
  readonly txs = new Map<string, ChainTx>();
  readonly drafts: ChainDraftRequest[] = [];
  readonly submitted: { txId: string; lane: number; signer: string }[] = [];
  /** How long each call takes on the fake clock. */
  callMs = 0;
  submitAnswer: () => ChainSubmitResult | Error = () => ({
    txId: '',
    accepted: true
  });
  tamper: (draft: ChainDraft) => ChainDraft = (draft) => draft;
  private readonly byUnsigned = new Map<
    string,
    { txId: string; lane: number }
  >();
  private readonly nonces = new Map<number, number>();

  constructor(private readonly clock: { now: number }) {}

  due(id: string, decision: Partial<FakeDecision> = {}) {
    this.decisions.set(id, {
      occurrence: 1,
      due: true,
      count: null,
      maxEntries: 100,
      ...decision
    });
  }

  private tick() {
    this.clock.now += this.callMs;
  }

  async read<T>(path: string, query: unknown, opts: unknown) {
    this.tick();
    expect(path).toBe('/v1/decisions/due');
    expect(opts).toEqual({ at: 'head' });
    const decisions: ChainSettlement[] = Array.from(this.decisions.entries())
      .filter(([, d]) => d.due)
      .map(([id, d]) => ({
        decisionId: id,
        counted: true,
        due: true,
        status: 'published',
        phase: 'open',
        occurrence: d.occurrence,
        resultTime: START,
        activeEntries: 250,
        count: d.count,
        maxEntriesPerRequest: d.maxEntries,
        draft: {
          opType: 'SETTLEMENT_REQUEST',
          body: {
            decisionId: id,
            occurrence: d.occurrence,
            maxEntries: d.maxEntries
          }
        }
      }));
    return {
      read: {} as never,
      data: { at: this.clock.now, count: decisions.length, decisions } as T,
      next: null
    };
  }

  async getDraft(request: ChainDraftRequest): Promise<ChainDraft> {
    this.tick();
    this.drafts.push(request);
    expect(request.opType).toBe('SETTLEMENT_REQUEST');
    expect(request.principal).toBeUndefined();
    const lane = request.nonceLane ?? 0;
    const header = {
      ruleVersion: 7,
      principal: ZERO32,
      keyType: 1,
      keyId: '0x' + '00'.repeat(12) + request.signer!.slice(2),
      authRef: ZERO32,
      nonceLane: lane,
      nonce: String(this.nonces.get(lane) ?? 0),
      notBefore: String(this.clock.now),
      expiresAt: String(this.clock.now + (request.validForMs ?? 3_600_000)),
      ethRefNumber: '0',
      ethRefHash: ZERO32,
      feeMode: 1,
      sponsorRef: ZERO32,
      maxFee: '1000',
      maxWork: '500000',
      tipPerRU: '0'
    };
    const message = { header, body: request.body };
    const { EIP712Domain: _, ...types } = TYPES;
    const txId = TypedDataEncoder.hash(DOMAIN, types, message);
    const unsigned = '0x0609' + txId.slice(2);
    this.byUnsigned.set(unsigned, { txId, lane });
    return this.tamper({
      txId,
      opType: 0x0609,
      opName: 'SETTLEMENT_REQUEST',
      opVersion: 1,
      typedData: {
        domain: DOMAIN,
        primaryType: 'SettlementRequest',
        types: TYPES,
        message
      },
      unsigned,
      envelope: {},
      signatures: [{ role: 0, keyType: 1, signer: request.signer! }],
      fee: {},
      readAt: 1
    });
  }

  async submit(request: ChainSubmitRequest): Promise<ChainSubmitResult> {
    this.tick();
    if (!('unsigned' in request)) throw new Error('expected unsigned');
    const { txId, lane } = this.byUnsigned.get(request.unsigned)!;
    expect(request.signatures).toHaveLength(1);
    expect(request.signatures[0]).toEqual(
      expect.objectContaining({ role: 0, keyType: 1 })
    );
    const signer = recoverAddress(txId, request.signatures[0].sig);
    const answer = this.submitAnswer();
    if (answer instanceof Error) throw answer;
    this.submitted.push({ txId, lane, signer: signer.toLowerCase() });
    if (answer.accepted) this.txs.set(txId, { status: 'pending' });
    return { ...answer, txId };
  }

  async getTx(txId: string): Promise<ChainTx | null> {
    this.tick();
    return this.txs.get(txId) ?? null;
  }

  /** The request lands: its nonce is spent and the chain moves the count. */
  land(txId: string, status: ChainTx['status'] = 'in_block') {
    const sent = this.submitted.find((it) => it.txId === txId)!;
    this.nonces.set(sent.lane, (this.nonces.get(sent.lane) ?? 0) + 1);
    this.txs.set(txId, { status, height: 10 });
  }

  lastTx(): string {
    return this.submitted[this.submitted.length - 1].txId;
  }
}

class MemoryStore implements SettlementSendStore {
  readonly rows = new Map<string, SettlementSend>();

  async load(
    decisionIds: string[],
    statuses: SettlementSendStatus[],
    sentAfter: number
  ) {
    return Array.from(this.rows.values()).filter(
      (row) =>
        decisionIds.includes(row.decision_id) ||
        (statuses.includes(row.status) && row.sent_at > sentAfter)
    );
  }

  async save(row: SettlementSend) {
    this.rows.set(row.decision_id, { ...row });
  }
}

const testSigner = () =>
  settlementSignerFromEnv({ WAVES_SETTLEMENT_SENDER_KEY: TEST_KEY });

function setup({
  signer = testSigner,
  realTime = false
}: { signer?: () => SettlementSignerResult; realTime?: boolean } = {}) {
  const clock = { now: START };
  const gateway = new FakeGateway(clock);
  const store = new MemoryStore();
  const sender = new WavesSettlementSender({
    gateway,
    store,
    signer,
    now: realTime ? () => Date.now() : () => clock.now
  });
  const run = (budgetMs = 20_000) => sender.run({ budgetMs });
  const later = (ms = MINUTE) => {
    clock.now += ms;
  };
  return { gateway, store, sender, run, later };
}

const D1 = decisionId(1);
const D2 = decisionId(2);

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('WavesSettlementSender', () => {
  it('sends nothing when nothing is due', async () => {
    const { gateway, store, run } = setup();
    await expect(run()).resolves.toEqual(
      expect.objectContaining({ due: 0, sent: 0, budgetSpent: false })
    );
    expect(gateway.drafts).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('sends one request for a due decision, signed by the sender wallet, and not again while it is pending', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1, { occurrence: 3, maxEntries: 40 });

    expect(await run()).toEqual(
      expect.objectContaining({ due: 1, sent: 1, waiting: 0 })
    );
    expect(gateway.drafts).toEqual([
      {
        opType: 'SETTLEMENT_REQUEST',
        signer: SENDER,
        body: { decisionId: D1, occurrence: 3, maxEntries: 40 },
        nonceLane: 0,
        validForMs: 300_000
      }
    ]);
    expect(gateway.submitted).toEqual([
      { txId: expect.any(String), lane: 0, signer: SENDER }
    ]);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        occurrence: 3,
        count_next: null,
        nonce_lane: 0,
        tx_id: gateway.lastTx(),
        status: 'submitted',
        last_error: null
      })
    );

    for (let minute = 1; minute <= 9; minute++) {
      later();
      expect(await run()).toEqual(
        expect.objectContaining({ due: 1, sent: 0, waiting: 1 })
      );
    }
    expect(gateway.drafts).toHaveLength(1);
    expect(store.rows.get(D1)?.status).toBe('pending');
  });

  it('sends again after the request failed in its block', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    await run();
    const first = gateway.lastTx();
    gateway.land(first, 'failed');
    gateway.txs.set(first, {
      status: 'failed',
      height: 10,
      result: { code: '0x261b', name: 'RESULT_NOT_DUE' }
    });

    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(gateway.submitted).toHaveLength(2);
    expect(gateway.lastTx()).not.toBe(first);
    expect(gateway.submitted[1].lane).toBe(0);
    expect(store.rows.get(D1)?.status).toBe('submitted');
  });

  it('sends again once a request was not seen in a block in time', async () => {
    const { gateway, run, later } = setup();
    gateway.due(D1);
    await run();
    // The gateway's nodes lost it.
    gateway.txs.clear();

    later(SETTLEMENT_RESEND_AFTER_MS - 1);
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(gateway.submitted).toHaveLength(1);

    later(1);
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(gateway.submitted).toHaveLength(2);
    // The same lane: the expired request and its replacement share a nonce.
    expect(gateway.submitted[1].lane).toBe(gateway.submitted[0].lane);
  });

  it('sends one request per step while the count is scoring', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1, { maxEntries: 100 });

    await run();
    const first = gateway.lastTx();
    gateway.land(first);
    // The head has not shown the step yet: no second request for it.
    later();
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(gateway.submitted).toHaveLength(1);

    gateway.due(D1, {
      maxEntries: 100,
      count: { status: 'counting', stage: 'scoring', next: 100 }
    });
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    gateway.land(gateway.lastTx());
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ count_next: 100, nonce_lane: 0 })
    );

    gateway.due(D1, {
      maxEntries: 100,
      count: { status: 'counting', stage: 'scoring', next: 200 }
    });
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    gateway.land(gateway.lastTx(), 'final');

    // The count closed: the decision is no longer due.
    gateway.decisions.clear();
    later();
    expect(await run()).toEqual(expect.objectContaining({ due: 0, sent: 0 }));
    expect(gateway.submitted).toHaveLength(3);
    expect(gateway.drafts.map((it) => it.body)).toEqual([
      { decisionId: D1, occurrence: 1, maxEntries: 100 },
      { decisionId: D1, occurrence: 1, maxEntries: 100 },
      { decisionId: D1, occurrence: 1, maxEntries: 100 }
    ]);
  });

  it('sends no second request while its own may still run, even when another sender moved the count', async () => {
    const { gateway, run, later } = setup();
    gateway.due(D1);
    await run();
    const ours = gateway.lastTx();

    // Someone else's request counted the first step; ours is still pending
    // and would count the next one itself.
    gateway.due(D1, {
      count: { status: 'counting', stage: 'scoring', next: 100 }
    });
    later();
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(gateway.submitted).toHaveLength(1);

    gateway.land(ours);
    gateway.due(D1, {
      count: { status: 'counting', stage: 'scoring', next: 200 }
    });
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
  });

  it('sends a decision again in its own nonce lane', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    gateway.due(D2);
    await run();
    expect(gateway.submitted.map((it) => it.lane)).toEqual([0, 1]);

    // D1's request counted its result; D2's was lost.
    gateway.land(gateway.submitted[0].txId, 'final');
    gateway.decisions.delete(D1);
    gateway.txs.delete(gateway.submitted[1].txId);
    later(SETTLEMENT_RESEND_AFTER_MS);
    expect(await run()).toEqual(expect.objectContaining({ due: 1, sent: 1 }));
    expect(gateway.submitted[2].lane).toBe(1);
    expect(store.rows.get(D2)?.nonce_lane).toBe(1);
  });

  it('saves a refusal, never throws it, and tries again on the next run', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    gateway.due(D2);
    gateway.submitAnswer = () =>
      new ChainGatewayError(
        '/v1/submit: inadmissible: 0x0402 INSUFFICIENT_BALANCE',
        422,
        'inadmissible',
        '/v1/submit'
      );

    expect(await run()).toEqual(
      expect.objectContaining({ due: 2, refused: 2, sent: 0 })
    );
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        status: 'refused',
        last_error: expect.stringContaining('INSUFFICIENT_BALANCE')
      })
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[SETTLEMENT REFUSED]')
    );

    gateway.submitAnswer = () => ({ txId: '', accepted: false });
    later();
    expect(await run()).toEqual(expect.objectContaining({ refused: 2 }));
    expect(store.rows.get(D2)?.last_error).toBe('not accepted');

    gateway.submitAnswer = () => ({ txId: '', accepted: true });
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 2 }));
  });

  it('keeps a submit with no clear answer and asks the gateway about it next run', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    gateway.submitAnswer = () =>
      new ChainGatewayError(
        '/v1/submit: timeout',
        null,
        'timeout',
        '/v1/submit'
      );

    expect(await run()).toEqual(expect.objectContaining({ errors: 1 }));
    const row = store.rows.get(D1)!;
    expect(row).toEqual(
      expect.objectContaining({
        status: 'submitting',
        tx_id: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        last_error: expect.stringContaining('timeout')
      })
    );

    // It reached the pool after all.
    gateway.txs.set(row.tx_id!, { status: 'pending' });
    gateway.submitAnswer = () => ({ txId: '', accepted: true });
    later();
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(gateway.drafts).toHaveLength(1);
    expect(store.rows.get(D1)?.status).toBe('pending');
  });

  it('gives each request in flight its own nonce lane, at most 16', async () => {
    const { gateway, run } = setup();
    for (let n = 1; n <= 17; n++) gateway.due(decisionId(n));

    expect(await run()).toEqual(
      expect.objectContaining({ due: 17, sent: 16, waiting: 1 })
    );
    expect(
      gateway.submitted.map((it) => it.lane).sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 16 }, (_, lane) => lane));
  });

  it('never signs a draft other than the request asked for', async () => {
    const { gateway, store, run } = setup();
    gateway.due(D1);
    gateway.tamper = (draft) => {
      const typed = draft.typedData as any;
      return {
        ...draft,
        typedData: {
          ...typed,
          message: {
            ...typed.message,
            header: { ...typed.message.header, tipPerRU: '1000000' }
          }
        }
      };
    };
    expect(await run()).toEqual(
      expect.objectContaining({ errors: 1, sent: 0 })
    );
    expect(gateway.submitted).toHaveLength(0);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        status: 'error',
        tx_id: null,
        last_error: expect.stringContaining('paying a tip')
      })
    );

    // Typed data that is not what the txId hashes.
    gateway.tamper = (draft) => ({ ...draft, txId: '0x' + '22'.repeat(32) });
    expect(await run()).toEqual(expect.objectContaining({ errors: 1 }));
    expect(store.rows.get(D1)?.last_error).toContain(
      'signing another digest than its typed data'
    );
    expect(gateway.submitted).toHaveLength(0);
  });

  it('skips the run with no key, and logs that once', async () => {
    const { gateway, run } = setup({
      signer: () => settlementSignerFromEnv({})
    });
    gateway.due(D1);
    expect(await run()).toEqual(
      expect.objectContaining({ skipped: 'missing_key', due: 0, sent: 0 })
    );
    await run();
    expect(gateway.drafts).toHaveLength(0);
    const offs = warn.mock.calls.filter(([line]) =>
      String(line).includes('[SETTLEMENT SENDER OFF]')
    );
    expect(offs).toHaveLength(1);
    expect(offs[0][0]).toContain('missing');
  });

  it('skips the run with a malformed key and never logs the key', async () => {
    const key = TEST_KEY.slice(0, 40);
    const { run } = setup({
      signer: () =>
        settlementSignerFromEnv({ WAVES_SETTLEMENT_SENDER_KEY: key })
    });
    expect(await run()).toEqual(
      expect.objectContaining({ skipped: 'malformed_key' })
    );
    for (const [line] of warn.mock.calls) {
      expect(String(line)).not.toContain(key.slice(2));
    }
  });

  it('starts nothing past its budget', async () => {
    const { gateway, store, run } = setup();
    for (let n = 1; n <= 5; n++) gateway.due(decisionId(n));
    // Each call takes 3 s: a due read, a load, then a draft and a submit
    // per decision.
    gateway.callMs = 3_000;

    const report = await run(20_000);
    expect(report).toEqual(expect.objectContaining({ budgetSpent: true }));
    expect(report.sent).toBe(3);
    expect(gateway.submitted).toHaveLength(3);
    expect(store.rows.size).toBe(3);
  });

  it('stops waiting on a gateway call at the end of its budget', async () => {
    const { gateway, sender } = setup({ realTime: true });
    gateway.read = () => new Promise<never>(() => undefined);
    const started = Date.now();
    expect(await sender.run({ budgetMs: 100 })).toEqual(
      expect.objectContaining({ budgetSpent: true, due: 0 })
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps a request whose submit outlasted the budget, and checks it before sending again', async () => {
    const { gateway, store, sender } = setup({ realTime: true });
    gateway.due(D1);
    const submit = gateway.submit.bind(gateway);
    gateway.submit = () => new Promise<never>(() => undefined);

    expect(await sender.run({ budgetMs: 200 })).toEqual(
      expect.objectContaining({ budgetSpent: true, sent: 0 })
    );
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        status: 'submitting',
        tx_id: expect.stringMatching(/^0x[0-9a-f]{64}$/)
      })
    );

    // The gateway has not seen it (yet): wait rather than send again.
    gateway.submit = submit;
    expect(await sender.run({ budgetMs: 1_000 })).toEqual(
      expect.objectContaining({ waiting: 1, sent: 0 })
    );
    expect(gateway.drafts).toHaveLength(1);
    expect(store.rows.get(D1)?.status).toBe('unknown');
  });
});

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
  settlementDomain,
  SETTLEMENT_TYPES,
  settlementSettingsFromEnv
} from './settlement-draft';
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
  backoffMs,
  ChainSettlement,
  nonceLaneOf,
  SETTLEMENT_GIVE_UP_PAUSE_MS,
  SETTLEMENT_MAX_BACKOFF_MS,
  SETTLEMENT_MAX_FAILURES,
  SETTLEMENT_RESEND_AFTER_MS,
  mainStageDecisionIdsOf,
  mainStageFirst,
  WAVES_IMPORT_RUNNING_CODE,
  WavesSettlementSender
} from './waves-settlement.sender';

// The well-known first test account of Hardhat and Anvil; it holds nothing.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ZERO32 = '0x' + '00'.repeat(32);
const NETWORK = '0x' + 'ab'.repeat(32);
const START = 1_764_000_000_000;
const MINUTE = 60_000;

type Types = Record<string, { name: string; type: string }[]>;

function decisionId(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

/** `count` decision ids whose nonce lanes differ. */
function idsOnDistinctLanes(count: number): string[] {
  const lanes = new Set<number>();
  const ids: string[] = [];
  for (let n = 1; ids.length < count; n++) {
    if (n > 1_000) throw new Error('no decision ids on distinct lanes');
    const id = decisionId(n);
    if (lanes.has(nonceLaneOf(id))) continue;
    lanes.add(nonceLaneOf(id));
    ids.push(id);
  }
  return ids;
}

/** The header an honest gateway drafts for the sender. */
function headerFor(request: ChainDraftRequest, now: number, nonce: number) {
  return {
    ruleVersion: 7,
    principal: ZERO32,
    keyType: 1,
    keyId: '0x' + '00'.repeat(12) + request.signer!.slice(2),
    authRef: ZERO32,
    nonceLane: request.nonceLane ?? 0,
    nonce: String(nonce),
    notBefore: String(now - 2_000),
    expiresAt: String(now + (request.validForMs ?? 3_600_000)),
    ethRefNumber: '0',
    ethRefHash: ZERO32,
    feeMode: 3,
    sponsorRef: ZERO32,
    maxFee: request.maxFee ?? '1000000000000000000',
    maxWork: '6000000',
    tipPerRU: '0'
  };
}

/** A draft whose txId is the digest of its typed data. */
function draftOf({
  header,
  body,
  signer,
  types = SETTLEMENT_TYPES,
  domain = settlementDomain(NETWORK),
  worst = '1000000000000000000'
}: {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
  signer: string;
  types?: Types;
  domain?: Record<string, unknown>;
  worst?: string;
}): ChainDraft {
  const message = { header, body };
  const txId = TypedDataEncoder.hash(domain, types, message);
  return {
    txId,
    opType: 0x0609,
    opName: 'SETTLEMENT_REQUEST',
    opVersion: 1,
    typedData: {
      domain,
      primaryType: 'SettlementRequest',
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'salt', type: 'bytes32' }
        ],
        ...types
      },
      message
    },
    unsigned: '0x0609' + txId.slice(2),
    envelope: {},
    signatures: [{ role: 0, keyType: 1, signer }],
    fee: { worst, maxFee: header.maxFee },
    readAt: 1
  };
}

interface FakeDecision {
  occurrence: number;
  count: { status: string; stage: string; next: number } | null;
  maxEntries: number;
}

/** The chain as the gateway shows it: due decisions, drafts, the pool. */
class FakeGateway {
  readonly decisions = new Map<string, FakeDecision>();
  readonly txs = new Map<string, ChainTx>();
  readonly drafts: ChainDraftRequest[] = [];
  readonly submitted: { txId: string; lane: number; signer: string }[] = [];
  readonly reads: unknown[] = [];
  /** The network id the reads name; null: none. */
  network: string | null = NETWORK;
  /** The due count the answer gives, when not the list's length. */
  reportedCount: number | null = null;
  /** The worst-case fee the drafts name. */
  worst = '1000000000000000000';
  /** Whether the chain's waves import is complete; null: no answer. */
  importCompleted: boolean | null = true;
  importReads = 0;
  /** How long each call takes on the fake clock. */
  callMs = 0;
  submitAnswer: () => ChainSubmitResult | Error = () => ({
    txId: '',
    accepted: true
  });
  /** Lets a test change the honest draft. */
  tamper: (draft: ChainDraft, request: ChainDraftRequest) => ChainDraft = (
    draft
  ) => draft;
  private readonly byUnsigned = new Map<
    string,
    { txId: string; lane: number }
  >();
  private readonly nonces = new Map<number, number>();

  constructor(private readonly clock: { now: number }) {}

  due(id: string, decision: Partial<FakeDecision> = {}) {
    this.decisions.set(id, {
      occurrence: 1,
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
    if (path === '/v1/waves/import') {
      expect(opts).toEqual({ at: 'head' });
      this.importReads++;
      return this.importCompleted === null
        ? null
        : {
            read: { network: this.network } as never,
            data: { completed: this.importCompleted } as T,
            next: null
          };
    }
    expect(path).toBe('/v1/decisions/due');
    expect(opts).toEqual({ at: 'head' });
    this.reads.push(query);
    const decisions: ChainSettlement[] = Array.from(
      this.decisions.entries()
    ).map(([id, d]) => ({
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
    const count = this.reportedCount ?? decisions.length;
    return {
      read: { network: this.network } as never,
      data: { at: this.clock.now, count, decisions } as T,
      next: null
    };
  }

  async getDraft(request: ChainDraftRequest): Promise<ChainDraft> {
    this.tick();
    this.drafts.push(request);
    expect(request.opType).toBe('SETTLEMENT_REQUEST');
    expect(request.principal).toBeUndefined();
    const lane = request.nonceLane ?? 0;
    const honest = draftOf({
      header: headerFor(request, this.clock.now, this.nonces.get(lane) ?? 0),
      body: request.body,
      signer: request.signer!,
      worst: this.worst
    });
    const draft = this.tamper(honest, request);
    this.byUnsigned.set(draft.unsigned, { txId: draft.txId, lane });
    return draft;
  }

  async submit(
    request: ChainSubmitRequest & { readonly txId: string }
  ): Promise<ChainSubmitResult> {
    this.tick();
    if (!('unsigned' in request)) throw new Error('expected unsigned');
    const { txId, lane } = this.byUnsigned.get(request.unsigned)!;
    // The client ties the answer to the draft's txId.
    expect(request.txId).toBe(txId);
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

  /** The request lands: its nonce is spent. */
  land(
    txId: string,
    status: ChainTx['status'] = 'in_block',
    result: ChainTx['result'] = status === 'failed'
      ? { code: '0x261b', name: 'RESULT_NOT_DUE', feePaid: '900' }
      : undefined
  ) {
    const sent = this.submitted.find((it) => it.txId === txId)!;
    this.nonces.set(sent.lane, (this.nonces.get(sent.lane) ?? 0) + 1);
    this.txs.set(txId, { status, height: 10, result });
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
  env = {},
  realTime = false,
  mainStage = []
}: {
  signer?: () => SettlementSignerResult;
  env?: NodeJS.ProcessEnv;
  realTime?: boolean;
  mainStage?: string[];
} = {}) {
  // The fake gateway drafts at the clock's time.
  const clock = { now: realTime ? Date.now() : START };
  const gateway = new FakeGateway(clock);
  const store = new MemoryStore();
  const sender = new WavesSettlementSender({
    gateway,
    store,
    signer,
    settings: () => settlementSettingsFromEnv(env),
    now: realTime ? () => Date.now() : () => clock.now,
    // As MAIN_STAGE_DECISION_IDS is read.
    mainStage: () => mainStageDecisionIdsOf(mainStage.join(','))
  });
  const run = (budgetMs = 20_000) => sender.run({ budgetMs });
  const later = (ms = MINUTE) => {
    clock.now += ms;
  };
  return { gateway, store, sender, run, later };
}

const [D1, D2] = idsOnDistinctLanes(2);

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
let info: jest.SpyInstance;

beforeEach(() => {
  info = jest
    .spyOn(Logger.prototype, 'info')
    .mockImplementation(() => undefined);
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

function logged(spy: jest.SpyInstance, marker: string): string[] {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes(marker));
}

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
    expect(gateway.reads).toEqual([{ limit: 500 }]);
    expect(gateway.drafts).toEqual([
      {
        opType: 'SETTLEMENT_REQUEST',
        signer: SENDER,
        body: { decisionId: D1, occurrence: 3, maxEntries: 40 },
        nonceLane: nonceLaneOf(D1),
        validForMs: 300_000,
        maxFee: '100000000000000000000'
      }
    ]);
    expect(gateway.submitted).toEqual([
      { txId: expect.any(String), lane: nonceLaneOf(D1), signer: SENDER }
    ]);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        occurrence: 3,
        count_next: null,
        nonce_lane: nonceLaneOf(D1),
        attempts: 1,
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

    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(gateway.submitted).toHaveLength(2);
    expect(gateway.lastTx()).not.toBe(first);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ status: 'submitted', attempts: 2 })
    );
    expect(logged(warn, '[SETTLEMENT FAILED]')[0]).toContain('RESULT_NOT_DUE');
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
    expect(gateway.submitted.map((it) => it.lane)).toEqual([
      nonceLaneOf(D1),
      nonceLaneOf(D1)
    ]);
  });

  it('backs off up to 15 minutes, gives a step up after 8 paid failures, and tries it again hours later', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    const sentAt: number[] = [];
    for (let minute = 0; minute < 430; minute++) {
      const before = gateway.submitted.length;
      await run();
      if (gateway.submitted.length > before) {
        sentAt.push(minute);
        // Each of the first 8 lands and fails in its block, paying its fee.
        if (sentAt.length <= SETTLEMENT_MAX_FAILURES) {
          gateway.land(gateway.lastTx(), 'failed');
        }
      }
      if (minute === 100) {
        expect(store.rows.get(D1)).toEqual(
          expect.objectContaining({
            status: 'given_up',
            attempts: 8,
            failures: 8
          })
        );
        expect(await run()).toEqual(expect.objectContaining({ givenUp: 1 }));
      }
      later();
    }
    // Waits of 1, 2, 4, 8, then 15 minutes; then six hours after the last.
    const retry = 60 + SETTLEMENT_GIVE_UP_PAUSE_MS / MINUTE;
    expect(sentAt).toEqual([0, 1, 3, 7, 15, 30, 45, 60, retry]);
    expect(backoffMs(3)).toBe(4 * MINUTE);
    expect(backoffMs(9)).toBe(SETTLEMENT_MAX_BACKOFF_MS);
    expect(logged(error, '[SETTLEMENT GIVEN UP]')).toHaveLength(1);
    expect(logged(warn, '[SETTLEMENT TRYING AGAIN]')).toHaveLength(1);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ status: 'pending', attempts: 1, failures: 0 })
    );

    // Another sender counted the step: the next one starts again.
    gateway.land(gateway.lastTx());
    gateway.due(D1, {
      count: { status: 'counting', stage: 'scoring', next: 100 }
    });
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ attempts: 1, failures: 0, count_next: 100 })
    );
  });

  it('never gives a step up for refusals, which pay no fee', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    gateway.submitAnswer = () =>
      new ChainGatewayError(
        '/v1/submit: inadmissible: 0x0305 FEE_UNCOVERED, detail 0',
        422,
        'inadmissible',
        '/v1/submit'
      );
    const refusedAt: number[] = [];
    for (let minute = 0; minute < 300; minute++) {
      const report = await run();
      if (report.refused) refusedAt.push(minute);
      later();
    }
    expect(refusedAt.slice(0, 7)).toEqual([0, 1, 3, 7, 15, 30, 45]);
    expect(refusedAt).toHaveLength(23);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ status: 'refused', failures: 0 })
    );
    expect(logged(error, '[SETTLEMENT GIVEN UP]')).toHaveLength(0);

    // The wallet is topped up: the next try goes within 15 minutes.
    gateway.submitAnswer = () => ({ txId: '', accepted: true });
    let sentAfter = -1;
    for (let minute = 0; minute <= 15 && sentAfter < 0; minute++) {
      if ((await run()).sent) sentAfter = minute;
      later();
    }
    expect(sentAfter).toBeGreaterThanOrEqual(0);
  });

  it('backs off on drafts the gateway could not make, and never gives up', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    const getDraft = gateway.getDraft.bind(gateway);
    gateway.getDraft = async () => {
      throw new ChainGatewayError('/v1/draft: busy', 503, 'busy', '/v1/draft');
    };
    let errors = 0;
    for (let minute = 0; minute < 120; minute++) {
      errors += (await run()).errors;
      later();
    }
    // 0, 1, 3, 7, 15, then every 15 minutes.
    expect(errors).toBe(11);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        status: 'error',
        attempts: 11,
        failures: 0,
        tx_id: null
      })
    );
    gateway.getDraft = getDraft;
    later(SETTLEMENT_MAX_BACKOFF_MS);
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
  });

  it('counts a refusal as a try and waits before the next', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    gateway.submitAnswer = () => ({ txId: '', accepted: false });
    expect(await run()).toEqual(expect.objectContaining({ refused: 1 }));
    later();
    expect(await run()).toEqual(expect.objectContaining({ refused: 1 }));
    later();
    // The second refusal waits two minutes.
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(store.rows.get(D1)?.attempts).toBe(2);
  });

  it('asks for its cap as maxFee and sends nothing while fees are above it', async () => {
    const { gateway, store, run, later } = setup({
      env: { WAVES_SETTLEMENT_MAX_FEE: '5000000000000000000' }
    });
    gateway.due(D1);
    gateway.worst = '6000000000000000000';
    expect(await run()).toEqual(
      expect.objectContaining({ errors: 1, sent: 0 })
    );
    expect(gateway.drafts[0].maxFee).toBe('5000000000000000000');
    expect(gateway.submitted).toHaveLength(0);
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({
        status: 'error',
        attempts: 1,
        last_error: expect.stringContaining(
          'the worst-case fee 6000000000000000000 is over the maxFee 5000000000000000000'
        )
      })
    );

    // Base fees fell.
    gateway.worst = '4000000000000000000';
    later();
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
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
      expect.objectContaining({ count_next: 100, attempts: 1 })
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

  it('takes each decision its own lane, keccak of its id mod 16', async () => {
    expect(nonceLaneOf(decisionId(1))).toBe(6);
    expect(nonceLaneOf(decisionId(2))).toBe(14);
    expect(nonceLaneOf(decisionId(3))).toBe(11);
    expect(nonceLaneOf(decisionId(4))).toBe(11);

    // Two decisions on one lane: one request at a time in it.
    const { gateway, run, later } = setup();
    gateway.due(decisionId(3));
    gateway.due(decisionId(4));
    expect(await run()).toEqual(
      expect.objectContaining({ due: 2, sent: 1, waiting: 1 })
    );
    gateway.land(gateway.lastTx(), 'final');
    later();
    expect(await run()).toEqual(
      expect.objectContaining({ sent: 1, waiting: 1 })
    );
    expect(gateway.drafts.map((it) => it.nonceLane)).toEqual([11, 11]);
    expect(gateway.drafts.map((it) => it.body.decisionId)).toEqual([
      decisionId(3),
      decisionId(4)
    ]);
  });

  it('saves a refusal and never throws it', async () => {
    const { gateway, store, run } = setup();
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
        attempts: 1,
        last_error: expect.stringContaining('INSUFFICIENT_BALANCE')
      })
    );
    expect(logged(warn, '[SETTLEMENT REFUSED]')).toHaveLength(2);
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

  it.each([504, 409, null])(
    'takes an outcome_unknown submit (status %p) as unclear: no refusal, no second request while it may run',
    async (status) => {
      const { gateway, store, run, later } = setup();
      gateway.due(D1);
      gateway.submitAnswer = () =>
        new ChainGatewayError(
          '/v1/submit: the outcome is unknown (bad_answer): ask getTx',
          status,
          'outcome_unknown',
          '/v1/submit'
        );
      expect(await run()).toEqual(expect.objectContaining({ errors: 1 }));
      expect(store.rows.get(D1)).toEqual(
        expect.objectContaining({ status: 'submitting', attempts: 1 })
      );
      // Not seen yet: the sender waits for it, and sends nothing new.
      gateway.submitAnswer = () => ({ txId: '', accepted: true });
      later();
      expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
      expect(gateway.drafts).toHaveLength(1);
    }
  );

  it('saves a transaction status it does not know as unknown', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    await run();
    gateway.txs.set(gateway.lastTx(), {
      status: 'a status far longer than sixteen characters' as never
    });
    later();
    await run();
    expect(store.rows.get(D1)?.status).toBe('unknown');
  });

  it('reads the largest page of due decisions and says when it is cut', async () => {
    const { gateway, run } = setup();
    gateway.due(D1);
    gateway.reportedCount = 900;
    await run();
    expect(gateway.reads).toEqual([{ limit: 500 }]);
    expect(logged(warn, '[SETTLEMENT DUE LIST CUT]')).toEqual([
      expect.stringContaining('[900 due] [1 read]')
    ]);
  });

  describe('never signs a draft other than the request asked for', () => {
    const TRANSFER_TYPES: Types = {
      BalanceTransfer: [
        { name: 'header', type: 'TxHeader' },
        { name: 'body', type: 'BalanceTransferBody' }
      ],
      BalanceTransferBody: [
        { name: 'assetId', type: 'bytes32' },
        { name: 'amount', type: 'uint128' },
        { name: 'recipientKind', type: 'uint8' },
        { name: 'recipient', type: 'bytes32' }
      ],
      TxHeader: SETTLEMENT_TYPES.TxHeader
    };
    const header = (draft: ChainDraft) =>
      (draft.typedData as { message: { header: Record<string, unknown> } })
        .message.header;
    const body = (draft: ChainDraft) =>
      (draft.typedData as { message: { body: Record<string, unknown> } })
        .message.body;

    it.each<[string, (draft: ChainDraft) => ChainDraft, string]>([
      [
        "another operation's types, with the asked-for fields as decoys",
        (draft) =>
          draftOf({
            header: header(draft),
            body: {
              ...body(draft),
              assetId: '0x' + 'cc'.repeat(32),
              amount: '1000000000000000000000',
              recipientKind: 2,
              recipient: '0x' + '00'.repeat(12) + 'bb'.repeat(20)
            },
            signer: SENDER,
            types: TRANSFER_TYPES
          }),
        'txId'
      ],
      [
        'another domain',
        (draft) =>
          draftOf({
            header: header(draft),
            body: body(draft),
            signer: SENDER,
            domain: settlementDomain('0x' + 'cd'.repeat(32))
          }),
        'txId'
      ],
      [
        'a request valid for a day',
        (draft) =>
          draftOf({
            header: {
              ...header(draft),
              expiresAt: String(START + 86_400_000)
            },
            body: body(draft),
            signer: SENDER
          }),
        'expiresAt'
      ],
      [
        'a maxFee over the cap',
        (draft) =>
          draftOf({
            header: {
              ...header(draft),
              maxFee: '100000000000000000001'
            },
            body: body(draft),
            signer: SENDER
          }),
        'maxFee'
      ],
      [
        'a tip',
        (draft) =>
          draftOf({
            header: { ...header(draft), tipPerRU: '1000000' },
            body: body(draft),
            signer: SENDER
          }),
        'tipPerRU'
      ]
    ])('refuses %s, unsigned', async (_, tamper, field) => {
      const { gateway, store, run } = setup();
      gateway.due(D1);
      gateway.tamper = tamper;
      expect(await run()).toEqual(
        expect.objectContaining({ errors: 1, sent: 0 })
      );
      expect(gateway.submitted).toHaveLength(0);
      expect(store.rows.get(D1)).toEqual(
        expect.objectContaining({
          status: 'error',
          tx_id: null,
          attempts: 1,
          last_error: expect.stringContaining(field)
        })
      );
    });
  });

  it('signs only for the network a setting pins', async () => {
    const pinned = '0x' + 'ef'.repeat(32);
    const { gateway, run } = setup({
      env: { WAVES_SETTLEMENT_NETWORK_ID: pinned }
    });
    gateway.due(D1);
    expect(await run()).toEqual(
      expect.objectContaining({ skipped: 'wrong_network', sent: 0 })
    );
    await run();
    expect(gateway.drafts).toHaveLength(0);
    expect(logged(warn, 'the gateway reads network')).toHaveLength(1);
  });

  it('skips the run when no network id is known', async () => {
    const { gateway, run } = setup();
    gateway.due(D1);
    gateway.network = null;
    expect(await run()).toEqual(
      expect.objectContaining({ skipped: 'no_network' })
    );
    expect(gateway.drafts).toHaveLength(0);
  });

  it('skips the run with a malformed setting', async () => {
    const { gateway, run } = setup({
      env: { WAVES_SETTLEMENT_MAX_FEE: 'lots' }
    });
    gateway.due(D1);
    expect(await run()).toEqual(
      expect.objectContaining({ skipped: 'malformed_settings' })
    );
    expect(logged(warn, 'WAVES_SETTLEMENT_MAX_FEE is malformed')).toHaveLength(
      1
    );
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
    const offs = logged(warn, '[SETTLEMENT SENDER OFF]');
    expect(offs).toHaveLength(1);
    expect(offs[0]).toContain('missing');
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
    for (const id of idsOnDistinctLanes(5)) gateway.due(id);
    // Each call takes 3 s: the waves import's read, a due read, then a
    // draft and a submit per decision.
    gateway.callMs = 3_000;

    const report = await run(20_000);
    expect(report).toEqual(expect.objectContaining({ budgetSpent: true }));
    expect(report.sent).toBe(2);
    expect(gateway.submitted).toHaveLength(2);
    // The third was drafted and saved before the budget ran out; its
    // submit wasn't made, and the next run asks the gateway about it.
    expect(store.rows.size).toBe(3);
    expect(
      Array.from(store.rows.values()).filter(
        (row) => row.status === 'submitting'
      )
    ).toHaveLength(1);
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

describe('WavesSettlementSender and the Main Stage', () => {
  it('sends the Main Stage first, even last of 45 due in the gateway list', async () => {
    const ids = Array.from({ length: 45 }, (_, n) => decisionId(n + 1));
    const main = ids[44];
    const { gateway, run } = setup({
      mainStage: [main.toUpperCase().replace('0X', '0x')]
    });
    for (const id of ids) gateway.due(id);
    const report = await run();
    expect(report.due).toBe(45);
    expect((gateway.drafts[0].body as { decisionId: string }).decisionId).toBe(
      main
    );
    expect(gateway.submitted[0].lane).toBe(nonceLaneOf(main));
    // The rest go in the gateway's order, as before (a decision whose lane
    // a request already holds waits for a later run).
    const rest = gateway.drafts
      .slice(1)
      .map((d) => (d.body as { decisionId: string }).decisionId);
    expect(rest.length).toBeGreaterThan(5);
    expect(rest).not.toContain(main);
    expect(rest).toEqual([...rest].sort());
  });

  it('reads MAIN_STAGE_DECISION_IDS in lowercase and orders the Main Stage first', () => {
    const [a, b] = [decisionId(7), decisionId(8)];
    expect(
      mainStageDecisionIdsOf(
        ` ${a.toUpperCase().replace('0X', '0x')} , nope, ${b}`
      )
    ).toEqual(new Set([a, b]));
    expect(mainStageDecisionIdsOf(undefined)).toEqual(new Set());
    const row = (id: string) => ({ decisionId: id }) as ChainSettlement;
    expect(
      mainStageFirst(
        [row(decisionId(1)), row(b), row(decisionId(2))],
        new Set([b])
      ).map((it) => it.decisionId)
    ).toEqual([b, decisionId(1), decisionId(2)]);
  });

  it('never gives the Main Stage up: it keeps trying every 15 minutes at most, with an error for each failure from the eighth', async () => {
    const { gateway, store, run, later } = setup({ mainStage: [D1] });
    gateway.due(D1);
    const sentAt: number[] = [];
    for (let minute = 0; minute < 200; minute++) {
      const before = gateway.submitted.length;
      await run();
      if (gateway.submitted.length > before) {
        sentAt.push(minute);
        // Each of the first 10 lands and fails in its block.
        if (sentAt.length <= 10) gateway.land(gateway.lastTx(), 'failed');
      }
      later();
    }
    // Waits of 1, 2, 4, 8, then 15 minutes, with no pause after the eighth.
    expect(sentAt.slice(0, 12)).toEqual([
      0, 1, 3, 7, 15, 30, 45, 60, 75, 90, 105, 120
    ]);
    expect(logged(error, '[SETTLEMENT GIVEN UP]')).toHaveLength(0);
    const failing = logged(error, '[MAIN STAGE SETTLEMENT FAILING]');
    expect(failing).toHaveLength(3);
    expect(failing[0]).toContain(`[decision ${D1}]`);
    expect(failing[0]).toContain('8 requests failed');
    expect(failing[0]).toContain('RESULT_NOT_DUE');
    expect(failing[2]).toContain('10 requests failed');
    expect(store.rows.get(D1)?.status).not.toBe('given_up');
  });

  it('tries again at once a Main Stage step an earlier version gave up', async () => {
    const { gateway, store, run } = setup({ mainStage: [D1] });
    gateway.due(D1);
    await store.save({
      decision_id: D1,
      occurrence: 1,
      count_next: null as unknown as number,
      nonce_lane: nonceLaneOf(D1),
      attempts: 8,
      failures: 8,
      sent_at: START,
      tx_id: null,
      status: 'given_up',
      last_error: 'failed'
    } as never);
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
  });

  it('keeps the six-hour pause for every other decision', async () => {
    const { gateway, store, run, later } = setup({ mainStage: [D2] });
    gateway.due(D1);
    for (let minute = 0; minute <= 100; minute++) {
      const before = gateway.submitted.length;
      await run();
      if (gateway.submitted.length > before) {
        gateway.land(gateway.lastTx(), 'failed');
      }
      later();
    }
    expect(store.rows.get(D1)?.status).toBe('given_up');
    expect(logged(error, '[MAIN STAGE SETTLEMENT FAILING]')).toHaveLength(0);
  });
});

describe('WavesSettlementSender and the waves import', () => {
  it('sends nothing while the chain says its waves import is not complete, logged once', async () => {
    const { gateway, store, run, later } = setup();
    gateway.due(D1);
    for (const answer of [false, null] as const) {
      gateway.importCompleted = answer;
      expect(await run()).toEqual(
        expect.objectContaining({ skipped: 'waves_import_running', due: 0 })
      );
      later();
    }
    expect(gateway.reads).toEqual([]);
    expect(gateway.drafts).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(logged(info, '[SETTLEMENT SENDER WAITS]')).toHaveLength(1);
    gateway.importCompleted = true;
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(gateway.importReads).toBe(3);
  });

  it('takes a refusal for the running import as "not yet": no failure, no wait', async () => {
    const { gateway, store, run } = setup();
    gateway.due(D1);
    gateway.submitAnswer = () =>
      new ChainGatewayError(
        '/v1/submit: inadmissible: 0x2507 WAVES_IMPORT_RUNNING, detail 0',
        422,
        'inadmissible',
        '/v1/submit'
      );
    for (let run_ = 0; run_ < 3; run_++) {
      expect(await run()).toEqual(
        expect.objectContaining({ waiting: 1, refused: 0 })
      );
      expect(store.rows.get(D1)).toEqual(
        expect.objectContaining({ status: 'refused', attempts: 0, failures: 0 })
      );
    }
    // Each run asked again, with no backoff between.
    expect(gateway.drafts).toHaveLength(3);
    gateway.submitAnswer = () => ({ txId: '', accepted: true });
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
  });

  it('takes a draft the running import refused as "not yet"', async () => {
    const { gateway, store, run } = setup();
    gateway.due(D1);
    const getDraft = gateway.getDraft.bind(gateway);
    gateway.getDraft = async () => {
      throw new ChainGatewayError(
        '/v1/draft: inadmissible: 0x2507 WAVES_IMPORT_RUNNING',
        422,
        'inadmissible',
        '/v1/draft'
      );
    };
    expect(await run()).toEqual(expect.objectContaining({ waiting: 1 }));
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ attempts: 0, failures: 0 })
    );
    gateway.getDraft = getDraft;
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
  });

  it('takes a request that failed in its block on the running import as "not yet"', async () => {
    const { gateway, store, run } = setup();
    gateway.due(D1);
    await run();
    gateway.land(gateway.lastTx(), 'failed', {
      code: WAVES_IMPORT_RUNNING_CODE,
      name: 'WAVES_IMPORT_RUNNING',
      feePaid: '900'
    });
    // No failure counted, and sent again at once.
    expect(await run()).toEqual(expect.objectContaining({ sent: 1 }));
    expect(store.rows.get(D1)).toEqual(
      expect.objectContaining({ failures: 0, attempts: 1 })
    );
    expect(logged(warn, '[SETTLEMENT FAILED]')).toHaveLength(0);
  });
});

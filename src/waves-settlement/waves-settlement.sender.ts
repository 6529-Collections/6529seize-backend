import { TypedDataEncoder } from 'ethers';
import {
  chainGatewayClient,
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import { ChainDraft } from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import {
  SettlementSigner,
  settlementSignerFromEnv,
  SettlementSignerResult
} from './settlement-signer';
import {
  SettlementSend,
  SettlementSendStatus,
  SettlementSendStore,
  wavesSettlementSendsDb
} from './waves-settlement.db';

/**
 * 6529.io's settlement sender. A decision result due on the 6529 chain is
 * counted by a SETTLEMENT_REQUEST that anyone may send; the first that lands
 * counts, and one that arrives after the count closed fails and still pays
 * its fee. Each run reads the decisions due now, and for each one with no
 * request of ours in flight drafts a request, signs its txId with the sender
 * wallet and submits it. A count larger than `maxEntriesPerRequest` takes
 * several requests: the next one goes once the chain shows the last one
 * counted (count.stage `scoring` with a new `next`), at most one a run.
 *
 * At most one request per decision may run at a time. Each request uses a
 * nonce lane of the wallet (16), kept by its decision while the request may
 * run, and expires after SETTLEMENT_VALID_FOR_MS. A request that failed, was
 * refused, or was not seen in a block after SETTLEMENT_RESEND_AFTER_MS (by
 * then expired) is sent again.
 */

const logger = Logger.get('WAVES_SETTLEMENT_SENDER');

/** SETTLEMENT_REQUEST's operation code. */
const SETTLEMENT_REQUEST_OP = 0x0609;
/** Nonce lanes per namespace (a header's nonceLane is 0 to 15). */
const NONCE_LANES = 16;
/** A request can't execute after this long (its `expiresAt`). */
export const SETTLEMENT_VALID_FOR_MS = 5 * 60_000;
/** A request not seen in a block by then has expired and is sent again. */
export const SETTLEMENT_RESEND_AFTER_MS = 10 * 60_000;
/** Statuses of a request that may still execute. */
const MAY_RUN: readonly SettlementSendStatus[] = [
  'submitting',
  'submitted',
  'pending',
  'unknown'
];
const DUE_LIMIT = 100;
const ZERO32 = '0x' + '00'.repeat(32);
const HEX32 = /^0x[0-9a-f]{64}$/;

/** A row of GET /v1/decisions/due: a decision's settlement object. */
export interface ChainSettlement {
  readonly decisionId: string;
  readonly counted: boolean;
  readonly due: boolean;
  readonly status: string;
  readonly phase: string;
  readonly occurrence: number;
  readonly resultTime: number;
  readonly activeEntries: number;
  readonly count: {
    readonly status: string;
    readonly stage: string;
    readonly next: number;
  } | null;
  readonly maxEntriesPerRequest: number | null;
  /** When due: the POST /v1/draft request, less the signer. */
  readonly draft: {
    readonly opType: string;
    readonly body: {
      readonly decisionId: string;
      readonly occurrence: number;
      readonly maxEntries: number;
    };
  } | null;
}

export interface SettlementReport {
  due: number;
  sent: number;
  /** Due, with a request of ours still in flight or no free nonce lane. */
  waiting: number;
  refused: number;
  errors: number;
  budgetSpent: boolean;
  skipped?: 'missing_key' | 'malformed_key';
}

type Outcome = 'sent' | 'waiting' | 'refused' | 'errors';

/** One step of a count: what a request is for. */
interface Step {
  readonly decisionId: string;
  readonly occurrence: number;
  /** The count's `next`; null before the count starts. */
  readonly next: number | null;
  readonly maxEntries: number;
}

export interface SettlementSenderDeps {
  readonly gateway: Pick<
    ChainGatewayClient,
    'read' | 'getDraft' | 'submit' | 'getTx'
  >;
  readonly store: SettlementSendStore;
  readonly signer: () => SettlementSignerResult;
  readonly now: () => number;
}

class BudgetSpent extends Error {
  constructor() {
    super('The settlement sender used its time');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Timed = <T>(work: () => Promise<T>) => Promise<T>;

export class WavesSettlementSender {
  /** The last key state logged, so each change is logged once. */
  private noted: string | null = null;

  constructor(private readonly deps: SettlementSenderDeps) {}

  /**
   * One pass, within `budgetMs`. Throws only when the due list can't be
   * read or the table can't be read or written; anything one decision's
   * request meets is saved and logged.
   */
  async run({ budgetMs }: { budgetMs: number }): Promise<SettlementReport> {
    const report: SettlementReport = {
      due: 0,
      sent: 0,
      waiting: 0,
      refused: 0,
      errors: 0,
      budgetSpent: false
    };
    const key = this.signer();
    if (!key.ok) {
      return { ...report, skipped: `${key.problem}_key` };
    }
    const deadline = this.deps.now() + budgetMs;
    const timed: Timed = (work) => this.beforeDeadline(work, deadline);
    try {
      const due = await timed(() => this.readDue());
      report.due = due.length;
      if (!due.length) return report;
      const rows = await this.loadRows(due, timed);
      for (const settlement of due) {
        if (this.deps.now() >= deadline) throw new BudgetSpent();
        report[await this.settle(settlement, rows, key.signer, timed)]++;
      }
    } catch (error) {
      if (!(error instanceof BudgetSpent)) throw error;
      report.budgetSpent = true;
    }
    return report;
  }

  private signer(): SettlementSignerResult {
    const key = this.deps.signer();
    const note = key.ok ? key.signer.address : key.problem;
    if (note !== this.noted) {
      this.noted = note;
      if (key.ok) {
        logger.info(`[SETTLEMENT SENDER] [wallet ${key.signer.address}]`);
      } else {
        logger.warn(
          `[SETTLEMENT SENDER OFF] WAVES_SETTLEMENT_SENDER_KEY is ${key.problem}; nothing is sent`
        );
      }
    }
    return key;
  }

  /**
   * Read at the head. `due` is figured at the read's block time, and a
   * request lands in a later block, so a decision due at the head is due
   * when the request runs. The head also has every count step that landed:
   * a finalized read lags a few blocks and could ask again for a step
   * already counted. Drafts take their nonce from the head too.
   */
  private async readDue(): Promise<ChainSettlement[]> {
    const answer = await this.deps.gateway.read<{
      decisions?: ChainSettlement[];
    }>('/v1/decisions/due', { limit: DUE_LIMIT }, { at: 'head' });
    const decisions = answer?.data?.decisions;
    return Array.isArray(decisions)
      ? decisions.filter((it) => it?.due === true)
      : [];
  }

  /**
   * The rows of the due decisions and of every request that may still run
   * (their nonce lanes are taken), each checked with the gateway.
   */
  private async loadRows(
    due: ChainSettlement[],
    timed: Timed
  ): Promise<Map<string, SettlementSend>> {
    const loaded = await this.deps.store.load(
      due.map((it) => lower(it.decisionId)),
      [...MAY_RUN, 'in_block'],
      this.deps.now() - SETTLEMENT_RESEND_AFTER_MS
    );
    const rows = new Map(loaded.map((row) => [row.decision_id, row]));
    for (const row of loaded) {
      const open = MAY_RUN.includes(row.status) || row.status === 'in_block';
      if (!row.tx_id || !open || this.expired(row)) continue;
      const txId = row.tx_id;
      let status: SettlementSendStatus;
      let lastError = row.last_error;
      try {
        const tx = await timed(() => this.deps.gateway.getTx(txId));
        status = tx?.status ?? 'unknown';
        if (tx?.status === 'failed') {
          lastError = `failed in block ${tx.height}: ${tx.result?.code} ${tx.result?.name}`;
          logger.warn(
            `[SETTLEMENT FAILED] [decision ${row.decision_id}] [tx ${txId}] ${lastError}`
          );
        }
      } catch (error) {
        if (error instanceof BudgetSpent) throw error;
        logger.warn(`[SETTLEMENT TX UNREAD] [tx ${txId}] ${describe(error)}`);
        continue;
      }
      if (status !== row.status) {
        await this.save({ ...row, status, last_error: lastError }, rows);
      }
    }
    return rows;
  }

  private async settle(
    settlement: ChainSettlement,
    rows: Map<string, SettlementSend>,
    signer: SettlementSigner,
    timed: Timed
  ): Promise<Outcome> {
    const step = stepOf(settlement);
    if (!step) {
      logger.warn(
        `[SETTLEMENT ROW UNREADABLE] ${JSON.stringify(settlement).slice(0, 500)}`
      );
      return 'errors';
    }
    // A closed count has nothing left to send.
    if (settlement.count?.stage === 'final') return 'waiting';
    const row = rows.get(step.decisionId);
    if (!this.shouldSend(row, step)) return 'waiting';
    const lane = this.freeLane(step.decisionId, row, rows);
    if (lane === null) return 'waiting';
    const base = {
      decision_id: step.decisionId,
      occurrence: step.occurrence,
      count_next: step.next,
      nonce_lane: lane,
      sent_at: this.deps.now()
    };
    let draft: ChainDraft;
    let entry: { role: number; keyType: number };
    try {
      draft = await timed(() =>
        this.deps.gateway.getDraft({
          opType: 'SETTLEMENT_REQUEST',
          signer: signer.address,
          body: {
            decisionId: step.decisionId,
            occurrence: step.occurrence,
            maxEntries: step.maxEntries
          },
          nonceLane: lane,
          validForMs: SETTLEMENT_VALID_FOR_MS
        })
      );
      entry = checkDraft(draft, step, signer.address, lane);
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      const lastError = `draft: ${describe(error)}`;
      logger.warn(
        `[SETTLEMENT NOT SENT] [decision ${step.decisionId}] ${lastError}`
      );
      await this.save(
        { ...base, tx_id: null, status: 'error', last_error: lastError },
        rows
      );
      return 'errors';
    }
    const txId = draft.txId.toLowerCase();
    const sig = signer.sign(txId);
    // Saved before the submit: when its answer is lost, the next run asks
    // the gateway about this txId instead of sending again.
    const sending: SettlementSend = {
      ...base,
      tx_id: txId,
      status: 'submitting',
      last_error: null
    };
    await this.save(sending, rows);
    const where = `[decision ${step.decisionId}] [occurrence ${step.occurrence}] [next ${step.next}] [lane ${lane}] [tx ${txId}]`;
    try {
      const result = await timed(() =>
        this.deps.gateway.submit({
          unsigned: draft.unsigned,
          signatures: [{ role: entry.role, keyType: entry.keyType, sig }]
        })
      );
      if (!result.accepted) {
        logger.warn(`[SETTLEMENT REFUSED] ${where} not accepted`);
        await this.save(
          { ...sending, status: 'refused', last_error: 'not accepted' },
          rows
        );
        return 'refused';
      }
      logger.info(`[SETTLEMENT SENT] ${where}`);
      await this.save({ ...sending, status: 'submitted' }, rows);
      return 'sent';
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      const lastError = `submit: ${describe(error)}`;
      if (isRefusal(error)) {
        logger.warn(`[SETTLEMENT REFUSED] ${where} ${lastError}`);
        await this.save(
          { ...sending, status: 'refused', last_error: lastError },
          rows
        );
        return 'refused';
      }
      // The gateway may have relayed it: it stays `submitting`, and the
      // next run asks the gateway about it.
      logger.warn(`[SETTLEMENT SUBMIT UNCLEAR] ${where} ${lastError}`);
      await this.save({ ...sending, last_error: lastError }, rows);
      return 'errors';
    }
  }

  private shouldSend(row: SettlementSend | undefined, step: Step): boolean {
    // Never sent, or the last attempt ended before it had a transaction.
    if (!row?.tx_id) return true;
    if (['refused', 'error', 'failed'].includes(row.status)) return true;
    if (this.expired(row)) return true;
    // One request per decision may run at a time.
    if (MAY_RUN.includes(row.status)) return false;
    // It landed (in_block or final): the next request goes once the chain
    // shows the next step.
    return row.occurrence !== step.occurrence || row.count_next !== step.next;
  }

  /**
   * The decision's own lane when no other decision's request may run in
   * it, otherwise the lowest free lane; null when all 16 are taken.
   */
  private freeLane(
    decisionId: string,
    row: SettlementSend | undefined,
    rows: Map<string, SettlementSend>
  ): number | null {
    const taken = new Set<number>();
    for (const other of Array.from(rows.values())) {
      if (other.decision_id === decisionId || !other.tx_id) continue;
      if (MAY_RUN.includes(other.status) && !this.expired(other)) {
        taken.add(other.nonce_lane);
      }
    }
    if (row && !taken.has(row.nonce_lane)) return row.nonce_lane;
    for (let lane = 0; lane < NONCE_LANES; lane++) {
      if (!taken.has(lane)) return lane;
    }
    return null;
  }

  private expired(row: SettlementSend): boolean {
    return this.deps.now() - row.sent_at >= SETTLEMENT_RESEND_AFTER_MS;
  }

  private async save(
    row: SettlementSend,
    rows: Map<string, SettlementSend>
  ): Promise<void> {
    await this.deps.store.save(row);
    rows.set(row.decision_id, row);
  }

  /** The work's answer, or BudgetSpent once the deadline passes. */
  private async beforeDeadline<T>(
    work: () => Promise<T>,
    deadline: number
  ): Promise<T> {
    const left = deadline - this.deps.now();
    if (left <= 0) throw new BudgetSpent();
    let timer: NodeJS.Timeout | undefined;
    const spent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BudgetSpent()), left);
    });
    try {
      return await Promise.race([work(), spent]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The step a due row asks for, or null when the row can't be read. */
function stepOf(settlement: ChainSettlement): Step | null {
  const decisionId = lower(settlement?.decisionId);
  const occurrence = settlement?.occurrence;
  const next = settlement?.count ? settlement.count.next : null;
  const body = settlement?.draft?.body;
  const maxEntries = body?.maxEntries;
  const readable =
    HEX32.test(decisionId) &&
    isCount(occurrence) &&
    (next === null || isCount(next)) &&
    lower(body?.decisionId) === decisionId &&
    body?.occurrence === occurrence &&
    isCount(maxEntries) &&
    maxEntries >= 1 &&
    maxEntries <= 0xffff;
  return readable ? { decisionId, occurrence, next, maxEntries } : null;
}

interface DraftTypedData {
  readonly domain?: Record<string, unknown>;
  readonly types?: Record<string, { name: string; type: string }[]>;
  readonly primaryType?: string;
  readonly message?: {
    readonly header?: Record<string, unknown>;
    readonly body?: Record<string, unknown>;
  };
}

/**
 * Checks that the draft is the request asked for and that its txId is its
 * typed data's EIP-712 digest, so the sender key signs nothing else.
 * Returns the signature entry the draft names for the sender.
 */
function checkDraft(
  draft: ChainDraft,
  step: Step,
  signer: string,
  lane: number
): { role: number; keyType: number } {
  const typed = draft.typedData as DraftTypedData;
  const header = typed?.message?.header ?? {};
  const body = typed?.message?.body ?? {};
  const refuse = (what: string): never => {
    throw new Error(`the draft is ${what}`);
  };
  if (
    draft.opType !== SETTLEMENT_REQUEST_OP ||
    typed?.primaryType !== 'SettlementRequest'
  ) {
    refuse('not a SETTLEMENT_REQUEST');
  }
  if (
    lower(body.decisionId) !== step.decisionId ||
    Number(body.occurrence) !== step.occurrence ||
    Number(body.maxEntries) !== step.maxEntries
  ) {
    refuse('for another decision, occurrence or size');
  }
  if (
    lower(header.principal) !== ZERO32 ||
    Number(header.keyType) !== 1 ||
    lower(header.keyId) !== '0x' + '00'.repeat(12) + signer.slice(2) ||
    Number(header.nonceLane) !== lane
  ) {
    refuse('for another account, key or nonce lane');
  }
  if (String(header.tipPerRU) !== '0') refuse('paying a tip');
  const types = Object.fromEntries(
    Object.entries(typed.types ?? {}).filter(
      ([name]) => name !== 'EIP712Domain'
    )
  );
  const digest = TypedDataEncoder.hash(
    typed.domain ?? {},
    types,
    typed.message ?? {}
  );
  if (digest.toLowerCase() !== lower(draft.txId)) {
    refuse('signing another digest than its typed data');
  }
  const entries = draft.signatures ?? [];
  if (
    entries.length !== 1 ||
    lower(entries[0].signer) !== signer ||
    entries[0].keyType !== 1
  ) {
    refuse('asking for another signature');
  }
  return { role: entries[0].role, keyType: entries[0].keyType };
}

/** A refusal: the gateway or the chain read the request and said no. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 1000);
}

export const wavesSettlementSender = new WavesSettlementSender({
  gateway: chainGatewayClient,
  store: wavesSettlementSendsDb,
  signer: () => settlementSignerFromEnv(),
  now: () => Date.now()
});

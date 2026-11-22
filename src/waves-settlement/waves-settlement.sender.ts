import { keccak256 } from 'ethers';
import {
  chainGatewayClient,
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import { ChainDraft } from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import {
  checkSettlementDraft,
  SettlementSettings,
  settlementSettingsFromEnv,
  SettlementSettingsResult
} from './settlement-draft';
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
 * request of ours in flight drafts a request, checks the draft
 * (settlement-draft.ts), signs its txId with the sender wallet and submits
 * it. A count larger than `maxEntriesPerRequest` takes several requests: the
 * next one goes once the chain shows the last one counted (count.stage
 * `scoring` with a new `next`), at most one a run.
 *
 * At most one request per decision may run at a time. A request expires
 * after SETTLEMENT_VALID_FOR_MS. One that failed, was refused, or was not
 * seen in a block after SETTLEMENT_RESEND_AFTER_MS (by then expired) is sent
 * again, after a wait that doubles each time (SETTLEMENT_BACKOFF_MS); after
 * SETTLEMENT_MAX_ATTEMPTS requests for one step the sender gives up on it
 * and logs `[SETTLEMENT GIVEN UP]`.
 *
 * Run one sender key in one sending environment per chain. Each decision's
 * requests use a nonce lane derived from its id, so when a second sender
 * with the same key (a staging set up with prod's key, say) drafts at the
 * same time, both requests take the same lane and nonce and only one can
 * execute. One drafted after the other landed is a new transaction and can
 * still pay a fee for nothing.
 */

const logger = Logger.get('WAVES_SETTLEMENT_SENDER');

/** A request can't execute after this long (its `expiresAt`). */
export const SETTLEMENT_VALID_FOR_MS = 5 * 60_000;
/** A request not seen in a block by then has expired and is sent again. */
export const SETTLEMENT_RESEND_AFTER_MS = 10 * 60_000;
/** Requests for one step of a count before the sender gives up on it. */
export const SETTLEMENT_MAX_ATTEMPTS = 8;
/** The wait before the second request for one step; it doubles each time. */
export const SETTLEMENT_BACKOFF_MS = 60_000;
/** Statuses of a request that may still execute. */
const MAY_RUN: readonly SettlementSendStatus[] = [
  'submitting',
  'submitted',
  'pending',
  'unknown'
];
const LANDED: readonly SettlementSendStatus[] = ['in_block', 'final'];
const TX_STATUSES: readonly SettlementSendStatus[] = [
  'pending',
  'in_block',
  'final',
  'failed'
];
/** The API's largest page; the due list has no cursor. */
const DUE_LIMIT = 500;
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
  /** Due, with a request of ours in flight, its lane taken, or backing off. */
  waiting: number;
  refused: number;
  errors: number;
  givenUp: number;
  budgetSpent: boolean;
  skipped?:
    | 'missing_key'
    | 'malformed_key'
    | 'malformed_settings'
    | 'no_network'
    | 'wrong_network';
}

type Outcome = 'sent' | 'waiting' | 'refused' | 'errors' | 'givenUp';

/** One step of a count: what a request is for. */
interface Step {
  readonly decisionId: string;
  readonly occurrence: number;
  /** The count's `next`; null before the count starts. */
  readonly next: number | null;
  readonly maxEntries: number;
}

/** What one run signs for. */
interface RunContext {
  readonly signer: SettlementSigner;
  readonly settings: SettlementSettings;
  readonly networkId: string;
  readonly timed: Timed;
}

export interface SettlementSenderDeps {
  readonly gateway: Pick<
    ChainGatewayClient,
    'read' | 'getDraft' | 'submit' | 'getTx'
  >;
  readonly store: SettlementSendStore;
  readonly signer: () => SettlementSignerResult;
  readonly settings: () => SettlementSettingsResult;
  readonly now: () => number;
}

class BudgetSpent extends Error {
  constructor() {
    super('The settlement sender used its time');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Timed = <T>(work: () => Promise<T>) => Promise<T>;

/** The nonce lane every request for this decision uses: keccak(id) mod 16. */
export function nonceLaneOf(decisionId: string): number {
  return parseInt(keccak256(decisionId).slice(-1), 16);
}

/** The wait after `attempts` requests for one step before the next. */
export function backoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : SETTLEMENT_BACKOFF_MS * Math.pow(2, attempts - 1);
}

export class WavesSettlementSender {
  /** The last state logged per subject, so each change is logged once. */
  private readonly noted = new Map<string, string>();

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
      givenUp: 0,
      budgetSpent: false
    };
    const key = this.deps.signer();
    this.noteOnce(
      'key',
      key.ok ? key.signer.address : key.problem,
      key.ok
        ? () =>
            logger.info(`[SETTLEMENT SENDER] [wallet ${key.signer.address}]`)
        : () =>
            logger.warn(
              `[SETTLEMENT SENDER OFF] WAVES_SETTLEMENT_SENDER_KEY is ${key.problem}; nothing is sent`
            )
    );
    if (!key.ok) return { ...report, skipped: `${key.problem}_key` };
    const settings = this.deps.settings();
    this.noteOnce('settings', settings.ok ? '' : settings.problem, () => {
      if (!settings.ok) {
        logger.warn(`[SETTLEMENT SENDER OFF] ${settings.problem}`);
      }
    });
    if (!settings.ok) return { ...report, skipped: 'malformed_settings' };
    const deadline = this.deps.now() + budgetMs;
    const timed: Timed = (work) => this.beforeDeadline(work, deadline);
    try {
      const due = await timed(() => this.readDue());
      report.due = due.decisions.length;
      if (!due.decisions.length) return report;
      const pinned = settings.settings.networkId;
      const networkId = pinned ?? due.network;
      if (!networkId || (due.network && due.network !== networkId)) {
        this.noteOnce('network', `${due.network}`, () =>
          logger.warn(
            `[SETTLEMENT SENDER OFF] the gateway reads network ${due.network}; the sender signs for ${pinned ?? 'the gateway network'}`
          )
        );
        return {
          ...report,
          skipped: networkId ? 'wrong_network' : 'no_network'
        };
      }
      this.noted.delete('network');
      const run: RunContext = {
        signer: key.signer,
        settings: settings.settings,
        networkId,
        timed
      };
      const rows = await this.loadRows(due.decisions, timed);
      for (const settlement of due.decisions) {
        if (this.deps.now() >= deadline) throw new BudgetSpent();
        report[await this.settle(settlement, rows, run)]++;
      }
    } catch (error) {
      if (!(error instanceof BudgetSpent)) throw error;
      report.budgetSpent = true;
    }
    return report;
  }

  private noteOnce(subject: string, note: string, log: () => void) {
    if (this.noted.get(subject) === note) return;
    this.noted.set(subject, note);
    log();
  }

  /**
   * Read at the head. `due` is figured at the read's block time, and a
   * request lands in a later block, so a decision due at the head is due
   * when the request runs. The head also has every count step that landed:
   * a finalized read lags a few blocks and could ask again for a step
   * already counted. Drafts take their nonce from the head too.
   */
  private async readDue(): Promise<{
    decisions: ChainSettlement[];
    network: string | null;
  }> {
    const answer = await this.deps.gateway.read<{
      count?: number;
      decisions?: ChainSettlement[];
    }>('/v1/decisions/due', { limit: DUE_LIMIT }, { at: 'head' });
    const list = answer?.data?.decisions;
    const decisions = Array.isArray(list)
      ? list.filter((it) => it?.due === true)
      : [];
    const count = answer?.data?.count;
    if (
      Array.isArray(list) &&
      typeof count === 'number' &&
      count > list.length
    ) {
      logger.warn(
        `[SETTLEMENT DUE LIST CUT] [${count} due] [${list.length} read]`
      );
    }
    const network = lower(answer?.read?.network);
    return { decisions, network: HEX32.test(network) ? network : null };
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
      [...MAY_RUN, ...LANDED],
      this.deps.now() - SETTLEMENT_RESEND_AFTER_MS
    );
    const rows = new Map(loaded.map((row) => [row.decision_id, row]));
    for (const row of loaded) {
      const open = MAY_RUN.includes(row.status) || LANDED.includes(row.status);
      if (!row.tx_id || !open || this.expired(row)) continue;
      const txId = row.tx_id;
      let status: SettlementSendStatus;
      let lastError = row.last_error;
      try {
        const tx = await timed(() => this.deps.gateway.getTx(txId));
        status = tx && TX_STATUSES.includes(tx.status) ? tx.status : 'unknown';
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
    run: RunContext
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
    const plan = this.plan(row, step);
    if (plan === 'wait') return 'waiting';
    if (plan === 'give_up') return await this.giveUp(row!, rows);
    const lane = nonceLaneOf(step.decisionId);
    if (this.laneTaken(step.decisionId, lane, rows)) return 'waiting';
    const where = `[decision ${step.decisionId}] [occurrence ${step.occurrence}] [next ${step.next}] [lane ${lane}]`;
    const attempts = row && sameStep(row, step) ? row.attempts : 0;
    const base = {
      decision_id: step.decisionId,
      occurrence: step.occurrence,
      count_next: step.next,
      nonce_lane: lane,
      attempts,
      sent_at: this.deps.now()
    };
    let draft: ChainDraft;
    let checked: { txId: string; role: number; keyType: number };
    try {
      draft = await run.timed(() =>
        this.deps.gateway.getDraft({
          opType: 'SETTLEMENT_REQUEST',
          signer: run.signer.address,
          body: {
            decisionId: step.decisionId,
            occurrence: step.occurrence,
            maxEntries: step.maxEntries
          },
          nonceLane: lane,
          validForMs: SETTLEMENT_VALID_FOR_MS
        })
      );
      checked = checkSettlementDraft(draft, {
        ...step,
        signer: run.signer.address,
        lane,
        networkId: run.networkId,
        maxFee: run.settings.maxFee,
        validForMs: SETTLEMENT_VALID_FOR_MS,
        now: this.deps.now()
      });
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      // Not a request: the attempts stay as they were.
      const lastError = `draft: ${describe(error)}`;
      logger.warn(`[SETTLEMENT NOT SENT] ${where} ${lastError}`);
      await this.save(
        { ...base, tx_id: null, status: 'error', last_error: lastError },
        rows
      );
      return 'errors';
    }
    const sig = run.signer.sign(checked.txId);
    // Saved before the submit: when its answer is lost, the next run asks
    // the gateway about this txId instead of sending again.
    const sending: SettlementSend = {
      ...base,
      attempts: attempts + 1,
      tx_id: checked.txId,
      status: 'submitting',
      last_error: null
    };
    await this.save(sending, rows);
    const sent = `${where} [attempt ${attempts + 1}] [tx ${checked.txId}]`;
    try {
      const result = await run.timed(() =>
        this.deps.gateway.submit({
          unsigned: draft.unsigned,
          signatures: [{ role: checked.role, keyType: checked.keyType, sig }]
        })
      );
      if (!result.accepted) {
        logger.warn(`[SETTLEMENT REFUSED] ${sent} not accepted`);
        await this.save(
          { ...sending, status: 'refused', last_error: 'not accepted' },
          rows
        );
        return 'refused';
      }
      logger.info(`[SETTLEMENT SENT] ${sent}`);
      await this.save({ ...sending, status: 'submitted' }, rows);
      return 'sent';
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      const lastError = `submit: ${describe(error)}`;
      if (isRefusal(error)) {
        logger.warn(`[SETTLEMENT REFUSED] ${sent} ${lastError}`);
        await this.save(
          { ...sending, status: 'refused', last_error: lastError },
          rows
        );
        return 'refused';
      }
      // The gateway may have relayed it: it stays `submitting`, and the
      // next run asks the gateway about it.
      logger.warn(`[SETTLEMENT SUBMIT UNCLEAR] ${sent} ${lastError}`);
      await this.save({ ...sending, last_error: lastError }, rows);
      return 'errors';
    }
  }

  private plan(
    row: SettlementSend | undefined,
    step: Step
  ): 'send' | 'wait' | 'give_up' {
    if (!row) return 'send';
    const live = row.tx_id !== null && !this.expired(row);
    // One request per decision may run at a time, whatever its step.
    if (live && MAY_RUN.includes(row.status)) return 'wait';
    // A new step (or occurrence) starts its attempts again.
    if (!sameStep(row, step)) return 'send';
    // The same step: the request landed and the read has not caught up...
    if (live && LANDED.includes(row.status)) return 'wait';
    // ...or it is sent again, later each time, and only so many times.
    if (row.status === 'given_up' || row.attempts >= SETTLEMENT_MAX_ATTEMPTS) {
      return 'give_up';
    }
    return this.deps.now() >= row.sent_at + backoffMs(row.attempts)
      ? 'send'
      : 'wait';
  }

  private async giveUp(
    row: SettlementSend,
    rows: Map<string, SettlementSend>
  ): Promise<Outcome> {
    if (row.status !== 'given_up') {
      logger.error(
        `[SETTLEMENT GIVEN UP] [decision ${row.decision_id}] [occurrence ${row.occurrence}] [next ${row.count_next}] after ${row.attempts} requests, the last: ${row.status} ${row.last_error ?? ''}. The sender tries again at the next step, or once this row of waves_settlement_sends is deleted`
      );
      await this.save({ ...row, status: 'given_up' }, rows);
    }
    return 'givenUp';
  }

  /** Whether another decision's request that may still run holds the lane. */
  private laneTaken(
    decisionId: string,
    lane: number,
    rows: Map<string, SettlementSend>
  ): boolean {
    return Array.from(rows.values()).some(
      (other) =>
        other.decision_id !== decisionId &&
        other.nonce_lane === lane &&
        other.tx_id !== null &&
        MAY_RUN.includes(other.status) &&
        !this.expired(other)
    );
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

function sameStep(row: SettlementSend, step: Step): boolean {
  return row.occurrence === step.occurrence && row.count_next === step.next;
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
    occurrence <= 0xffffffff &&
    (next === null || isCount(next)) &&
    lower(body?.decisionId) === decisionId &&
    body?.occurrence === occurrence &&
    isCount(maxEntries) &&
    maxEntries >= 1 &&
    maxEntries <= 0xffff;
  return readable ? { decisionId, occurrence, next, maxEntries } : null;
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
  settings: () => settlementSettingsFromEnv(),
  now: () => Date.now()
});

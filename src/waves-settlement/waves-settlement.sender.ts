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
  CLOCK_SLACK_MS,
  SettlementSettings,
  settlementSettingsFromEnv,
  SettlementSettingsResult,
  worstFeeOf
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
 * after SETTLEMENT_VALID_FOR_MS and carries WAVES_SETTLEMENT_MAX_FEE as its
 * maxFee. A step is tried again when its request failed, was refused or was
 * not seen in a block after SETTLEMENT_RESEND_AFTER_MS (by then expired), or
 * when its draft could not be made, each time after a wait that doubles
 * from SETTLEMENT_BACKOFF_MS up to SETTLEMENT_MAX_BACKOFF_MS. Only requests
 * that failed in a block pay a fee: after SETTLEMENT_MAX_FAILURES of them
 * for one step the sender logs `[SETTLEMENT GIVEN UP]` and leaves the step
 * for SETTLEMENT_GIVE_UP_PAUSE_MS, then tries it again from the start and
 * logs `[SETTLEMENT TRYING AGAIN]`. Refusals, lost submits and gateway
 * errors never end the tries.
 *
 * A request the gateway took that no block holds by the time it expired
 * ("accepted, never included": a node that can't reach the chain's peers,
 * say) is logged as [SETTLEMENT NOT INCLUDED] and sent again. Nodes drop
 * such a request from their pool at its expiry and then answer that they
 * hold it nowhere (not_held): past the latest expiry its draft can carry,
 * that answer means never included. It pays no fee, so it doesn't count
 * toward giving up. The run of them is kept on the step's row until a
 * request reaches a block, whatever errors, refusals or "not yet" come in
 * between.
 *
 * The Main Stage (MAIN_STAGE_DECISION_IDS) is drafted and sent first in
 * every run, ahead of the gateway's order, and is never given up: from its
 * eighth paid failure on, each failure is an error naming what the tries
 * cost a day and how to stop them, and it is tried again 15 minutes after
 * the last try at most. From its second request in a row that was never
 * included, each is an error too. It can still wait for another decision's
 * request on its nonce lane, up to SETTLEMENT_RESEND_AFTER_MS.
 *
 * Nothing is sent while the chain's waves import is not complete
 * (GET /v1/waves/import); the chain's WAVES_IMPORT_RUNNING (0x2507), on a
 * draft, at admission or in a block, is "not yet": no failure, and the step
 * is tried again on the next run, whatever its earlier tries.
 *
 * Settings: WAVES_SETTLEMENT_SENDER_KEY (required);
 * MAIN_STAGE_DECISION_IDS; WAVES_SETTLEMENT_HOLD_DECISION_IDS (decision
 * ids, comma separated: nothing is sent for them, until taken out; claim
 * builds are not affected); and in settlement-draft.ts
 * WAVES_SETTLEMENT_NETWORK_ID (set it in production: without it the
 * network the requests are signed for is the one the gateway's read names)
 * and WAVES_SETTLEMENT_MAX_FEE. The id settings in force, and any id left
 * out as malformed, are logged once.
 *
 * Run one sender key in one sending environment per chain. Each decision's
 * requests use a nonce lane derived from its id. When a second sender with
 * the same key (a staging set up with prod's key, say) drafts at the same
 * time, both requests take the same lane and nonce: at most one can
 * execute, and nodes propose neither while both are held, so the two
 * senders stall each other until the requests expire. One drafted after the
 * other landed is a new transaction and can still pay a fee for nothing.
 */

const logger = Logger.get('WAVES_SETTLEMENT_SENDER');

/** A request can't execute after this long (its `expiresAt`). */
export const SETTLEMENT_VALID_FOR_MS = 5 * 60_000;
/** A request not seen in a block by then has expired and is sent again. */
export const SETTLEMENT_RESEND_AFTER_MS = 10 * 60_000;
/** Requests for one step that failed in a block before the sender stops. */
export const SETTLEMENT_MAX_FAILURES = 8;
/** How long a step is left after the sender gave up on it. */
export const SETTLEMENT_GIVE_UP_PAUSE_MS = 6 * 60 * 60_000;
/** The settings that hold decisions: nothing is sent for them. */
export const HOLD_DECISION_IDS_ENV = 'WAVES_SETTLEMENT_HOLD_DECISION_IDS';
export const MAIN_STAGE_DECISION_IDS_ENV = 'MAIN_STAGE_DECISION_IDS';
/** The wait before the second try for one step; it doubles each time... */
export const SETTLEMENT_BACKOFF_MS = 60_000;
/** ...up to this. */
export const SETTLEMENT_MAX_BACKOFF_MS = 15 * 60_000;
/** Main Stage requests a day at most, once each waits the full backoff. */
export const MAIN_STAGE_REQUESTS_A_DAY =
  (24 * 60 * 60_000) / SETTLEMENT_MAX_BACKOFF_MS;
/**
 * Past this after it was sent, a request is past the latest expiresAt its
 * draft can carry (its validity and the clock slack the draft check
 * allows, with a minute for the draft itself): no block can take it, and a
 * node that holds it nowhere never included it.
 */
export const SETTLEMENT_PAST_EXPIRY_MS =
  SETTLEMENT_VALID_FOR_MS + CLOCK_SLACK_MS + 60_000;
/**
 * The chain's refusal of every waves operation while its waves import runs
 * (WAVES_IMPORT_RUNNING): not a failure, only "not yet".
 */
export const WAVES_IMPORT_RUNNING_CODE = 0x2507;

/** Whether any of these (a code, a name, a message) is WAVES_IMPORT_RUNNING. */
export function isWavesImportRunning(...parts: unknown[]): boolean {
  return parts.some((part) =>
    typeof part === 'number'
      ? part === WAVES_IMPORT_RUNNING_CODE
      : typeof part === 'string' && /0x2507\b|WAVES_IMPORT_RUNNING/i.test(part)
  );
}

/**
 * A setting of chain decision ids (MAIN_STAGE_DECISION_IDS,
 * WAVES_SETTLEMENT_HOLD_DECISION_IDS): comma separated, each `0x` and 64
 * hex digits, read in lowercase as every reader of the setting reads them.
 * Anything else is left out, and named in `dropped`.
 */
export function decisionIdsSettingOf(value: string | null | undefined): {
  ids: ReadonlySet<string>;
  dropped: string[];
} {
  const ids = new Set<string>();
  const dropped: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (HEX32.test(id)) ids.add(id);
    else dropped.push(id);
  }
  return { ids, dropped };
}

/** MAIN_STAGE_DECISION_IDS as decisionIdsSettingOf reads it. */
export function mainStageDecisionIdsOf(
  value: string | null | undefined
): ReadonlySet<string> {
  return decisionIdsSettingOf(value).ids;
}

/**
 * The due decisions with the Main Stage's first, each part in the order
 * the gateway listed it: in each run the Main Stage is drafted and sent
 * before the others. (It can still wait for another decision's request on
 * its nonce lane: see laneTaken.)
 */
export function mainStageFirst(
  decisions: readonly ChainSettlement[],
  mainStage: ReadonlySet<string>
): ChainSettlement[] {
  const isMain = (it: ChainSettlement) => mainStage.has(lower(it?.decisionId));
  return [
    ...decisions.filter(isMain),
    ...decisions.filter((it) => !isMain(it))
  ];
}
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
    | 'wrong_network'
    | 'waves_import_running';
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
  /** MAIN_STAGE_DECISION_IDS: sent first, and never given up. */
  readonly mainStage: ReadonlySet<string>;
  /** WAVES_SETTLEMENT_HOLD_DECISION_IDS: nothing is sent for them. */
  readonly held: ReadonlySet<string>;
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
  /**
   * Where MAIN_STAGE_DECISION_IDS and WAVES_SETTLEMENT_HOLD_DECISION_IDS
   * are read; by default the environment.
   */
  readonly idSettings?: () => Readonly<Record<string, string | undefined>>;
  /** The gateway as logs name it; by default CHAIN_GATEWAY_URL's host. */
  readonly gatewayName?: () => string;
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

/** The wait after `attempts` tries for one step before the next. */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(
    SETTLEMENT_MAX_BACKOFF_MS,
    SETTLEMENT_BACKOFF_MS * Math.pow(2, Math.min(attempts, 30) - 1)
  );
}

/** What to do with a due decision this run. */
type Plan =
  | {
      readonly action: 'send';
      /** The tries and failures so far for this step. */
      readonly attempts: number;
      readonly failures: number;
    }
  | { readonly action: 'wait' }
  | { readonly action: 'give_up' };

const FRESH: Plan = { action: 'send', attempts: 0, failures: 0 };

export class WavesSettlementSender {
  /** The last state logged per subject, so each change is logged once. */
  private readonly noted = new Map<string, string>();

  constructor(private readonly deps: SettlementSenderDeps) {}

  /**
   * One pass, within `budgetMs`. Throws only when the waves import's state
   * or the due list can't be read, or the table can't be read or written;
   * anything one decision's request meets is saved and logged.
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
    const idSettings = this.deps.idSettings?.() ?? process.env;
    const mainStage = this.idSetting(
      MAIN_STAGE_DECISION_IDS_ENV,
      idSettings,
      'drafted and sent first, never given up'
    );
    const held = this.idSetting(
      HOLD_DECISION_IDS_ENV,
      idSettings,
      'held: nothing is sent for them'
    );
    const deadline = this.deps.now() + budgetMs;
    const timed: Timed = (work) => this.beforeDeadline(work, deadline);
    try {
      const imported = await timed(() => this.importState());
      const pinned = settings.settings.networkId;
      if (pinned && imported.network && imported.network !== pinned) {
        // Another chain's gateway: its import is no reason to wait.
        return {
          ...report,
          skipped: this.wrongNetwork(imported.network, pinned)
        };
      }
      // The chain refuses every waves operation until its waves import is
      // complete: nothing is sent before, and that is no failure.
      if (!imported.completed) {
        this.noteOnce('import', 'running', () =>
          logger.info(
            '[SETTLEMENT SENDER WAITS] [THE WAVES IMPORT IS NOT COMPLETE] nothing is sent until it is'
          )
        );
        return { ...report, skipped: 'waves_import_running' };
      }
      this.noted.delete('import');
      const due = await timed(() => this.readDue());
      report.due = due.decisions.length;
      if (!due.decisions.length) return report;
      const networkId = pinned ?? due.network;
      if (!networkId || (due.network && due.network !== networkId)) {
        this.wrongNetwork(due.network, pinned);
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
        timed,
        mainStage,
        held
      };
      const rows = await this.loadRows(due.decisions, run);
      for (const settlement of mainStageFirst(due.decisions, mainStage)) {
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

  /** Logs a gateway on another network than the sender signs for, once. */
  private wrongNetwork(
    network: string | null,
    pinned: string | null
  ): 'wrong_network' {
    this.noteOnce('network', `${network}`, () =>
      logger.warn(
        `[SETTLEMENT SENDER OFF] the gateway reads network ${network}; the sender signs for ${pinned ?? 'the gateway network'}`
      )
    );
    return 'wrong_network';
  }

  /**
   * A setting of decision ids, its ids in force and any id left out logged
   * once (and again when the setting changes).
   */
  private idSetting(
    name: string,
    env: Readonly<Record<string, string | undefined>>,
    what: string
  ): ReadonlySet<string> {
    const { ids, dropped } = decisionIdsSettingOf(env[name]);
    const list = Array.from(ids).sort();
    this.noteOnce(
      `setting ${name}`,
      `${list.join(',')}|${dropped.join(',')}`,
      () => {
        logger.info(
          `[SETTLEMENT SENDER] [${name}] ${list.length ? `${what}: ${list.join(', ')}` : 'none'}`
        );
        for (const id of dropped) {
          logger.warn(
            `[SETTLEMENT SENDER] [${name}] "${id}" is not 0x and 64 hex digits: left out`
          );
        }
      }
    );
    return ids;
  }

  /**
   * The chain's waves import, read at the head: whether it is complete, and
   * the network the read names.
   */
  private async importState(): Promise<{
    completed: boolean;
    network: string | null;
  }> {
    const answer = await this.deps.gateway.read<{ completed?: unknown }>(
      '/v1/waves/import',
      {},
      { at: 'head' }
    );
    const network = lower(answer?.read?.network);
    return {
      completed: answer?.data?.completed === true,
      network: HEX32.test(network) ? network : null
    };
  }

  /** The gateway as logs name it. */
  private gatewayName(): string {
    if (this.deps.gatewayName) return this.deps.gatewayName();
    try {
      return new URL(process.env.CHAIN_GATEWAY_URL ?? '').host || 'the gateway';
    } catch {
      return 'the gateway';
    }
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
    run: RunContext
  ): Promise<Map<string, SettlementSend>> {
    const { timed, mainStage } = run;
    const loaded = await this.deps.store.load(
      due.map((it) => lower(it.decisionId)),
      [...MAY_RUN, ...LANDED],
      this.deps.now() - SETTLEMENT_RESEND_AFTER_MS
    );
    const rows = new Map(loaded.map((row) => [row.decision_id, row]));
    for (const row of loaded) {
      const open = MAY_RUN.includes(row.status) || LANDED.includes(row.status);
      if (!row.tx_id || !open) continue;
      // A request that may still have run when it expired is asked about
      // once more: no block holding it by now, it was never included.
      const lapsed = this.expired(row) && MAY_RUN.includes(row.status);
      if (this.expired(row) && !lapsed) continue;
      const txId = row.tx_id;
      let status: SettlementSendStatus;
      let lastError = row.last_error;
      let failures = row.failures;
      let attempts = row.attempts;
      try {
        const tx = await timed(() => this.deps.gateway.getTx(txId));
        status = tx && TX_STATUSES.includes(tx.status) ? tx.status : 'unknown';
        if (
          tx?.status === 'failed' &&
          isWavesImportRunning(tx.result?.code, tx.result?.name)
        ) {
          // Not yet: no failure, and tried again at once.
          status = 'not_yet';
          attempts = Math.max(0, attempts - 1);
          lastError = `not yet in block ${tx.height}: the waves import is running`;
          logger.info(
            `[SETTLEMENT NOT YET] [decision ${row.decision_id}] [tx ${txId}] ${lastError}`
          );
        } else if (tx?.status === 'failed') {
          // It paid its fee: this counts toward giving the step up.
          failures++;
          lastError = `failed in block ${tx.height}: ${tx.result?.code} ${tx.result?.name}`;
          logger.warn(
            `[SETTLEMENT FAILED] [decision ${row.decision_id}] [tx ${txId}] ${lastError}`
          );
          if (
            mainStage.has(row.decision_id) &&
            failures >= SETTLEMENT_MAX_FAILURES
          ) {
            // The Main Stage is never given up: someone has to look.
            logger.error(
              `[MAIN STAGE SETTLEMENT FAILING] [decision ${row.decision_id}] [occurrence ${row.occurrence}] [next ${row.count_next}] ${failures} requests failed in their blocks, the last: ${lastError}. ${costAndStop(run.settings.maxFee)}`
            );
          }
        }
      } catch (error) {
        if (error instanceof BudgetSpent) throw error;
        if (isNotHeld(error) && MAY_RUN.includes(row.status)) {
          const age = this.deps.now() - row.sent_at;
          if (age >= SETTLEMENT_PAST_EXPIRY_MS) {
            // Nodes drop a request from their pool at its expiry, then hold
            // it nowhere: past the latest expiry, it was never included.
            await this.notIncluded(row, rows, run);
            continue;
          }
          // Dropped at its expiry, as nodes do: it is called never included
          // once past the latest expiry its draft can carry.
          if (age >= SETTLEMENT_VALID_FOR_MS) continue;
        }
        logger.warn(`[SETTLEMENT TX UNREAD] [tx ${txId}] ${describe(error)}`);
        continue;
      }
      if (lapsed && MAY_RUN.includes(status)) {
        await this.notIncluded(row, rows, run);
        continue;
      }
      if (status !== row.status) {
        await this.save(
          {
            ...row,
            status,
            failures,
            attempts,
            // A request in a block ends the run of never-included ones.
            last_error: LANDED.includes(status) ? null : lastError
          },
          rows
        );
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
    if (run.held.has(step.decisionId)) {
      this.noteOnce(
        `held ${step.decisionId}`,
        `${step.occurrence}:${step.next}`,
        () =>
          logger.warn(
            `[SETTLEMENT HELD] [decision ${step.decisionId}] [occurrence ${step.occurrence}] [next ${step.next}] ${HOLD_DECISION_IDS_ENV} names it: nothing is sent for it until it is taken out`
          )
      );
      return 'waiting';
    }
    this.noted.delete(`held ${step.decisionId}`);
    const row = rows.get(step.decisionId);
    const plan = this.plan(row, step, run.mainStage.has(step.decisionId));
    if (plan.action === 'wait') return 'waiting';
    if (plan.action === 'give_up') return await this.giveUp(row!, rows);
    const lane = nonceLaneOf(step.decisionId);
    if (this.laneTaken(step.decisionId, lane, rows)) return 'waiting';
    const where = `[decision ${step.decisionId}] [occurrence ${step.occurrence}] [next ${step.next}] [lane ${lane}]`;
    if (row?.status === 'given_up' && sameStep(row, step)) {
      logger.warn(`[SETTLEMENT TRYING AGAIN] ${where} after giving it up`);
    }
    // The run of never-included requests before this one, kept on the row
    // whatever this try meets, until a request reaches a block.
    const inRow =
      row && sameStep(row, step) ? notIncludedInRow(row.last_error) : 0;
    const noted = (error: string | null) => withNotIncluded(error, inRow);
    // Every try counts toward the wait before the next, whatever its end.
    const attempts = plan.attempts + 1;
    const base = {
      decision_id: step.decisionId,
      occurrence: step.occurrence,
      count_next: step.next,
      nonce_lane: lane,
      attempts,
      failures: plan.failures,
      sent_at: this.deps.now()
    };
    let draft: ChainDraft;
    let checked: ReturnType<typeof checkSettlementDraft>;
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
          validForMs: SETTLEMENT_VALID_FOR_MS,
          maxFee: run.settings.maxFee.toString()
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
      // The chain refuses a maxFee below the worst case (0x0305), so a
      // request is not sent while base fees put the worst case over the cap.
      const worst = worstFeeOf(draft);
      if (worst !== null && worst > checked.maxFee) {
        throw new Error(
          `the worst-case fee ${worst} is over the maxFee ${checked.maxFee}`
        );
      }
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      const lastError = `draft: ${describe(error)}`;
      if (importRunning(error)) {
        return this.notYet(base, plan, null, noted(lastError), where, rows);
      }
      logger.warn(`[SETTLEMENT NOT SENT] ${where} ${lastError}`);
      await this.save(
        {
          ...base,
          tx_id: null,
          status: 'error',
          last_error: noted(lastError)
        },
        rows
      );
      return 'errors';
    }
    const sig = run.signer.sign(checked.txId);
    // Saved before the submit: when its answer is lost, the next run asks
    // the gateway about this txId instead of sending again.
    const sending: SettlementSend = {
      ...base,
      tx_id: checked.txId,
      status: 'submitting',
      // The run of never-included requests stays until this one's fate is
      // known: the next never included counts from it.
      last_error: noted(null)
    };
    await this.save(sending, rows);
    const sent = `${where} [attempt ${attempts}] [tx ${checked.txId}]`;
    try {
      const result = await run.timed(() =>
        this.deps.gateway.submit({
          unsigned: draft.unsigned,
          signatures: [{ role: checked.role, keyType: checked.keyType, sig }],
          // Not sent: the client holds the answer to this transaction.
          txId: checked.txId
        })
      );
      if (!result.accepted) {
        logger.warn(`[SETTLEMENT REFUSED] ${sent} not accepted`);
        await this.save(
          { ...sending, status: 'refused', last_error: noted('not accepted') },
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
      if (isRefusal(error) && importRunning(error)) {
        return this.notYet(
          base,
          plan,
          checked.txId,
          noted(lastError),
          sent,
          rows
        );
      }
      if (isRefusal(error)) {
        logger.warn(`[SETTLEMENT REFUSED] ${sent} ${lastError}`);
        await this.save(
          { ...sending, status: 'refused', last_error: noted(lastError) },
          rows
        );
        return 'refused';
      }
      // The gateway may have relayed it: it stays `submitting`, and the
      // next run asks the gateway about it.
      logger.warn(`[SETTLEMENT SUBMIT UNCLEAR] ${sent} ${lastError}`);
      await this.save({ ...sending, last_error: noted(lastError) }, rows);
      return 'errors';
    }
  }

  /**
   * The chain refused the request while its waves import runs: no failure,
   * and the try is not counted. Saved as `not_yet`, which the next run
   * tries again whatever the step's earlier tries.
   */
  private async notYet(
    base: Omit<SettlementSend, 'tx_id' | 'status' | 'last_error'>,
    plan: Extract<Plan, { action: 'send' }>,
    txId: string | null,
    lastError: string,
    where: string,
    rows: Map<string, SettlementSend>
  ): Promise<Outcome> {
    logger.info(`[SETTLEMENT NOT YET] ${where} ${lastError}`);
    await this.save(
      {
        ...base,
        attempts: plan.attempts,
        tx_id: txId,
        status: 'not_yet',
        last_error: `not yet: ${lastError}`
      },
      rows
    );
    return 'waiting';
  }

  private plan(
    row: SettlementSend | undefined,
    step: Step,
    mainStage = false
  ): Plan {
    if (!row) return FRESH;
    const now = this.deps.now();
    const live = row.tx_id !== null && !this.expired(row);
    // One request per decision may run at a time, whatever its step.
    if (live && MAY_RUN.includes(row.status)) return { action: 'wait' };
    // A new step (or occurrence) starts its tries again.
    if (!sameStep(row, step)) return FRESH;
    // The same step: the request landed and the read has not caught up...
    if (live && LANDED.includes(row.status)) return { action: 'wait' };
    // ...or the sender gave it up a while ago...
    if (row.status === 'given_up') {
      return !mainStage && now < row.sent_at + SETTLEMENT_GIVE_UP_PAUSE_MS
        ? { action: 'give_up' }
        : FRESH;
    }
    // The Main Stage is never given up: it is tried again, every 15
    // minutes at most, and each failure from the eighth on is an error.
    if (!mainStage && row.failures >= SETTLEMENT_MAX_FAILURES) {
      return { action: 'give_up' };
    }
    // ...or the chain said "not yet": tried again now, with no wait...
    if (row.status === 'not_yet') {
      return { action: 'send', attempts: row.attempts, failures: row.failures };
    }
    // ...or it is tried again, later each time.
    return now >= row.sent_at + backoffMs(row.attempts)
      ? { action: 'send', attempts: row.attempts, failures: row.failures }
      : { action: 'wait' };
  }

  private async giveUp(
    row: SettlementSend,
    rows: Map<string, SettlementSend>
  ): Promise<Outcome> {
    if (row.status !== 'given_up') {
      logger.error(
        `[SETTLEMENT GIVEN UP] [decision ${row.decision_id}] [occurrence ${row.occurrence}] [next ${row.count_next}] after ${row.failures} requests failed in their blocks, the last: ${row.last_error ?? ''}. The sender tries it again in ${SETTLEMENT_GIVE_UP_PAUSE_MS / 3_600_000} hours, at the next step, or once this row of waves_settlement_sends is deleted`
      );
      await this.save({ ...row, status: 'given_up' }, rows);
    }
    return 'givenUp';
  }

  /**
   * A request that may have run and that no block held by the time it
   * expired: the gateway took it, or may have, and it was never included.
   * It paid no fee, so it isn't a failure; it is saved as `not_included`
   * with how many of this step's requests in a row were, and logged. From
   * the second in a row, a Main Stage one is an error: someone has to look
   * at the gateway's nodes and their peers.
   */
  private async notIncluded(
    row: SettlementSend,
    rows: Map<string, SettlementSend>,
    run: RunContext
  ) {
    const inRow = notIncludedInRow(row.last_error) + 1;
    const taken = row.status === 'submitted' || row.status === 'pending';
    const what = taken ? 'accepted, never included' : 'sent, never included';
    const lastError = `${what} (${inRow} in a row): tx ${row.tx_id}, last seen ${row.status}, expired`;
    const where = `[decision ${row.decision_id}] [occurrence ${row.occurrence}] [next ${row.count_next}] [tx ${row.tx_id}] [gateway ${this.gatewayName()}]`;
    if (run.mainStage.has(row.decision_id) && inRow >= 2) {
      logger.error(
        `[MAIN STAGE SETTLEMENT NOT INCLUDED] ${where} ${what}: ${inRow} requests in a row expired without reaching a block. Check that the gateway's nodes reach the chain's peers. The sender keeps sending; nothing was paid. ${costAndStop(run.settings.maxFee)}`
      );
    } else {
      logger.warn(`[SETTLEMENT NOT INCLUDED] ${where} ${lastError}`);
    }
    await this.save(
      { ...row, status: 'not_included', last_error: lastError },
      rows
    );
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

/** The chain's WAVES_IMPORT_RUNNING, as a gateway error carries it. */
function importRunning(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    isWavesImportRunning(error.code, error.message)
  );
}

/** A refusal: the gateway or the chain read the request and said no. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    // The client's word that the node may have taken it, whatever the
    // status: the row stays submitting and is asked about with getTx.
    error.code !== 'outcome_unknown' &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

/** How many requests in a row were never included, as a note says. */
function notIncludedInRow(note: string | null): number {
  const found = /never included \((\d+) in a row\)/.exec(note ?? '');
  return found ? Number(found[1]) : 0;
}

/** A row's error, with the run of never-included requests before it. */
function withNotIncluded(error: string | null, inRow: number): string | null {
  if (inRow <= 0) return error;
  const note = `before it, never included (${inRow} in a row)`;
  return error ? `${error}; ${note}` : note;
}

/** The gateway's word that no block and no pool of its node holds it. */
function isNotHeld(error: unknown): boolean {
  return error instanceof ChainGatewayError && error.code === 'not_held';
}

/** Requests a step that keeps failing sends in its first 24 hours, at most. */
export function mainStageRequestsFirstDay(): number {
  const day = 24 * 60 * 60_000;
  let sent = 0;
  for (let at = 0; at < day; at += backoffMs(sent)) sent++;
  return sent;
}

/** Base units of 18 decimals as coins, to four places. */
function coinsOf(base: bigint): string {
  const unit = BigInt('1000000000000000000');
  const whole = base / unit;
  // Four decimal places, without the zeros at the end.
  const places = Number(((base % unit) * BigInt(10_000)) / unit);
  const part = String(10_000 + places)
    .slice(1)
    .replace(/0+$/, '');
  return part ? `${whole}.${part}` : `${whole}`;
}

/** What a Main Stage step's tries cost a day at most, and how to stop them. */
function costAndStop(maxFee: bigint): string {
  const firstDay = mainStageRequestsFirstDay();
  const perDay = BigInt(firstDay) * maxFee;
  return `It is tried again ${SETTLEMENT_MAX_BACKOFF_MS / 60_000} minutes after each try: at most ${firstDay} requests in its first 24 hours and ${MAIN_STAGE_REQUESTS_A_DAY} a day after, each paying at most WAVES_SETTLEMENT_MAX_FEE (${coinsOf(maxFee)} coins), so at most ${coinsOf(perDay)} coins a day. To stop this decision alone, add it to ${HOLD_DECISION_IDS_ENV} (claim builds go on); FEATURE_WAVES_SETTLEMENT_SENDER=false stops every settlement`;
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

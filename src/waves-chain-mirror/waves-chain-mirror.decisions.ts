import { concat, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { CompetitionDraftSchema } from '@/api/competitions/competition-configuration';
import {
  DOC_CLASS,
  docCommitment,
  maxDocumentBytes,
  nonceWordOf
} from './waves-chain-mirror.docs';
import { chainIdOf } from './waves-chain-mirror.ids';

/**
 * Decisions made on the chain, as 6529.io's competitions: the chain's
 * DecisionConfig for the rules, and the decision's document (docClass 10)
 * and outcome template (docClass 7) for what the chain doesn't keep.
 *
 * The document is what the site writes when it creates a decision on the
 * chain: 6529.io's own draft input (title, description, participation,
 * voting, rules, outcome_config, presentation) and the CID of its outcome
 * template. The chain's config wins on every rule it holds: kind, credit,
 * vote range, per-entry cap, periods, result schedule, time lock, winners,
 * threshold, hold and entries per author. The groups are the chain's.
 * Outcomes come from the template, checked against the config's
 * commitment (outcomeTemplateHash). The result is checked by 6529.io's own
 * draft schema, as its create checks a request.
 */

const ZERO_WORD = `0x${'00'.repeat(32)}`;
/** The chain's "no limit" on entries an author makes, as the site writes it. */
const MAX_ENTRIES_PER_AUTHOR = 64;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO = BigInt(0);
const UINT32_MAX = BigInt(0xffffffff);

/** A DecisionConfig's fields the mirror reads (64-bit values as bigints). */
export interface ChainDecisionConfig {
  readonly kind: number;
  readonly creditSource: number;
  readonly creditParam: string;
  readonly creditor: string | null;
  readonly creditScope: number;
  readonly minVote: bigint;
  readonly perEntryCap: bigint;
  readonly participationStart: bigint;
  readonly participationEnd: bigint;
  readonly votingStart: bigint;
  readonly votingEnd: bigint;
  readonly firstResult: bigint;
  readonly gaps: readonly bigint[];
  readonly rolling: boolean;
  readonly timeLock: bigint;
  readonly maxEntriesPerAuthor: number;
  readonly outcomeTemplateHash: string;
  readonly threshold: bigint;
  readonly holdMs: bigint;
  readonly maxWinners: number;
}

/** A decision made on the chain, from its chain_decisions row. */
export interface ChainNativeDecision {
  readonly decisionId: string;
  readonly waveId: string;
  readonly status: string;
  readonly configVersion: number;
  readonly metadataCid: string | null;
  /** The submit and vote groups; null for none (the zero id). */
  readonly submitGroupId: string | null;
  readonly voteGroupId: string | null;
  readonly config: ChainDecisionConfig;
  /** The index's height for the row. */
  readonly height: number;
}

export interface ChainDecisionRowRead {
  readonly decision_id: string;
  readonly wave_id: string;
  readonly status: string;
  readonly height: number | string;
  readonly data: unknown;
}

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

function bigOf(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function smallOf(value: unknown): number | null {
  const big = bigOf(value);
  return big === null || big < ZERO || big > UINT32_MAX ? null : Number(big);
}

function wordOf(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function groupIdOf(ref: unknown): string | null | undefined {
  if (ref === null || ref === undefined) return null;
  if (typeof ref !== 'object') return undefined;
  const id = wordOf((ref as Record<string, unknown>).groupId);
  if (id === null) return undefined;
  return id === ZERO_WORD ? null : id;
}

/** A DecisionConfig as the gateway gives it; null when a field is unread. */
export function chainDecisionConfigOf(
  value: unknown
): ChainDecisionConfig | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const big = (field: string) => bigOf(c[field]);
  const small = (field: string) => smallOf(c[field]);
  const creditor =
    c.creditor === null || c.creditor === undefined
      ? ZERO_WORD
      : wordOf(c.creditor);
  const gaps = Array.isArray(c.gaps) ? c.gaps.map(bigOf) : null;
  const config = {
    kind: small('kind'),
    creditSource: small('creditSource'),
    creditParam: wordOf(c.creditParam ?? ZERO_WORD),
    creditor,
    creditScope: small('creditScope'),
    minVote: big('minVote'),
    perEntryCap: big('perEntryCap'),
    participationStart: big('participationStart'),
    participationEnd: big('participationEnd'),
    votingStart: big('votingStart'),
    votingEnd: big('votingEnd'),
    firstResult: big('firstResult'),
    timeLock: big('timeLock'),
    maxEntriesPerAuthor: small('maxEntriesPerAuthor'),
    outcomeTemplateHash: wordOf(c.outcomeTemplateHash ?? ZERO_WORD),
    threshold: big('threshold') ?? ZERO,
    holdMs: big('holdMs') ?? ZERO,
    maxWinners: small('maxWinners') ?? 0
  };
  if (
    Object.values(config).some((v) => v === null) ||
    gaps === null ||
    gaps.some((g) => g === null) ||
    typeof c.rolling !== 'boolean'
  ) {
    return null;
  }
  return {
    ...(config as Omit<ChainDecisionConfig, 'gaps' | 'rolling' | 'creditor'>),
    creditor: creditor === ZERO_WORD ? null : creditor,
    gaps: gaps as bigint[],
    rolling: c.rolling
  } as ChainDecisionConfig;
}

/** A chain_decisions row of a decision made on the chain. */
export function chainNativeDecisionOf(
  row: ChainDecisionRowRead
): Read<ChainNativeDecision> {
  const data = (
    typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  ) as Record<string, unknown>;
  const decisionId = chainIdOf(row.decision_id);
  const waveId = chainIdOf(row.wave_id);
  const configVersion = smallOf(data?.configVersion);
  const submitGroupId = groupIdOf(data?.submitGroup);
  const voteGroupId = groupIdOf(data?.voteGroup);
  const config = chainDecisionConfigOf(data?.config);
  const cid = data?.metadataCid;
  if (
    !decisionId ||
    !waveId ||
    !configVersion ||
    submitGroupId === undefined ||
    voteGroupId === undefined ||
    !config
  ) {
    return { ok: false, reason: 'decision_row_unread' };
  }
  return {
    ok: true,
    value: {
      decisionId,
      waveId,
      status: row.status,
      configVersion,
      metadataCid:
        typeof cid === 'string' && /^0x[0-9a-fA-F]+$/.test(cid) && cid !== '0x'
          ? cid.toLowerCase()
          : null,
      submitGroupId,
      voteGroupId,
      config,
      height: Number(row.height)
    }
  };
}

/**
 * P40 5.3's REP category id: `H("6529.RepCategory.v1",
 * keccak256(lowercase name))`, H being keccak256 of the tag's keccak256
 * and the fields, each a 32-byte word.
 */
export function repCategoryId(name: string): string {
  return keccak256(
    concat([
      keccak256(toUtf8Bytes('6529.RepCategory.v1')),
      keccak256(toUtf8Bytes(name.toLowerCase()))
    ])
  );
}

/** A decision document's fields the mirror reads. */
export interface DecisionDocument {
  readonly title: unknown;
  readonly description: unknown;
  readonly participation: Record<string, unknown>;
  readonly voting: Record<string, unknown>;
  readonly rules: Record<string, unknown>;
  readonly presentation: unknown;
  readonly outcomeTemplateCid: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export function parseDecisionDocument(
  bytes: Uint8Array
): Read<DecisionDocument> {
  if (bytes.length > maxDocumentBytes(DOC_CLASS.DECISION)) {
    return { ok: false, reason: 'decision_document_too_large' };
  }
  const doc = record(jsonOf(bytes));
  if (!doc || doc.v !== 1 || doc.kind !== 'decision') {
    return { ok: false, reason: 'decision_document_unread' };
  }
  const participation = record(doc.participation);
  const voting = record(doc.voting);
  const rules = record(doc.rules);
  if (!participation || !voting || !rules) {
    return { ok: false, reason: 'decision_document_unread' };
  }
  const template = doc.outcome_template_cid;
  return {
    ok: true,
    value: {
      title: doc.title,
      description: doc.description ?? null,
      participation,
      voting,
      rules,
      presentation: doc.presentation ?? [],
      outcomeTemplateCid:
        typeof template === 'string' && /^0x[0-9a-fA-F]+$/.test(template)
          ? template.toLowerCase()
          : null
    }
  };
}

/**
 * The outcomes of a template (docClass 7) whose commitment is the config's
 * outcomeTemplateHash.
 */
export function templateOutcomes(
  bytes: Uint8Array,
  outcomeTemplateHash: string
): Read<unknown[]> {
  const doc = record(jsonOf(bytes));
  const nonce = nonceWordOf(doc?.nonce);
  if (!doc || !nonce || !Array.isArray(doc.outcomes)) {
    return { ok: false, reason: 'decision_outcomes_unread' };
  }
  if (
    docCommitment(DOC_CLASS.OUTCOME_TEMPLATE, nonce, getBytes(bytes)) !==
    outcomeTemplateHash.toLowerCase()
  ) {
    return { ok: false, reason: 'decision_outcomes_commitment' };
  }
  return { ok: true, value: doc.outcomes };
}

/** Whether a decision names an outcome template at all. */
export function hasOutcomeTemplate(config: ChainDecisionConfig): boolean {
  return config.outcomeTemplateHash !== ZERO_WORD;
}

const CREDIT_TYPE: Readonly<Record<number, string>> = {
  1: 'TDH',
  3: 'TDH_PLUS_XTDH',
  4: 'REP'
};

function msOrNull(value: bigint): number | null {
  return value > ZERO && value <= MAX_SAFE ? Number(value) : null;
}

const FORBIDDEN_RULES = [
  'admin_group',
  'admin_drop_deletion_enabled',
  'period',
  'winning_thresholds'
];

/**
 * 6529.io's draft input for a decision made on the chain: the document's
 * fields, the chain's rules over them, and the mapped groups, creditor and
 * outcomes. `differences` names the document's rule fields the chain
 * changed. Checked by 6529.io's draft schema.
 */
export function decisionDraftOf(input: {
  readonly doc: DecisionDocument;
  readonly config: ChainDecisionConfig;
  readonly submitGroupId: string | null;
  readonly voteGroupId: string | null;
  /** The REP creditor's profile; null for none. */
  readonly creditorId: string | null;
  readonly outcomes: unknown[];
}): Read<{ draft: ApiCompetitionDraftInput; differences: string[] }> {
  const { doc, config } = input;
  const type = config.kind === 1 ? 'RANK' : config.kind === 2 ? 'APPROVE' : '';
  if (!type) return { ok: false, reason: 'decision_kind_unsupported' };
  const creditType = CREDIT_TYPE[config.creditSource];
  if (!creditType) return { ok: false, reason: 'decision_credit_unsupported' };
  let category: string | null = null;
  if (creditType === 'REP') {
    const named = doc.voting.credit_category;
    if (
      typeof named !== 'string' ||
      repCategoryId(named.trim()) !== config.creditParam
    ) {
      return { ok: false, reason: 'decision_rep_category_unnamed' };
    }
    category = named.trim();
  }
  const approve = type === 'APPROVE';
  const docEntries =
    doc.participation.no_of_applications_allowed_per_participant;
  const entries =
    config.maxEntriesPerAuthor <= 0 ||
    (config.maxEntriesPerAuthor >= MAX_ENTRIES_PER_AUTHOR &&
      (docEntries === null || docEntries === undefined))
      ? null
      : config.maxEntriesPerAuthor;
  const firstResult = msOrNull(config.firstResult);
  const rules = Object.fromEntries(
    Object.entries(doc.rules).filter(([key]) => !FORBIDDEN_RULES.includes(key))
  );
  const chainRules = {
    type,
    winning_threshold: approve ? Number(config.threshold) : null,
    winning_threshold_min_duration_ms: approve ? Number(config.holdMs) : null,
    max_winners: approve && config.maxWinners > 0 ? config.maxWinners : null,
    max_votes_per_identity_to_drop: msOrNull(config.perEntryCap),
    time_lock_ms: msOrNull(config.timeLock),
    decisions_strategy:
      !approve && firstResult !== null
        ? {
            first_decision_time: firstResult,
            subsequent_decisions: config.gaps.map((gap) => Number(gap)),
            is_rolling: config.rolling
          }
        : null
  };
  const chainParticipation = {
    scope: { group_id: input.submitGroupId },
    no_of_applications_allowed_per_participant: entries,
    period: {
      min: msOrNull(config.participationStart),
      max: msOrNull(config.participationEnd)
    }
  };
  const chainVoting = {
    scope: { group_id: input.voteGroupId },
    credit_type: creditType,
    credit_scope: config.creditScope === 2 ? 'DROP' : 'WAVE',
    credit_category: category,
    creditor_id: creditType === 'REP' ? input.creditorId : null,
    forbid_negative_votes: config.minVote >= ZERO,
    period: {
      min: msOrNull(config.votingStart),
      max: msOrNull(config.votingEnd)
    }
  };
  const differences = [
    ...changed('rules', doc.rules, chainRules),
    ...changed('participation', doc.participation, chainParticipation, [
      'scope'
    ]),
    ...changed('voting', doc.voting, chainVoting, ['scope', 'creditor_id'])
  ];
  const draft = {
    title: doc.title,
    description: doc.description,
    participation: { ...doc.participation, ...chainParticipation },
    voting: { ...doc.voting, credit_nfts: null, ...chainVoting },
    rules: { ...rules, ...chainRules },
    outcomes: input.outcomes,
    presentation: doc.presentation
  };
  const checked = CompetitionDraftSchema.validate(draft);
  if (checked.error) {
    return {
      ok: false,
      reason: 'decision_draft_invalid',
      detail: checked.error.message
    };
  }
  return {
    ok: true,
    value: { draft: checked.value as ApiCompetitionDraftInput, differences }
  };
}

/** The fields of `doc` that `chain` sets to something else. */
function changed(
  part: string,
  doc: Record<string, unknown>,
  chain: Record<string, unknown>,
  skip: readonly string[] = []
): string[] {
  return Object.entries(chain)
    .filter(([key]) => !skip.includes(key))
    .filter(
      ([key, value]) =>
        JSON.stringify(doc[key] ?? null) !== JSON.stringify(value ?? null)
    )
    .map(([key]) => `${part}.${key}`);
}

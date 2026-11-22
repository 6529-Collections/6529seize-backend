import { MEMES_MINT_PRICE, SUBSCRIPTIONS_ADDRESS } from '@/constants';
import { Logger } from '@/logging';
import { RecordKind } from '@/signed-records/record-kinds';
import type { RecordVerifyResult } from '@/signed-records/record-verify';
import { roundSubscriptionBalance } from '../engine/parity-money';
import { canonicalJson } from '../opening/opening-file';
import type { OpeningFile } from '../opening/opening-file';
import {
  journalKeyMismatch,
  type JournalBody,
  type JournalChange,
  type JournalKind,
  type JournalTable
} from './journal';

/*
 * The journal verifier. A rebuild proves that it repeats what live wrote;
 * this checks that what live wrote follows the money rules:
 *
 * - each entry, from its own rows: a change's before and after are the
 *   row its key names; a top-up moves the balance by its amount, a
 *   redemption by the mint price per charge, a fold sums; no other kind
 *   changes a balance;
 * - across the journal of one opening: each balance's before is what the
 *   opening file or the previous entry left; a top-up hash is credited
 *   once; no mint is charged more tokens than it delivered; a signed event
 *   makes one choice; `n` only increases and every write has all its parts;
 * - against Ethereum and the signed events, through the two ports below,
 *   when they are given. Without them it makes no call at all.
 */

const logger = Logger.get('SUBSCRIPTIONS_JOURNAL_VERIFY');

/** What the verifier reads from Ethereum. */
export interface EthereumFacts {
  /** The ETH transfer of a top-up, or null if no such transaction. */
  topUp(hash: string): Promise<{
    from: string;
    to: string;
    valueEth: number;
    block: number;
  } | null>;
  /** Tokens of `contract` / `tokenId` minted (from the null address) to `to` in `hash`, or 0. */
  mintedTo(
    hash: string,
    contract: string,
    tokenId: number,
    to: string
  ): Promise<number>;
}

/** The verified signed records of lane `subs`, by event id. */
export interface SignedEventLookup {
  find(eventId: string): Promise<{
    type: string;
    key: string;
    body: Record<string, unknown> | null;
    owner: string;
  } | null>;
}

/**
 * An identity's balance before an entry, as the journal and the opening
 * file left it: a number, null for no row, undefined when not known.
 */
export type BalanceBefore = (identity: string) => number | null | undefined;

type Row = Record<string, unknown>;

/** The tables each kind may change. */
const MAY_CHANGE: Readonly<Record<JournalKind, readonly JournalTable[]>> = {
  'top-up': ['balances', 'mode', 'choices', 'logs', 'top_up'],
  fold: ['balances', 'mode', 'choices'],
  build: ['choices', 'mode', 'logs', 'final'],
  phase: ['final'],
  redemption: ['balances', 'redeemed', 'final', 'cursor'],
  choice: ['mode', 'choices', 'logs'],
  upload: ['upload'],
  opening: [],
  checkpoint: []
};

function labelOf(body: Pick<JournalBody, 'n' | 'kind'>): string {
  return `n=${body.n} ${body.kind}`;
}

function balanceOf(row: Row | null | undefined): number | null {
  return row ? Number(row.balance) : null;
}

function lower(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

/** The identity a change is about: its key's, else its rows'. */
function identityOf(change: JournalChange): string {
  return String(
    change.key.identity_key ??
      change.after?.identity_key ??
      change.before?.identity_key
  );
}

/** A change's key must be its table's natural key, and its rows the row that key names. */
function keyFailure(label: string, change: JournalChange): string | null {
  const mismatch = journalKeyMismatch(change);
  return mismatch
    ? `${label}: the ${change.table} change ${canonicalJson(change.key)}: ${mismatch}`
    : null;
}

/** One token of one airdrop, charged to one identity (a redemption's input). */
interface Charge {
  readonly transaction: string;
  readonly contract: string;
  readonly token_id: number;
  readonly to_address: string;
  readonly token_count: number;
  readonly identity_key: string;
}

/**
 * A redemption's charges: the union of its parts' `inputs.charges`, in
 * part order (the one list spread across parts rather than repeated), or
 * null if a part's list is not a list of charges.
 */
function chargesOf(parts: readonly JournalBody[]): Charge[] | null {
  const lists = parts.map((b) => b.inputs.charges);
  if (!lists.every((list) => Array.isArray(list))) {
    return null;
  }
  const charges = ([] as Array<Partial<Charge> | null>).concat(
    ...(lists as Array<Array<Partial<Charge> | null>>)
  );
  const valid = charges.every(
    (c: Partial<Charge> | null) =>
      typeof c === 'object' &&
      c !== null &&
      typeof c.transaction === 'string' &&
      typeof c.contract === 'string' &&
      typeof c.to_address === 'string' &&
      typeof c.identity_key === 'string' &&
      Number.isInteger(c.token_id) &&
      Number.isInteger(c.token_count)
  );
  return valid ? (charges as Charge[]) : null;
}

function mintKeyOf(
  transaction: string,
  contract: string,
  tokenId: number,
  to: string
): string {
  return [transaction, contract, String(tokenId), to].map(lower).join('|');
}

/** The balances changes of a write, by identity; a second change of one identity is a failure. */
function balancesByIdentity(
  label: string,
  changes: readonly JournalChange[],
  failures: string[]
): Map<string, JournalChange> {
  const byIdentity = new Map<string, JournalChange>();
  for (const change of changes.filter((c) => c.table === 'balances')) {
    const identity = identityOf(change);
    if (byIdentity.has(identity)) {
      failures.push(`${label}: the balance of ${identity} changes twice`);
    }
    byIdentity.set(identity, change);
    if (change.before === undefined) {
      failures.push(
        `${label}: the balance of ${identity} changes with no before captured`
      );
    }
  }
  return byIdentity;
}

function topUpMoney(
  label: string,
  inputs: Row,
  changes: JournalChange[],
  balanceBefore: BalanceBefore
) {
  const failures: string[] = [];
  const identity = String(inputs.identity_key);
  const amount = Number(inputs.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    failures.push(
      `${label}: a top-up of ${String(inputs.amount)} ETH; only a positive amount is credited`
    );
  }
  const balances = balancesByIdentity(label, changes, failures);
  const others = Array.from(balances.keys()).filter((k) => k !== identity);
  if (others.length > 0) {
    failures.push(
      `${label}: a top-up for ${identity} changes the balance of ${others.join(', ')}`
    );
  }
  const change = balances.get(identity);
  if (!change) {
    // Right only when the amount rounds away on the balance the journal
    // knows (dust on an existing balance).
    const current = balanceBefore(identity);
    if (
      current === undefined ||
      current === null ||
      roundSubscriptionBalance(current + amount) !== current
    ) {
      failures.push(
        `${label}: the top-up leaves the balance of ${identity} as it was`
      );
    }
  } else if (change.after === null) {
    failures.push(`${label}: the top-up deletes the balance of ${identity}`);
  } else if (change.before !== undefined) {
    const before = balanceOf(change.before);
    const expected =
      before === null ? amount : roundSubscriptionBalance(before + amount);
    const after = balanceOf(change.after);
    if (after !== expected) {
      failures.push(
        `${label}: the balance of ${identity} is ${after} after a top-up of ${amount} to ${before ?? 'no balance'}; expected ${expected}`
      );
    }
  }
  const rows = changes.filter((c) => c.table === 'top_up');
  if (rows.length !== 1) {
    failures.push(`${label}: ${rows.length} top_up rows change; expected 1`);
    return failures;
  }
  const [row] = rows;
  if (row.before !== null) {
    failures.push(
      `${label}: the top_up row ${String(inputs.hash)} is not new (before ${row.before === undefined ? 'not captured' : 'exists'})`
    );
  }
  if (row.after === null) {
    failures.push(`${label}: the top_up row is deleted`);
    return failures;
  }
  const mismatched = [
    row.after.hash === inputs.hash ? null : 'hash',
    Number(row.after.amount) === amount ? null : 'amount',
    row.after.identity_key === inputs.identity_key ? null : 'identity_key',
    lower(row.after.from_wallet) === lower(inputs.from_wallet)
      ? null
      : 'from_wallet'
  ].filter((m): m is string => m !== null);
  if (mismatched.length > 0) {
    failures.push(
      `${label}: the top_up row does not match the entry's inputs in ${mismatched.join(', ')}`
    );
  }
  return failures;
}

function redemptionMoney(
  label: string,
  parts: readonly JournalBody[],
  changes: JournalChange[]
) {
  const failures: string[] = [];
  const charges = chargesOf(parts);
  if (!charges) {
    return [`${label}: inputs.charges is not a list of charges in every part`];
  }
  const chargedTimes = new Map<string, number>();
  for (const charge of charges) {
    chargedTimes.set(
      charge.identity_key,
      (chargedTimes.get(charge.identity_key) ?? 0) + 1
    );
  }
  const balances = balancesByIdentity(label, changes, failures);
  for (const [identity, times] of Array.from(chargedTimes.entries())) {
    const change = balances.get(identity);
    if (!change) {
      failures.push(
        `${label}: ${identity} is charged ${times} times and its balance does not change`
      );
      continue;
    }
    if (change.before === undefined) {
      continue;
    }
    if (change.after === null) {
      failures.push(
        `${label}: the redemption deletes the balance of ${identity}`
      );
      continue;
    }
    let expected = balanceOf(change.before) ?? 0;
    for (let i = 0; i < times; i++) {
      expected = roundSubscriptionBalance(expected - MEMES_MINT_PRICE);
    }
    const after = balanceOf(change.after);
    if (after !== expected) {
      failures.push(
        `${label}: the balance of ${identity} is ${after} after ${times} charges from ${balanceOf(change.before) ?? 'no balance'}; expected ${expected}`
      );
    }
  }
  for (const identity of Array.from(balances.keys())) {
    if (!chargedTimes.has(identity)) {
      failures.push(
        `${label}: the balance of ${identity} changes with no charge`
      );
    }
  }
  // The redeemed rows' count increments, per transaction and identity.
  const expectedCounts = new Map<string, number>();
  for (const charge of charges) {
    const key = `${lower(charge.transaction)} ${charge.identity_key}`;
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const counted = new Map<string, number>();
  for (const change of changes.filter((c) => c.table === 'redeemed')) {
    if (change.after === null) {
      failures.push(
        `${label}: the redeemed row ${canonicalJson(change.key)} is deleted`
      );
      continue;
    }
    const key = `${lower(change.after.transaction)} ${String(change.after.identity_key)}`;
    const increment =
      Number(change.after.count) - Number(change.before?.count ?? 0);
    counted.set(key, (counted.get(key) ?? 0) + increment);
  }
  const keys = new Set([
    ...Array.from(expectedCounts.keys()),
    ...Array.from(counted.keys())
  ]);
  for (const key of Array.from(keys)) {
    const want = expectedCounts.get(key) ?? 0;
    const got = counted.get(key) ?? 0;
    if (want !== got) {
      const [transaction, identity] = key.split(' ');
      failures.push(
        `${label}: the redeemed count of ${identity} for ${transaction} moves by ${got}; it was charged ${want} times`
      );
    }
  }
  return failures;
}

function foldMoney(
  label: string,
  inputs: Row,
  changes: JournalChange[],
  rekeys: JournalBody['rekeys'],
  balanceBefore: BalanceBefore
) {
  const failures: string[] = [];
  const identity = String(inputs.identity_key);
  const wallet = String(inputs.wallet);
  if (
    rekeys.length !== 1 ||
    rekeys[0].from !== wallet ||
    rekeys[0].to !== identity
  ) {
    failures.push(
      `${label}: a fold of ${wallet} into ${identity} moves history ${canonicalJson(rekeys)}`
    );
  }
  const balances = balancesByIdentity(label, changes, failures);
  const others = Array.from(balances.keys()).filter(
    (k) => k !== identity && k !== wallet
  );
  if (others.length > 0) {
    failures.push(
      `${label}: a fold of ${wallet} into ${identity} changes the balance of ${others.join(', ')}`
    );
  }
  const ofIdentity = balances.get(identity);
  const ofWallet = balances.get(wallet);
  if ([ofIdentity, ofWallet].some((c) => c && c.before === undefined)) {
    return failures;
  }
  if (ofWallet && ofWallet.after !== null) {
    failures.push(`${label}: the fold leaves a balance on ${wallet}`);
  }
  // With no change of its own, the wallet keeps the balance it had.
  const walletBalance = ofWallet
    ? balanceOf(ofWallet.before)
    : (balanceBefore(wallet) ?? null);
  if (!ofWallet && walletBalance !== null) {
    failures.push(
      `${label}: the fold leaves the balance of ${walletBalance} on ${wallet}`
    );
    return failures;
  }
  if (!ofIdentity) {
    if (walletBalance !== null && walletBalance !== 0) {
      failures.push(
        `${label}: ${walletBalance} leaves ${wallet} and the balance of ${identity} does not change`
      );
    }
    return failures;
  }
  const identityBalance = balanceOf(ofIdentity.before);
  if (identityBalance === null && walletBalance === null) {
    failures.push(
      `${label}: the fold writes a balance for ${identity} with none to fold`
    );
    return failures;
  }
  if (ofIdentity.after === null) {
    failures.push(`${label}: the fold deletes the balance of ${identity}`);
    return failures;
  }
  const expected = (identityBalance ?? 0) + (walletBalance ?? 0);
  const after = balanceOf(ofIdentity.after);
  if (after !== expected) {
    failures.push(
      `${label}: the balance of ${identity} is ${after} after folding ${walletBalance ?? 'no balance'} into ${identityBalance ?? 'no balance'}; expected ${expected}`
    );
  }
  return failures;
}

/**
 * The rules of one write that its own entries show (all its parts, in part
 * order): each change's rows are the row its key names, and the money
 * rules of its kind. `balanceBefore` gives the balances the journal knows
 * before the write, for an identity a top-up or fold leaves unchanged.
 * Pure. Returns the failures; none means the write passes.
 */
export function verifyEntryMoney(
  bodies: readonly JournalBody[],
  balanceBefore: BalanceBefore = () => undefined
): string[] {
  if (bodies.length === 0) {
    return [];
  }
  const [head] = bodies;
  const label = labelOf(head);
  const changes = bodies.flatMap((b) => b.changes);
  const failures = changes
    .map((change) => keyFailure(label, change))
    .filter((f): f is string => f !== null);
  switch (head.kind) {
    case 'top-up':
      return [
        ...failures,
        ...topUpMoney(label, head.inputs, changes, balanceBefore)
      ];
    case 'redemption':
      return [...failures, ...redemptionMoney(label, bodies, changes)];
    case 'fold':
      return [
        ...failures,
        ...foldMoney(
          label,
          head.inputs,
          changes,
          bodies.flatMap((b) => b.rekeys),
          balanceBefore
        )
      ];
    default: {
      const touched = changes
        .filter((c) => c.table === 'balances')
        .map(identityOf);
      return touched.length === 0
        ? failures
        : [
            ...failures,
            `${label}: a ${head.kind} entry changes the balance of ${touched.join(', ')}`
          ];
    }
  }
}

/**
 * Each identity's balance as the opening file and the journal so far left
 * it. Every captured before must equal it.
 */
class BalanceChain {
  private readonly known = new Map<string, number | null>();
  /** Identities whose balance a journal entry has set. */
  private readonly journaled = new Set<string>();

  /** With the opening's balances, an identity it lacks has none. */
  constructor(
    private readonly opening?: ReadonlyArray<{
      readonly identityKey: string;
      readonly balance: number;
    }>
  ) {
    for (const row of opening ?? []) {
      this.known.set(row.identityKey, Number(row.balance));
    }
  }

  get(identity: string): number | null | undefined {
    if (this.known.has(identity)) {
      return this.known.get(identity);
    }
    return this.opening ? null : undefined;
  }

  check(label: string, changes: readonly JournalChange[], failures: string[]) {
    for (const change of changes.filter((c) => c.table === 'balances')) {
      if (change.before === undefined) {
        continue;
      }
      const identity = identityOf(change);
      const known = this.get(identity);
      const before = balanceOf(change.before);
      if (known !== undefined && known !== before) {
        failures.push(
          `${label}: the balance of ${identity} is ${before ?? 'no balance'} before this entry; the ${this.journaled.has(identity) ? 'journal' : 'opening file'} left ${known ?? 'no balance'}`
        );
      }
    }
  }

  apply(changes: readonly JournalChange[]) {
    for (const change of changes.filter((c) => c.table === 'balances')) {
      this.known.set(identityOf(change), balanceOf(change.after));
      this.journaled.add(identityOf(change));
    }
  }
}

/** The inputs every part repeats: all but a redemption's charges, which are spread across them. */
function sharedInputs(body: JournalBody): Row {
  if (body.kind !== 'redemption') {
    return body.inputs;
  }
  const { charges: _spread, ...rest } = body.inputs;
  return rest;
}

/** The parts of one write in part order, if they are complete and agree; else null. */
function partsInOrder(
  parts: readonly JournalBody[],
  failures: string[]
): JournalBody[] | null {
  const sorted = [...parts].sort((a, b) => a.part - b.part);
  const [head] = sorted;
  const label = labelOf(head);
  const complete =
    sorted.length === head.parts &&
    sorted.every((b, i) => b.part === i && b.parts === head.parts);
  if (!complete) {
    failures.push(
      `${label}: parts ${sorted.map((b) => b.part).join(', ')} of ${head.parts} are in the journal`
    );
    return null;
  }
  const shared = (b: JournalBody) =>
    canonicalJson({
      kind: b.kind,
      mode: b.mode,
      at_ms: b.at_ms,
      inputs: sharedInputs(b),
      checkpoint: b.checkpoint
    });
  if (sorted.some((b) => shared(b) !== shared(head))) {
    failures.push(`${label}: its parts differ in kind, mode, time or inputs`);
  }
  if (sorted.some((b, i) => i > 0 && b.rekeys.length > 0)) {
    failures.push(`${label}: rekeys outside part 0`);
  }
  return sorted;
}

/** Rules of a write's shape: the tables its kind may change. */
function checkShape(write: readonly JournalBody[], failures: string[]) {
  const [head] = write;
  const label = labelOf(head);
  const allowed = MAY_CHANGE[head.kind];
  if (!allowed) {
    failures.push(`${label}: unknown kind`);
    return;
  }
  const changes = write.flatMap((b) => b.changes);
  const outside = Array.from(
    new Set(changes.map((c) => c.table).filter((t) => !allowed.includes(t)))
  );
  if (outside.length > 0) {
    failures.push(
      `${label}: a ${head.kind} entry changes ${outside.join(', ')}`
    );
  }
  if ((head.kind === 'checkpoint') !== (head.checkpoint !== null)) {
    failures.push(`${label}: only a checkpoint entry carries a checkpoint`);
  }
  if (head.kind !== 'fold' && head.rekeys.length > 0) {
    failures.push(`${label}: only a fold entry carries rekeys`);
  }
}

/**
 * The identities a choice's owner may write, as the journal shows them at
 * that point: the owner itself, the identities the opening file put each
 * wallet's key under, and each fold since, followed in chains.
 */
class OwnerIdentities {
  private readonly next = new Map<string, Set<string>>();

  constructor(
    keys?: ReadonlyArray<{
      readonly consolidationKey: string;
      readonly identityKey: string;
      readonly identities: readonly string[];
    }>
  ) {
    for (const key of keys ?? []) {
      for (const wallet of key.consolidationKey.split('-').filter(Boolean)) {
        for (const identity of [key.identityKey, ...key.identities]) {
          this.link(wallet, identity);
        }
      }
    }
  }

  /** A fold moved the wallet's state to the identity. */
  link(wallet: string, identity: string): void {
    const from = lower(wallet);
    const known = this.next.get(from) ?? new Set<string>();
    known.add(lower(identity));
    this.next.set(from, known);
  }

  of(owner: string): Set<string> {
    const reached = new Set([lower(owner)]);
    const queue = [lower(owner)];
    while (queue.length > 0) {
      for (const identity of Array.from(this.next.get(queue.pop()!) ?? [])) {
        if (!reached.has(identity)) {
          reached.add(identity);
          queue.push(identity);
        }
      }
    }
    return reached;
  }
}

/**
 * A signed choice changes only rows of its owner, of any identity the
 * opening file lists for the owner's key, or of one a later fold moved it
 * to.
 */
function checkChoiceOwner(
  write: readonly JournalBody[],
  owners: OwnerIdentities,
  failures: string[]
) {
  const [head] = write;
  const owner = lower(head.inputs.owner);
  const allowed = owners.of(owner);
  const strangers = Array.from(
    new Set(
      write
        .flatMap((b) => b.changes)
        .map((change) => lower(identityOf(change)))
        .filter((id) => !allowed.has(id))
    )
  );
  if (strangers.length > 0) {
    failures.push(
      `${labelOf(head)}: a choice of ${owner} changes rows of ${strangers.join(', ')}`
    );
  }
}

/**
 * The writes of one opening, in log order: `n` must increase from write to
 * write, and a write's parts sit together.
 */
function writesInOrder(
  bodies: readonly JournalBody[],
  failures: string[]
): JournalBody[][] {
  const writes: JournalBody[][] = [];
  for (const body of bodies) {
    const current = writes[writes.length - 1];
    if (current && current[0].n === body.n) {
      current.push(body);
      continue;
    }
    if (current && body.n <= current[0].n) {
      failures.push(
        `n=${body.n} ${body.kind} comes after n=${current[0].n} in the log`
      );
    }
    writes.push([body]);
  }
  return writes;
}

export interface JournalVerifyOptions {
  /** The opening whose writes are checked (bodies of others are skipped). */
  readonly openingSha256: string;
  /**
   * The opening file: the balances the journal starts from, the identity
   * each key's state went to, and the top-ups and charges no journal entry
   * may repeat.
   */
  readonly opening?: Pick<
    OpeningFile,
    'balances' | 'keys' | 'topUps' | 'redeemed'
  >;
  readonly ethereum?: EthereumFacts;
  readonly events?: SignedEventLookup;
}

export interface JournalVerifyReport {
  readonly openingSha256: string;
  readonly writes: number;
  readonly counts: {
    readonly topUps: number;
    readonly charges: number;
    readonly mints: number;
    readonly choices: number;
  };
  /** What was checked beyond the journal itself: the opening file, Ethereum, the signed events. */
  readonly checked: {
    readonly opening: boolean;
    readonly ethereum: boolean;
    readonly events: boolean;
  };
  readonly failures: string[];
}

interface Mint {
  readonly transaction: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly to: string;
  readonly tokenCount: number;
  charged: number;
  readonly writes: number[];
}

function crossJournal(
  writes: readonly JournalBody[][],
  opening: JournalVerifyOptions['opening'],
  failures: string[]
): {
  topUps: JournalBody[];
  mints: Mint[];
  charges: number;
  choices: JournalBody[];
} {
  const inOpening = new Set((opening?.topUps ?? []).map((t) => lower(t.hash)));
  const credited = new Map<string, number>();
  const chosen = new Map<string, number>();
  const mints = new Map<string, Mint>();
  const topUps: JournalBody[] = [];
  const choices: JournalBody[] = [];
  let charges = 0;
  for (const write of writes) {
    const [head] = write;
    if (head.kind === 'top-up') {
      topUps.push(head);
      const hash = lower(head.inputs.hash);
      const earlier = credited.get(hash);
      if (earlier !== undefined) {
        failures.push(
          `${labelOf(head)}: top-up ${hash} is credited again (first at n=${earlier})`
        );
      } else {
        credited.set(hash, head.n);
      }
      if (inOpening.has(hash)) {
        failures.push(
          `${labelOf(head)}: top-up ${hash} is already in the opening file`
        );
      }
    } else if (head.kind === 'choice') {
      choices.push(head);
      const eventId = lower(head.inputs.event_id);
      const earlier = chosen.get(eventId);
      if (earlier !== undefined) {
        failures.push(
          `${labelOf(head)}: event ${eventId} makes a choice again (first at n=${earlier})`
        );
      } else {
        chosen.set(eventId, head.n);
      }
    } else if (head.kind === 'redemption') {
      for (const charge of chargesOf(write) ?? []) {
        const key = mintKeyOf(
          charge.transaction,
          charge.contract,
          charge.token_id,
          charge.to_address
        );
        const mint = mints.get(key) ?? {
          transaction: charge.transaction,
          contract: charge.contract,
          tokenId: charge.token_id,
          to: charge.to_address,
          tokenCount: charge.token_count,
          charged: 0,
          writes: []
        };
        if (charge.token_count !== mint.tokenCount) {
          failures.push(
            `${labelOf(head)}: mint ${key} is charged with token_count ${charge.token_count}, earlier ${mint.tokenCount}`
          );
        }
        mint.charged++;
        charges++;
        if (!mint.writes.includes(head.n)) {
          mint.writes.push(head.n);
        }
        mints.set(key, mint);
      }
    }
  }
  // Charges the opening already holds for a mint the journal charges too.
  for (const row of opening?.redeemed ?? []) {
    const mint = mints.get(
      mintKeyOf(row.transaction, row.contract, row.tokenId, row.address)
    );
    if (mint) {
      mint.charged += Number(row.count);
    }
  }
  for (const [key, mint] of Array.from(mints.entries())) {
    if (mint.charged > mint.tokenCount) {
      failures.push(
        `mint ${key} delivered ${mint.tokenCount} tokens and is charged ${mint.charged} times (journal n=${mint.writes.join(', ')})`
      );
    }
  }
  return { topUps, mints: Array.from(mints.values()), charges, choices };
}

async function checkEthereum(
  ethereum: EthereumFacts,
  topUps: readonly JournalBody[],
  mints: readonly Mint[],
  failures: string[]
): Promise<void> {
  for (const body of topUps) {
    const label = labelOf(body);
    const hash = String(body.inputs.hash);
    const transfer = await ethereum.topUp(hash);
    if (!transfer) {
      failures.push(`${label}: no ETH transfer ${hash} on Ethereum`);
      continue;
    }
    const mismatched = [
      lower(transfer.from) === lower(body.inputs.from_wallet) ? null : 'from',
      lower(transfer.to) === lower(SUBSCRIPTIONS_ADDRESS) ? null : 'to',
      transfer.block === Number(body.inputs.block) ? null : 'block',
      transfer.valueEth === Number(body.inputs.amount) ? null : 'value'
    ].filter((m): m is string => m !== null);
    if (mismatched.length > 0) {
      failures.push(
        `${label}: the transfer ${hash} on Ethereum differs in ${mismatched.join(', ')}`
      );
    }
  }
  for (const mint of mints) {
    const minted = await ethereum.mintedTo(
      mint.transaction,
      mint.contract,
      mint.tokenId,
      mint.to
    );
    if (minted !== mint.tokenCount) {
      failures.push(
        `mint ${mintKeyOf(mint.transaction, mint.contract, mint.tokenId, mint.to)}: Ethereum shows ${minted} tokens minted; the charges say ${mint.tokenCount}`
      );
    }
  }
}

async function checkChoices(
  events: SignedEventLookup,
  choices: readonly JournalBody[],
  failures: string[]
): Promise<void> {
  for (const body of choices) {
    const label = labelOf(body);
    const eventId = String(body.inputs.event_id);
    const event = await events.find(eventId);
    if (!event) {
      failures.push(
        `${label}: event ${eventId} is not a verified record in lane \`subs\``
      );
      continue;
    }
    const mismatched = [
      event.type === body.inputs.type ? null : 'type',
      event.key === body.inputs.key ? null : 'key',
      lower(event.owner) === lower(body.inputs.owner) ? null : 'owner'
    ].filter((m): m is string => m !== null);
    if (mismatched.length > 0) {
      failures.push(
        `${label}: event ${eventId} differs in ${mismatched.join(', ')}`
      );
    }
    if (event.body === null) {
      failures.push(
        `${label}: event ${eventId} has no body, so it is no choice`
      );
    }
  }
}

/**
 * Verifies the journal of one opening. `bodies` are every journal body in
 * log order (`subs` and `subs-shadow`; other openings are skipped).
 * Ethereum and the signed events are checked only through the ports given;
 * a port's error rejects, as nothing could be checked.
 */
export async function verifyJournal(
  bodies: readonly JournalBody[],
  options: JournalVerifyOptions
): Promise<JournalVerifyReport> {
  const failures: string[] = [];
  const writes = writesInOrder(
    bodies.filter((b) => b.opening === options.openingSha256),
    failures
  );
  const complete: JournalBody[][] = [];
  for (const write of writes) {
    const parts = partsInOrder(write, failures);
    if (parts) {
      complete.push(parts);
    }
  }
  const chain = new BalanceChain(options.opening?.balances);
  const owners = new OwnerIdentities(options.opening?.keys);
  for (const write of complete) {
    const [head] = write;
    const label = labelOf(head);
    const changes = write.flatMap((b) => b.changes);
    checkShape(write, failures);
    if (head.kind === 'choice') {
      checkChoiceOwner(write, owners, failures);
    }
    chain.check(label, changes, failures);
    failures.push(...verifyEntryMoney(write, (id) => chain.get(id)));
    chain.apply(changes);
    if (head.kind === 'fold') {
      owners.link(String(head.inputs.wallet), String(head.inputs.identity_key));
    }
  }
  const { topUps, mints, charges, choices } = crossJournal(
    complete,
    options.opening,
    failures
  );
  if (options.ethereum) {
    await checkEthereum(options.ethereum, topUps, mints, failures);
  }
  if (options.events) {
    await checkChoices(options.events, choices, failures);
  }
  return {
    openingSha256: options.openingSha256,
    writes: writes.length,
    counts: {
      topUps: topUps.length,
      charges,
      mints: mints.length,
      choices: choices.length
    },
    checked: {
      opening: !!options.opening,
      ethereum: !!options.ethereum,
      events: !!options.events
    },
    failures
  };
}

/** Logs a report's failures with the verifier's alert code; true if it passed. */
export function alertOnJournalFailures(report: JournalVerifyReport): boolean {
  if (report.failures.length === 0) {
    return true;
  }
  logger.errorWithCode(
    'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
    `[JOURNAL VERIFY FAILED] opening ${report.openingSha256}: ${report.failures.length} failures. ${report.failures.slice(0, 10).join(' | ')}`
  );
  return false;
}

/**
 * The verified records of lane `subs`, gathered from a replay of the
 * record log (replayRecordLog's result for each event entry). A record
 * that did not verify is never found.
 */
export class ReplayedSubscriptionEvents implements SignedEventLookup {
  private readonly events = new Map<
    string,
    {
      type: string;
      key: string;
      body: Record<string, unknown> | null;
      owner: string;
    }
  >();

  add(verified: RecordVerifyResult): void {
    if (!verified.ok || verified.record.parsed.kind !== RecordKind.RECORD) {
      return;
    }
    const { parsed, event, owner } = verified.record;
    this.events.set(event.id, {
      type: parsed.type,
      key: parsed.key,
      body: parsed.body,
      owner
    });
  }

  async find(eventId: string) {
    return this.events.get(eventId) ?? null;
  }
}

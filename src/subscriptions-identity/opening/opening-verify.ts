import { compareText } from '../engine/text-order';
import { openingTotals } from './opening-assemble';
import { decimalToScaled, scaledToDecimal, toScaled } from './exact-decimal';
import { canonicalJson, OpeningFile } from './opening-file';
import { ParsedOpening } from './opening-load';

/*
 * The opening file's verifier. It checks the file on its own (form, links,
 * totals, one row per identity), money conservation per identity, and, when
 * given Ethereum fixtures, every top-up and every redemption against the
 * chain. Balances that don't reconcile with top-ups and redemptions are
 * listed as adjustments (owner question O4); they don't fail the file.
 */

/** Top-ups to the subscriptions address over a block range, from Ethereum. */
export interface EthTopUpsFixture {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly transfers: ReadonlyArray<{
    readonly hash: string;
    readonly block: number;
    readonly from: string;
    /** ETH as a decimal string. */
    readonly amount: string;
  }>;
}

/** Airdrop mints (from the null address, value 0) over a date range. */
export interface EthMintsFixture {
  readonly fromDate: string;
  readonly toDate: string;
  readonly mints: ReadonlyArray<{
    readonly transaction: string;
    readonly to: string;
    readonly contract: string;
    readonly tokenId: number;
    readonly tokenCount: number;
    readonly transactionDate: string;
  }>;
}

export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly examples?: string[];
}

export interface Adjustment {
  readonly identityKey: string;
  readonly balance: string;
  readonly topUps: string;
  readonly redeemed: string;
  /** balance - (top-ups - redeemed). */
  readonly residual: string;
}

export interface VerifyReport {
  readonly verdict: 'PASS' | 'FAIL';
  readonly openingSha256: string;
  readonly historySha256: string;
  readonly checks: VerifyCheck[];
  readonly conservation: {
    readonly topUpSum: string;
    readonly redeemedValueSum: string;
    readonly balanceSum: string;
    /** balances - (top-ups - redeemed), over everything. */
    readonly residual: string;
    readonly identities: number;
    readonly exact: number;
    /** Within the five-decimal rounding of each top-up and redemption. */
    readonly rounding: number;
    readonly adjustments: Adjustment[];
    readonly adjustmentSum: string;
  };
}

function check(
  name: string,
  failures: string[],
  passDetail: string,
  failDetail: (n: number) => string
): VerifyCheck {
  return failures.length === 0
    ? { name, ok: true, detail: passDetail }
    : {
        name,
        ok: false,
        detail: failDetail(failures.length),
        examples: failures.slice(0, 10)
      };
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      dup.add(v);
    }
    seen.add(v);
  }
  return Array.from(dup).sort(compareText);
}

function structureChecks(file: OpeningFile): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  checks.push(
    check(
      'no blocked keys',
      file.blocked.map((b) => `${b.reason} ${b.consolidationKey}`),
      'every key with current state maps to one identity',
      (n) =>
        `${n} keys with current state can't move whole; re-key and cut again`
    )
  );
  checks.push(
    check(
      'keys unique',
      duplicates(file.keys.map((k) => k.consolidationKey)),
      `${file.keys.length} keys`,
      (n) => `${n} keys listed twice`
    )
  );
  checks.push(
    check(
      'one balance and one mode per identity',
      [
        ...duplicates(file.balances.map((b) => b.identityKey)),
        ...duplicates(file.modes.map((m) => m.identityKey))
      ],
      `${file.balances.length} balances, ${file.modes.length} modes`,
      (n) => `${n} identities with two balances or two modes`
    )
  );
  checks.push(
    check(
      'one choice per identity and card',
      duplicates(
        file.choices.map((c) => `${c.identityKey}|${c.contract}|${c.tokenId}`)
      ),
      `${file.choices.length} open choices`,
      (n) => `${n} identity-card pairs chosen twice`
    )
  );
  checks.push(
    check(
      'final row ids unique',
      duplicates(file.finalRows.map((f) => String(f.id))),
      `${file.finalRows.length} final rows`,
      (n) => `${n} final row ids listed twice`
    )
  );
  checks.push(
    check(
      'top-ups unique',
      duplicates(file.topUps.map((t) => t.hash.toLowerCase())),
      `${file.topUps.length} top-ups`,
      (n) => `${n} top-up hashes listed twice`
    )
  );
  const stateIdentities = new Set(file.keys.map((k) => k.identityKey));
  const orphans = [
    ...file.balances.map((b) => b.identityKey),
    ...file.modes.map((m) => m.identityKey),
    ...file.choices.map((c) => c.identityKey)
  ].filter((identity) => !stateIdentities.has(identity));
  checks.push(
    check(
      'current state has a key',
      Array.from(new Set(orphans)).sort(compareText),
      'every identity with current state is in the key map',
      (n) => `${n} identities with current state but no key`
    )
  );
  const totals = openingTotals(file);
  checks.push(
    check(
      'totals',
      canonicalJson(totals) === canonicalJson(file.totals)
        ? []
        : [
            `file ${canonicalJson(file.totals)}`,
            `recomputed ${canonicalJson(totals)}`
          ],
      'the stated totals match the rows',
      () => 'the stated totals differ from the rows'
    )
  );
  return checks;
}

const ROUNDING_PER_EVENT = toScaled(0.000005);

function conservation(file: OpeningFile): VerifyReport['conservation'] {
  const per = new Map<
    string,
    { balance: bigint; topUps: bigint; redeemed: bigint; events: number }
  >();
  const entry = (identity: string) => {
    let e = per.get(identity);
    if (!e) {
      e = {
        balance: BigInt(0),
        topUps: BigInt(0),
        redeemed: BigInt(0),
        events: 0
      };
      per.set(identity, e);
    }
    return e;
  };
  for (const b of file.balances) {
    entry(b.identityKey).balance += toScaled(b.balance);
  }
  for (const t of file.topUps) {
    const e = entry(t.identityKey);
    e.topUps += toScaled(t.amount);
    e.events++;
  }
  for (const r of file.redeemed) {
    const e = entry(r.identityKey);
    e.redeemed += toScaled(r.value);
    e.events++;
  }
  let exact = 0;
  let rounding = 0;
  const adjustments: Adjustment[] = [];
  let adjustmentSum = BigInt(0);
  for (const identity of Array.from(per.keys()).sort(compareText)) {
    const e = per.get(identity)!;
    const residual = e.balance - (e.topUps - e.redeemed);
    const abs = residual < BigInt(0) ? -residual : residual;
    if (abs === BigInt(0)) {
      exact++;
    } else if (abs <= ROUNDING_PER_EVENT * BigInt(Math.max(1, e.events))) {
      rounding++;
    } else {
      adjustments.push({
        identityKey: identity,
        balance: scaledToDecimal(e.balance),
        topUps: scaledToDecimal(e.topUps),
        redeemed: scaledToDecimal(e.redeemed),
        residual: scaledToDecimal(residual)
      });
      adjustmentSum += residual;
    }
  }
  const topUpSum = decimalToScaled(file.totals.topUpSum);
  const redeemedValueSum = decimalToScaled(file.totals.redeemedValueSum);
  const balanceSum = decimalToScaled(file.totals.balanceSum);
  return {
    topUpSum: file.totals.topUpSum,
    redeemedValueSum: file.totals.redeemedValueSum,
    balanceSum: file.totals.balanceSum,
    residual: scaledToDecimal(balanceSum - (topUpSum - redeemedValueSum)),
    identities: per.size,
    exact,
    rounding,
    adjustments,
    adjustmentSum: scaledToDecimal(adjustmentSum)
  };
}

function topUpChecks(
  file: OpeningFile,
  fixture: EthTopUpsFixture
): VerifyCheck {
  const inRange = (block: number) =>
    block >= fixture.fromBlock && block <= fixture.toBlock;
  const onChain = new Map(
    fixture.transfers
      .filter((t) => inRange(t.block))
      .map((t) => [t.hash.toLowerCase(), t])
  );
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const topUp of file.topUps.filter((t) => inRange(t.block))) {
    const hash = topUp.hash.toLowerCase();
    seen.add(hash);
    const transfer = onChain.get(hash);
    if (!transfer) {
      failures.push(`extra: ${topUp.hash} is not a top-up on Ethereum`);
    } else if (Number(transfer.amount) !== topUp.amount) {
      failures.push(
        `amount: ${topUp.hash} is ${transfer.amount} on Ethereum, ${topUp.amount} here`
      );
    } else if (transfer.from.toLowerCase() !== topUp.fromWallet.toLowerCase()) {
      failures.push(`sender: ${topUp.hash} differs from Ethereum`);
    } else if (transfer.block !== topUp.block) {
      failures.push(`block: ${topUp.hash} differs from Ethereum`);
    }
  }
  const lastBlock = file.cut.topUpBlock ?? -1;
  for (const [hash, transfer] of Array.from(onChain.entries())) {
    if (!seen.has(hash) && transfer.block <= lastBlock) {
      failures.push(`missing: ${transfer.hash} at block ${transfer.block}`);
    }
  }
  return check(
    'top-ups against Ethereum',
    failures,
    `${seen.size} top-ups in blocks ${fixture.fromBlock}-${fixture.toBlock} match Ethereum`,
    (n) => `${n} top-ups differ from Ethereum`
  );
}

function mintChecks(file: OpeningFile, fixture: EthMintsFixture): VerifyCheck {
  const from = Date.parse(fixture.fromDate);
  const to = Date.parse(fixture.toDate);
  const mintKey = (tx: string, to: string, contract: string, token: number) =>
    `${tx}|${to}|${contract}|${token}`.toLowerCase();
  const minted = new Map<string, number>();
  for (const mint of fixture.mints) {
    const key = mintKey(mint.transaction, mint.to, mint.contract, mint.tokenId);
    minted.set(key, (minted.get(key) ?? 0) + mint.tokenCount);
  }
  const charged = new Map<string, number>();
  let checked = 0;
  let unchecked = 0;
  for (const r of file.redeemed) {
    const at = r.transactionDate
      ? Date.parse(`${r.transactionDate.replace(' ', 'T')}Z`)
      : Number.NaN;
    if (Number.isNaN(at) || at < from || at > to) {
      unchecked++;
      continue;
    }
    checked++;
    const key = mintKey(r.transaction, r.address, r.contract, r.tokenId);
    charged.set(key, (charged.get(key) ?? 0) + r.count);
  }
  const failures: string[] = [];
  for (const [key, count] of Array.from(charged.entries())) {
    const tokens = minted.get(key) ?? 0;
    if (tokens === 0) {
      failures.push(`no mint: ${key}`);
    } else if (count > tokens) {
      failures.push(`charged ${count} for ${tokens} minted: ${key}`);
    }
  }
  return check(
    'redemptions against Ethereum',
    failures.sort(compareText),
    `${checked} redemption rows match airdrop mints; ${unchecked} outside the fixture's dates not checked`,
    (n) => `${n} redemptions without a matching mint`
  );
}

export function verifyOpening(
  parsed: ParsedOpening,
  fixtures: {
    readonly topUps?: EthTopUpsFixture;
    readonly mints?: EthMintsFixture;
  } = {}
): VerifyReport {
  const file = parsed.opening;
  const checks = structureChecks(file);
  if (fixtures.topUps) {
    checks.push(topUpChecks(file, fixtures.topUps));
  }
  if (fixtures.mints) {
    checks.push(mintChecks(file, fixtures.mints));
  }
  return {
    verdict: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    openingSha256: parsed.openingSha256,
    historySha256: parsed.historySha256,
    checks,
    conservation: conservation(file)
  };
}

import { RecordKind } from './record-kinds';

/**
 * Record streams are named `<family>/<owner>` in the event's signed `wave`
 * field. A drop's wave never contains `/`, so the two never collide.
 */
export type RecordFamily =
  | 'ps'
  | 'pv'
  | 'dr'
  | 'dv'
  | 'cv'
  | 'bl'
  | 'bk'
  | 'md';

export interface FamilyWave {
  readonly family: RecordFamily;
  readonly owner: string;
}

interface FamilyRule {
  // RECORD types allowed; 'any' for a public stream.
  readonly records: 'any' | readonly string[];
  readonly sealed: boolean;
  readonly log: boolean;
  readonly del: boolean;
  // What the orderer role may write (relay-inbox section 2.1): every kind
  // the family carries, SEALED only, or nothing.
  readonly orderer: boolean | 'sealed';
}

/** What each family carries (relay-inbox design, section 2.1). */
const FAMILY_RULES: Readonly<Record<RecordFamily, FamilyRule>> = {
  ps: { records: 'any', sealed: false, log: false, del: true, orderer: false },
  // The orderer seals items into a person's pv (publish's cms); a reader
  // record or a DEL there is the person's alone.
  pv: {
    records: ['reader'],
    sealed: true,
    log: false,
    del: true,
    orderer: 'sealed'
  },
  dr: {
    records: ['mls-device', 'mls-revoke'],
    sealed: false,
    log: false,
    del: false,
    orderer: true
  },
  dv: { records: [], sealed: true, log: false, del: true, orderer: true },
  cv: { records: [], sealed: false, log: true, del: false, orderer: true },
  bl: { records: [], sealed: true, log: false, del: true, orderer: true },
  bk: { records: [], sealed: true, log: false, del: true, orderer: true },
  md: { records: ['hold'], sealed: true, log: false, del: true, orderer: true }
};

const FAMILIES = Object.keys(FAMILY_RULES) as RecordFamily[];

// Families whose owner is a principal; the author must be bound to it.
const PRINCIPAL_FAMILIES: readonly RecordFamily[] = ['ps', 'pv', 'bk'];

const PRINCIPAL_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;
// Owners of the other families (dr, dv, cv, bl, md): 0x and 1 to 128
// lowercase hex digits, as the relays take them (MLS keys, group ids).
const OWNER_PATTERN = /^0x[0-9a-f]{1,128}$/;

function isRecordFamily(value: string): value is RecordFamily {
  return (FAMILIES as readonly string[]).includes(value);
}

export function isPrincipalFamily(family: RecordFamily): boolean {
  return PRINCIPAL_FAMILIES.includes(family);
}

export function isPrincipalId(value: string): boolean {
  return PRINCIPAL_ID_PATTERN.test(value);
}

export function isWalletAddress(value: string): boolean {
  return WALLET_PATTERN.test(value);
}

function isValidOwner(family: RecordFamily, owner: string): boolean {
  if (!isPrincipalFamily(family)) {
    return OWNER_PATTERN.test(owner);
  }
  // A public stream of a wallet bound to no principal (subscriptions).
  return isPrincipalId(owner) || (family === 'ps' && isWalletAddress(owner));
}

/** Parses a record stream; null for a drop's wave or a malformed stream. */
export function parseFamilyWave(wave: string): FamilyWave | null {
  const slash = wave.indexOf('/');
  if (slash < 0 || slash !== wave.lastIndexOf('/')) {
    return null;
  }
  const family = wave.slice(0, slash);
  const owner = wave.slice(slash + 1);
  if (!isRecordFamily(family)) {
    return null;
  }
  return isValidOwner(family, owner) ? { family, owner } : null;
}

export function familyWave(family: RecordFamily, owner: string): string {
  const wave = `${family}/${owner}`;
  if (!parseFamilyWave(wave)) {
    throw new Error(`Invalid ${family} owner: ${owner}`);
  }
  return wave;
}

/** Whether the family carries this kind (and, for RECORD, this type). */
export function isKindAllowedInFamily(
  family: RecordFamily,
  kind: RecordKind,
  recordType: string | null
): boolean {
  const rule = FAMILY_RULES[family];
  switch (kind) {
    case RecordKind.RECORD:
      return (
        rule.records === 'any' ||
        (recordType !== null && rule.records.includes(recordType))
      );
    case RecordKind.SEALED:
      return rule.sealed;
    case RecordKind.LOG:
      return rule.log;
    case RecordKind.DEL:
      return rule.del;
  }
}

/** Whether the orderer role may write this kind into the family. */
export function isOrdererAllowed(
  family: RecordFamily,
  kind: RecordKind
): boolean {
  const orderer = FAMILY_RULES[family].orderer;
  return (
    orderer === true || (orderer === 'sealed' && kind === RecordKind.SEALED)
  );
}

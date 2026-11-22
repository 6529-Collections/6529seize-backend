export const IDENTITY_EXPORT_HELP = `Usage: 6529 run identity:export -- --out FILE --revision HEX
         (--freeze-at TIME --expect-tdh-block N | --no-freeze)
         (--extra-ids FILE | --no-extra-ids)
         (--cms-fields FILE [--cms-manifest FILE] | --no-cms-fields)
         [--bulk N] [--no-delegations]
         [--accept-over-credit N] [--accept-edits-after-freeze N]
         [--accept-ratings-changed-after-freeze N]
         [--accept-profile-writes-after-freeze N]
         [--accept-delegations-after-freeze N]
         [--accept-missing-extra-ids N] [--accept-unmatched-cms N]
         [--accept-no-extra-ids] [--accept-bulk N] [--overwrite]

Writes 6529.io's identities, profiles, REP and CIC ratings and reserved
handles as a 6529.identity-export.v1 JSON file, the input of the Identities
v1 file the 6529 chain imports at the identity freeze. Read-only: it reads
the read pool (DB_HOST_READ, DB_USER_READ) in one read-only transaction with
a consistent snapshot. Run it against a read replica. DB_HOST, DB_USER and
DB_PASS must be set but are never connected to: they may name the replica
with read-only credentials.

Options:
  --out FILE             where to write the export (required)
  --revision HEX         the exporter's 40-hex git commit, such as
                         $(git rev-parse HEAD) (or EXPORTER_REVISION; required)
  --freeze-at TIME       the freeze time T: ISO 8601 UTC or 13-digit Unix
                         milliseconds, at 00:00 UTC. IDENTITY_FREEZE_AT must
                         be set to the same time (read as 6529.io's profile
                         site reads it, the .env file included); without
                         --freeze-at, it gives the freeze time
  --no-freeze            a rehearsal export, not at the freeze (freeze_ms
                         null); IDENTITY_FREEZE_AT is ignored, with a notice
  --extra-ids FILE       profile ids (UUIDs) in scope for waves activity: a
                         JSON list of strings, {"profile_ids": [...]}, or
                         whitespace separated; not empty. The count of
                         unique ids and the file's sha256 go into the export
  --no-extra-ids         export without the waves list (noted in the file)
  --expect-tdh-block N   required with a freeze time: write nothing unless
                         6529.io's latest TDH block is N (B_T at the freeze),
                         taken in the 10 minutes before it, its full TDH
                         write is done and the identities sync has caught up
                         with it, and every count below is 0 or acknowledged.
                         Everything is read first; every reason is reported
                         in one run
  --accept-over-credit N acknowledge exactly N raters who give more REP or CIC
                         in the file than floor(TDH) of their identity (the
                         chain's cap; counted from the file, after the reads),
                         exported as they are
  --accept-edits-after-freeze N
                         acknowledge exactly N REP or CIC edits logged after
                         the freeze (over-rate cuts and help-bot credits aside)
  --accept-ratings-changed-after-freeze N
                         acknowledge exactly N REP or CIC ratings whose
                         last_modified is after the freeze (help-bot credits
                         aside, zeros included; listed in the file)
  --accept-profile-writes-after-freeze N
                         acknowledge exactly N profile writes after the
                         freeze: those logged (handle, classification, pfp,
                         banners, statements, archiving), profile rows saved
                         to profiles_archive (every profile save and pfp
                         update writes one, logged or not) and profiles
                         created
  --accept-delegations-after-freeze N
                         acknowledge exactly N consolidations and delegations
                         rows with a block after the TDH block
  --accept-missing-extra-ids N
                         acknowledge exactly N waves-list ids with no identity
                         or profile row (left out); none matching is refused
  --accept-unmatched-cms N
                         acknowledge exactly N profile site values for
                         profiles not in the export; none matching is refused
  --accept-no-extra-ids  at the freeze, export without the waves list
  --accept-bulk N        at the freeze, a --bulk other than 2000; N is the
                         same number
                         Every --accept-* needs --expect-tdh-block
  --bulk N               a rater's REP category with more than N targets brings
                         no target in by itself (default 2000; 0 turns it off)
  --no-delegations       leave out 6529.io's delegations table (not at the
                         freeze)
  --cms-fields FILE      the profile site export's cms-fields.json (profile id
                         -> the ProfileDoc cms value): each identity of those
                         profiles gets that value as "cms"; its sha256 goes
                         into the export
  --cms-manifest FILE    the manifest.json of the profile site export run that
                         wrote the --cms-fields file. Required at the freeze:
                         a whole, usable run of the same freeze that lists the
                         file's sha256. Its sha256 goes into the export
  --no-cms-fields        export without profile site values (noted in the
                         file; not at the freeze)
  --overwrite            replace FILE if it exists (it is written to FILE.tmp
                         and renamed at the end)
  --help                 this text

At the freeze the export takes the waves list (or --accept-no-extra-ids),
the profile site values with their run's manifest, and the delegations, and
--bulk stays 2000 unless --accept-bulk names the other number.

Exit codes: 0 written; 1 failed; 2 a usage error (FILE exists, an input that
doesn't match, or IDENTITY_FREEZE_AT unset or another time at the freeze);
3 not the freeze day's TDH yet (the TDH block, its time, the day's full TDH
write or the identities sync); 4 raters over the chain's cap, not
acknowledged; 5 REP, CIC, a profile, a consolidation or a delegation changed
after the freeze, not acknowledged; 6 waves-list ids missing; 7 profile site
values unmatched. With several reasons, the lowest code; all are printed.
FILE is written only on 0. On 3, 4, 5, 6 and 7 nothing is written: wait, or
acknowledge the exact counts, and run again.
`;

/** --bulk unless given: another number at the freeze needs --accept-bulk. */
export const DEFAULT_BULK = 2000;

export interface IdentityExportCommand {
  readonly command: 'export';
  readonly out: string;
  readonly bulk: number;
  /** null with --no-extra-ids. */
  readonly extraIdsFile: string | null;
  /** null with --no-freeze. */
  readonly freezeMs: number | null;
  readonly expectTdhBlock: number | null;
  readonly revision: string;
  readonly includeDelegations: boolean;
  /** The profile site export's cms-fields.json; null with --no-cms-fields. */
  readonly cmsFieldsFile: string | null;
  /** The profile site run's manifest.json; required at the freeze. */
  readonly cmsManifestFile: string | null;
  readonly acceptOverCredit: number;
  readonly acceptMissingExtraIds: number;
  readonly acceptProfileWritesAfterFreeze: number;
  readonly acceptUnmatchedCms: number;
  readonly acceptEditsAfterFreeze: number;
  readonly acceptRatingsChangedAfterFreeze: number;
  readonly acceptDelegationsAfterFreeze: number;
  /** --accept-no-extra-ids: at the freeze without the waves list. */
  readonly acceptNoExtraIds: boolean;
  /** --accept-bulk N: at the freeze with a --bulk other than 2000. */
  readonly acceptBulk: number | null;
  /** Printed before the run: IDENTITY_FREEZE_AT ignored by --no-freeze. */
  readonly notice: string | null;
  readonly overwrite: boolean;
}

export type IdentityExportCliCommand =
  | IdentityExportCommand
  | { readonly command: 'help' };

export class IdentityExportUsageError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportUsageError';
  }
}

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/** ISO 8601 UTC, or Unix milliseconds (13 digits: seconds are refused). */
export function parseFreezeTime(raw: string): number {
  const value = raw.trim();
  if (/^\d{13}$/.test(value)) {
    return Number(value);
  }
  const millis = ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) {
    throw new IdentityExportUsageError(
      `The freeze time must be ISO 8601 UTC or 13-digit Unix milliseconds, got "${raw}"`
    );
  }
  return millis;
}

/**
 * IDENTITY_FREEZE_AT as 6529.io's profile site reads it
 * (parseProfileCmsFreezeAt): undefined when unset, null when set to
 * something that is not a time, else Unix milliseconds. The export holds
 * itself to the freeze the site holds itself to.
 */
export function readIdentityFreezeAt(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d{1,16}$/.test(value)) {
    return Number(value);
  }
  const start = ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(start) ? start : null;
}

/**
 * Why IDENTITY_FREEZE_AT doesn't name this freeze, or null. An export at
 * the freeze exports 6529.io's own freeze: the setting must be set, be a
 * time, and be the freeze time.
 */
export function identityFreezeSettingProblem(
  freezeMs: number,
  raw: string | undefined
): string | null {
  const setting = readIdentityFreezeAt(raw);
  if (setting === undefined) {
    return `IDENTITY_FREEZE_AT is not set: an export at the freeze (${new Date(freezeMs).toISOString()}) exports 6529.io's own freeze, so the setting must name it. Before the freeze, run a rehearsal (--no-freeze, or noFreeze: true)`;
  }
  if (setting === null) {
    return `IDENTITY_FREEZE_AT is set but is not a time ("${raw}"): the run cannot tell which freeze it exports`;
  }
  if (setting !== freezeMs) {
    return `the freeze ${new Date(freezeMs).toISOString()} is not IDENTITY_FREEZE_AT ${Number.isFinite(setting) && Math.abs(setting) <= 8.64e15 ? new Date(setting).toISOString() : raw}`;
  }
  return null;
}

export function parseExtraIds(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new IdentityExportUsageError('The extra ids file is empty');
  }
  let ids: unknown;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // JSON, or refused: never read as whitespace-separated words.
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new IdentityExportUsageError(
        'The extra ids file starts like JSON but is not valid JSON'
      );
    }
    ids = Array.isArray(doc)
      ? doc
      : (doc as { profile_ids?: unknown } | null)?.profile_ids;
  } else {
    ids = trimmed.split(/\s+/);
  }
  if (!Array.isArray(ids)) {
    throw new IdentityExportUsageError(
      'The extra ids file must be a JSON list, {"profile_ids": [...]}, or whitespace separated ids'
    );
  }
  if (ids.some((it) => typeof it !== 'string')) {
    throw new IdentityExportUsageError(
      'Every extra id must be a string (a profile id)'
    );
  }
  const list = (ids as string[])
    .map((it) => it.trim().toLowerCase())
    .filter((it) => it.length > 0);
  if (!list.length) {
    throw new IdentityExportUsageError('The extra ids list is empty');
  }
  const bad = list.filter((it) => !UUID.test(it));
  if (bad.length) {
    throw new IdentityExportUsageError(
      `Extra ids must be profile ids (UUIDs): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', ...' : ''}`
    );
  }
  // Each id once: the export counts unique ids.
  return Array.from(new Set(list));
}

/**
 * The profile site export's cms-fields.json: profile id -> the ProfileDoc
 * `cms` value (an object), carried into the export as it is.
 */
export function parseCmsFields(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new IdentityExportUsageError('The cms fields file is not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new IdentityExportUsageError(
      'The cms fields file must be a JSON object: profile id -> cms value'
    );
  }
  const entries = Object.entries(doc);
  if (!entries.length) {
    throw new IdentityExportUsageError(
      'The cms fields file is empty: give --no-cms-fields instead'
    );
  }
  const fields: Record<string, unknown> = {};
  for (const [profileId, value] of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityExportUsageError(
        `The cms value of ${profileId} is not an object`
      );
    }
    const key = profileId.trim().toLowerCase();
    if (key in fields) {
      throw new IdentityExportUsageError(
        `The cms fields file names ${key} twice (keys are compared lowercase)`
      );
    }
    fields[key] = value;
  }
  return fields;
}

interface Draft {
  out: string | null;
  bulk: number;
  extraIdsFile: string | null;
  noExtraIds: boolean;
  /** --freeze-at, as given. */
  freezeAt: number | null;
  noFreeze: boolean;
  expectTdhBlock: number | null;
  revision: string | null;
  includeDelegations: boolean;
  cmsFieldsFile: string | null;
  cmsManifestFile: string | null;
  noCmsFields: boolean;
  acceptOverCredit: number;
  acceptMissingExtraIds: number;
  acceptProfileWritesAfterFreeze: number;
  acceptUnmatchedCms: number;
  acceptDelegationsAfterFreeze: number;
  acceptNoExtraIds: boolean;
  acceptBulk: number | null;
  /** The --accept-* flags given: each needs --expect-tdh-block. */
  acceptsGiven: string[];
  /** IDENTITY_FREEZE_AT, raw, when the options were read. */
  envFreezeRaw: string | undefined;
  acceptEditsAfterFreeze: number;
  acceptRatingsChangedAfterFreeze: number;
  overwrite: boolean;
}

function wholeNumber(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new IdentityExportUsageError(
      `${flag} must be a whole number, got "${raw}"`
    );
  }
  return Number(raw);
}

/** Reads one option into the draft; returns how many arguments it took. */
function readOption(
  draft: Draft,
  arg: string,
  next: string | undefined
): number {
  const value = () => {
    if (next === undefined || next.startsWith('--')) {
      throw new IdentityExportUsageError(`${arg} needs a value`);
    }
    return next;
  };
  const accept = (set: (count: number) => void) => {
    set(wholeNumber(arg, value()));
    draft.acceptsGiven.push(arg);
    return 2;
  };
  switch (arg) {
    case '--out':
      draft.out = value();
      return 2;
    case '--bulk':
      draft.bulk = wholeNumber(arg, value());
      return 2;
    case '--extra-ids':
      draft.extraIdsFile = value();
      return 2;
    case '--no-extra-ids':
      draft.noExtraIds = true;
      return 1;
    case '--freeze-at':
      draft.freezeAt = parseFreezeTime(value());
      return 2;
    case '--no-freeze':
      draft.noFreeze = true;
      return 1;
    case '--expect-tdh-block':
      draft.expectTdhBlock = wholeNumber(arg, value());
      return 2;
    case '--revision':
      draft.revision = value();
      return 2;
    case '--no-delegations':
      draft.includeDelegations = false;
      return 1;
    case '--cms-fields':
      draft.cmsFieldsFile = value();
      return 2;
    case '--cms-manifest':
      draft.cmsManifestFile = value();
      return 2;
    case '--no-cms-fields':
      draft.noCmsFields = true;
      return 1;
    case '--accept-missing-extra-ids':
      return accept((n) => (draft.acceptMissingExtraIds = n));
    case '--accept-profile-writes-after-freeze':
      return accept((n) => (draft.acceptProfileWritesAfterFreeze = n));
    case '--accept-unmatched-cms':
      return accept((n) => (draft.acceptUnmatchedCms = n));
    case '--accept-over-credit':
      return accept((n) => (draft.acceptOverCredit = n));
    case '--accept-edits-after-freeze':
      return accept((n) => (draft.acceptEditsAfterFreeze = n));
    case '--accept-ratings-changed-after-freeze':
      return accept((n) => (draft.acceptRatingsChangedAfterFreeze = n));
    case '--accept-delegations-after-freeze':
      return accept((n) => (draft.acceptDelegationsAfterFreeze = n));
    case '--accept-bulk':
      return accept((n) => (draft.acceptBulk = n));
    case '--accept-no-extra-ids':
      draft.acceptNoExtraIds = true;
      draft.acceptsGiven.push(arg);
      return 1;
    case '--overwrite':
      draft.overwrite = true;
      return 1;
    default:
      throw new IdentityExportUsageError(`Unknown argument "${arg}"`);
  }
}

/** The freeze time from --freeze-at, IDENTITY_FREEZE_AT and --no-freeze. */
function freezeOf(draft: Draft): {
  freezeMs: number | null;
  notice: string | null;
} {
  if (draft.noFreeze && draft.freezeAt !== null) {
    throw new IdentityExportUsageError(
      'Give --freeze-at or --no-freeze, not both'
    );
  }
  const env = readIdentityFreezeAt(draft.envFreezeRaw);
  if (draft.noFreeze) {
    return {
      freezeMs: null,
      notice:
        env === undefined
          ? null
          : `IDENTITY_FREEZE_AT is set ("${draft.envFreezeRaw!.trim()}"), but --no-freeze writes a rehearsal: it is not held to that freeze and the chain's import never takes it`
    };
  }
  if (env === null) {
    throw new IdentityExportUsageError(
      `IDENTITY_FREEZE_AT is set but is not a time ("${draft.envFreezeRaw}"): the run cannot tell which freeze it exports`
    );
  }
  const freezeMs = draft.freezeAt ?? env ?? null;
  if (freezeMs === null) {
    throw new IdentityExportUsageError(
      'Give the freeze time (--freeze-at, or IDENTITY_FREEZE_AT) or --no-freeze for a rehearsal'
    );
  }
  if (freezeMs % DAY_MS !== 0) {
    throw new IdentityExportUsageError(
      `The freeze time must be 00:00 UTC, got ${new Date(freezeMs).toISOString()}`
    );
  }
  // IDENTITY_FREEZE_AT may only come from the .env file, read later: the
  // run checks it again then (identityFreezeSettingProblem).
  const problem =
    env === undefined
      ? null
      : identityFreezeSettingProblem(freezeMs, draft.envFreezeRaw);
  if (problem) {
    throw new IdentityExportUsageError(problem);
  }
  return { freezeMs, notice: null };
}

/** What an export at the freeze must take, decided before any read. */
function checkAtFreeze(draft: Draft): void {
  if (!draft.includeDelegations) {
    throw new IdentityExportUsageError(
      '--no-delegations is for a rehearsal: an export at the freeze carries the delegations'
    );
  }
  if (draft.noCmsFields) {
    throw new IdentityExportUsageError(
      '--no-cms-fields is for a rehearsal: an export at the freeze carries the profile site values, with --cms-fields and --cms-manifest'
    );
  }
  if (draft.cmsManifestFile === null) {
    throw new IdentityExportUsageError(
      "An export at the freeze needs --cms-manifest FILE: the profile site run's manifest.json that lists the --cms-fields file"
    );
  }
  if (draft.noExtraIds !== draft.acceptNoExtraIds) {
    throw new IdentityExportUsageError(
      draft.noExtraIds
        ? '--no-extra-ids at the freeze leaves out the profiles in scope only for waves activity: acknowledge it with --accept-no-extra-ids'
        : '--accept-no-extra-ids is only with --no-extra-ids'
    );
  }
  if (draft.bulk === DEFAULT_BULK && draft.acceptBulk !== null) {
    throw new IdentityExportUsageError(
      `--accept-bulk ${draft.acceptBulk} does not match: --bulk is the default ${DEFAULT_BULK}; leave --accept-bulk out`
    );
  }
  if (draft.bulk !== DEFAULT_BULK && draft.acceptBulk !== draft.bulk) {
    throw new IdentityExportUsageError(
      `--bulk ${draft.bulk} at the freeze is not the default ${DEFAULT_BULK}: acknowledge it with --accept-bulk ${draft.bulk}`
    );
  }
}

function checkDraft(draft: Draft): IdentityExportCommand {
  if (!draft.out) {
    throw new IdentityExportUsageError('--out FILE is required');
  }
  if (draft.revision === null) {
    throw new IdentityExportUsageError(
      'The exporter revision is required: pass --revision <40-hex commit> or set EXPORTER_REVISION'
    );
  }
  if (!/^[0-9a-f]{40}$/.test(draft.revision.toLowerCase())) {
    throw new IdentityExportUsageError(
      `The revision must be a 40-hex git commit, got "${draft.revision}"`
    );
  }
  const { freezeMs, notice } = freezeOf(draft);
  if (draft.acceptsGiven.length && draft.expectTdhBlock === null) {
    throw new IdentityExportUsageError(
      `${draft.acceptsGiven.join(', ')}: an acknowledgement is only for an export at the freeze, with --expect-tdh-block`
    );
  }
  if (freezeMs !== null && draft.expectTdhBlock === null) {
    throw new IdentityExportUsageError(
      "An export at the freeze needs --expect-tdh-block N, the freeze day's TDH block, so it can't write another day's TDH (a --no-freeze rehearsal needs none)"
    );
  }
  if ((draft.extraIdsFile === null) === !draft.noExtraIds) {
    throw new IdentityExportUsageError(
      'Give the waves list (--extra-ids FILE) or --no-extra-ids, one of the two'
    );
  }
  if ((draft.cmsFieldsFile === null) === !draft.noCmsFields) {
    throw new IdentityExportUsageError(
      'Give the profile site values (--cms-fields FILE) or --no-cms-fields, one of the two'
    );
  }
  if (draft.cmsManifestFile !== null && draft.cmsFieldsFile === null) {
    throw new IdentityExportUsageError(
      '--cms-manifest is the manifest of the --cms-fields file: give both'
    );
  }
  if (freezeMs !== null) {
    checkAtFreeze(draft);
  }
  return {
    command: 'export',
    out: draft.out,
    bulk: draft.bulk,
    extraIdsFile: draft.extraIdsFile,
    freezeMs,
    expectTdhBlock: draft.expectTdhBlock,
    revision: draft.revision.toLowerCase(),
    includeDelegations: draft.includeDelegations,
    cmsFieldsFile: draft.cmsFieldsFile,
    cmsManifestFile: draft.cmsManifestFile,
    acceptOverCredit: draft.acceptOverCredit,
    acceptMissingExtraIds: draft.acceptMissingExtraIds,
    acceptProfileWritesAfterFreeze: draft.acceptProfileWritesAfterFreeze,
    acceptUnmatchedCms: draft.acceptUnmatchedCms,
    acceptEditsAfterFreeze: draft.acceptEditsAfterFreeze,
    acceptRatingsChangedAfterFreeze: draft.acceptRatingsChangedAfterFreeze,
    acceptDelegationsAfterFreeze: draft.acceptDelegationsAfterFreeze,
    acceptNoExtraIds: draft.acceptNoExtraIds,
    acceptBulk: draft.acceptBulk,
    notice,
    overwrite: draft.overwrite
  };
}

export function parseIdentityExportCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env
): IdentityExportCliCommand {
  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'help' };
  }
  const draft: Draft = {
    out: null,
    bulk: DEFAULT_BULK,
    extraIdsFile: null,
    noExtraIds: false,
    freezeAt: null,
    envFreezeRaw: env.IDENTITY_FREEZE_AT,
    noFreeze: false,
    expectTdhBlock: null,
    revision: env.EXPORTER_REVISION?.trim() || null,
    includeDelegations: true,
    cmsFieldsFile: null,
    cmsManifestFile: null,
    noCmsFields: false,
    acceptOverCredit: 0,
    acceptMissingExtraIds: 0,
    acceptProfileWritesAfterFreeze: 0,
    acceptUnmatchedCms: 0,
    acceptDelegationsAfterFreeze: 0,
    acceptNoExtraIds: false,
    acceptBulk: null,
    acceptsGiven: [],
    acceptEditsAfterFreeze: 0,
    acceptRatingsChangedAfterFreeze: 0,
    overwrite: false
  };
  for (let i = 0; i < args.length; ) {
    i += readOption(draft, args[i], args[i + 1]);
  }
  return checkDraft(draft);
}

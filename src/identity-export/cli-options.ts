export const IDENTITY_EXPORT_HELP = `Usage: 6529 run identity:export -- --out FILE --revision HEX
         (--freeze-at TIME --expect-tdh-block N | --no-freeze)
         (--extra-ids FILE | --no-extra-ids) [--bulk N] [--no-delegations]
         [--cms-fields FILE] [--accept-over-credit N]
         [--accept-edits-after-freeze N]
         [--accept-ratings-changed-after-freeze N] [--overwrite]

Writes 6529.io's identities, profiles, REP and CIC ratings and reserved
handles as a 6529.identity-export.v1 JSON file, the input of the Identities
v1 file the 6529 chain imports at the identity freeze. Read-only: it reads
the read pool (DB_HOST_READ) in one read-only transaction with a consistent
snapshot. Run it against a read replica.

Options:
  --out FILE             where to write the export (required)
  --revision HEX         the exporter's 40-hex git commit, such as
                         $(git rev-parse HEAD) (or EXPORTER_REVISION; required)
  --freeze-at TIME       the freeze time T: ISO 8601 UTC or 13-digit Unix
                         milliseconds (or IDENTITY_FREEZE_AT)
  --no-freeze            a rehearsal export, not at the freeze (freeze_ms null)
  --extra-ids FILE       profile ids in scope for waves activity: a JSON list,
                         {"profile_ids": [...]}, or whitespace separated
  --no-extra-ids         export without the waves list (noted in the file)
  --expect-tdh-block N   fail, before the long reads, unless 6529.io's latest
                         TDH block is N (B_T at the freeze), taken in the hour
                         before the freeze, the identities sync has caught up
                         with that TDH write, no rater is over credit and no
                         REP or CIC edit was logged after the freeze; required
                         with a freeze time
  --accept-over-credit N accept up to N raters over their credit (TDH + xTDH),
                         exported as they are
  --accept-edits-after-freeze N
                         accept up to N REP or CIC edits logged after the
                         freeze (over-rate cuts and help-bot credits aside)
  --accept-ratings-changed-after-freeze N
                         accept up to N REP or CIC ratings whose
                         last_modified is after the freeze (help-bot credits
                         aside, zeros included)
  --bulk N               a rater's REP category with more than N targets brings
                         no target in by itself (default 2000; 0 turns it off)
  --no-delegations       leave out 6529.io's delegations table
  --cms-fields FILE      the profile site export's cms-fields.json (profile id
                         -> the ProfileDoc cms value): each identity of those
                         profiles gets that value as "cms"
  --overwrite            replace FILE if it exists (it is written to FILE.tmp
                         and renamed at the end)
  --help                 this text

Exit codes: 0 written; 1 failed; 2 a usage error (or FILE exists); 3 not
the freeze day's TDH yet (the TDH block, its time, the day's full TDH write
or the identities sync); 4 raters over their credit, not acknowledged; 5
REP or CIC changed after the freeze, not acknowledged. Nothing is written
on 3, 4 or 5: wait, or acknowledge, and run again.
`;

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
  /** The profile site export's cms-fields.json; null without --cms-fields. */
  readonly cmsFieldsFile: string | null;
  readonly acceptOverCredit: number;
  readonly acceptEditsAfterFreeze: number;
  readonly acceptRatingsChangedAfterFreeze: number;
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

export function parseExtraIds(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  let ids: unknown;
  try {
    const doc = JSON.parse(trimmed);
    ids = Array.isArray(doc) ? doc : doc?.profile_ids;
  } catch {
    ids = trimmed.split(/\s+/);
  }
  if (!Array.isArray(ids)) {
    throw new IdentityExportUsageError(
      'The extra ids file must be a JSON list, {"profile_ids": [...]}, or whitespace separated ids'
    );
  }
  return ids
    .filter((it): it is string => typeof it === 'string')
    .map((it) => it.trim().toLowerCase())
    .filter((it) => it.length > 0);
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
  const fields: Record<string, unknown> = {};
  for (const [profileId, value] of Object.entries(doc)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityExportUsageError(
        `The cms value of ${profileId} is not an object`
      );
    }
    fields[profileId.trim().toLowerCase()] = value;
  }
  return fields;
}

interface Draft {
  out: string | null;
  bulk: number;
  extraIdsFile: string | null;
  noExtraIds: boolean;
  freezeMs: number | null;
  noFreeze: boolean;
  expectTdhBlock: number | null;
  revision: string | null;
  includeDelegations: boolean;
  cmsFieldsFile: string | null;
  acceptOverCredit: number;
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
      draft.freezeMs = parseFreezeTime(value());
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
    case '--accept-over-credit':
      draft.acceptOverCredit = wholeNumber(arg, value());
      return 2;
    case '--accept-edits-after-freeze':
      draft.acceptEditsAfterFreeze = wholeNumber(arg, value());
      return 2;
    case '--accept-ratings-changed-after-freeze':
      draft.acceptRatingsChangedAfterFreeze = wholeNumber(arg, value());
      return 2;
    case '--overwrite':
      draft.overwrite = true;
      return 1;
    default:
      throw new IdentityExportUsageError(`Unknown argument "${arg}"`);
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
  if ((draft.freezeMs === null) === !draft.noFreeze) {
    throw new IdentityExportUsageError(
      'Give the freeze time (--freeze-at or IDENTITY_FREEZE_AT) or --no-freeze for a rehearsal, one of the two'
    );
  }
  if (draft.freezeMs !== null && draft.expectTdhBlock === null) {
    throw new IdentityExportUsageError(
      "An export at the freeze needs --expect-tdh-block N, the freeze day's TDH block, so it can't write another day's TDH (a --no-freeze rehearsal needs none)"
    );
  }
  if ((draft.extraIdsFile === null) === !draft.noExtraIds) {
    throw new IdentityExportUsageError(
      'Give the waves list (--extra-ids FILE) or --no-extra-ids, one of the two'
    );
  }
  return {
    command: 'export',
    out: draft.out,
    bulk: draft.bulk,
    extraIdsFile: draft.extraIdsFile,
    freezeMs: draft.freezeMs,
    expectTdhBlock: draft.expectTdhBlock,
    revision: draft.revision.toLowerCase(),
    includeDelegations: draft.includeDelegations,
    cmsFieldsFile: draft.cmsFieldsFile,
    acceptOverCredit: draft.acceptOverCredit,
    acceptEditsAfterFreeze: draft.acceptEditsAfterFreeze,
    acceptRatingsChangedAfterFreeze: draft.acceptRatingsChangedAfterFreeze,
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
    bulk: 2000,
    extraIdsFile: null,
    noExtraIds: false,
    freezeMs: env.IDENTITY_FREEZE_AT
      ? parseFreezeTime(env.IDENTITY_FREEZE_AT)
      : null,
    noFreeze: false,
    expectTdhBlock: null,
    revision: env.EXPORTER_REVISION?.trim() || null,
    includeDelegations: true,
    cmsFieldsFile: null,
    acceptOverCredit: 0,
    acceptEditsAfterFreeze: 0,
    acceptRatingsChangedAfterFreeze: 0,
    overwrite: false
  };
  for (let i = 0; i < args.length; ) {
    i += readOption(draft, args[i], args[i + 1]);
  }
  return checkDraft(draft);
}

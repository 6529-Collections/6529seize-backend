export const IDENTITY_EXPORT_HELP = `Usage: 6529 run identity:export -- --out FILE [options]

Writes 6529.io's identities, profiles, REP and CIC ratings and reserved
handles as a 6529.identity-export.v1 JSON file, the input of the Identities
v1 file the 6529 chain imports at the identity freeze. Read-only: it reads
the read pool (DB_HOST_READ) in one read-only transaction with a consistent
snapshot. Run it against a read replica.

Options:
  --out FILE           where to write the export (required)
  --bulk N             a rater's REP category with more than N targets brings
                       no one in by itself (default 2000; 0 turns it off)
  --extra-ids FILE     profile ids in scope for waves activity: a JSON list,
                       {"profile_ids": [...]}, or whitespace separated
  --freeze-at TIME     the freeze time T (ISO 8601 UTC) or Unix milliseconds;
                       defaults to IDENTITY_FREEZE_AT when that is set
  --revision HEX       the exporter's 40-hex git commit (default: EXPORTER_REVISION,
                       then git rev-parse HEAD)
  --no-delegations     leave out 6529.io's delegations table
  --help               this text
`;

export interface IdentityExportCommand {
  readonly command: 'export';
  readonly out: string;
  readonly bulk: number;
  readonly extraIdsFile: string | null;
  readonly freezeMs: number | null;
  readonly revision: string | null;
  readonly includeDelegations: boolean;
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

export function parseFreezeTime(raw: string): number {
  const value = raw.trim();
  if (/^\d{1,16}$/.test(value)) {
    return Number(value);
  }
  const millis = ISO_UTC.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) {
    throw new IdentityExportUsageError(
      `The freeze time must be ISO 8601 UTC or Unix milliseconds, got "${raw}"`
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

export function parseIdentityExportCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env
): IdentityExportCliCommand {
  let out: string | null = null;
  let bulk = 2000;
  let extraIdsFile: string | null = null;
  let freezeMs: number | null = env.IDENTITY_FREEZE_AT
    ? parseFreezeTime(env.IDENTITY_FREEZE_AT)
    : null;
  let revision: string | null = env.EXPORTER_REVISION?.trim() || null;
  let includeDelegations = true;
  const value = (i: number, flag: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new IdentityExportUsageError(`${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        return { command: 'help' };
      case '--out':
        out = value(i++, arg);
        break;
      case '--bulk': {
        const raw = value(i++, arg);
        if (!/^\d+$/.test(raw)) {
          throw new IdentityExportUsageError(
            `--bulk must be a whole number, got "${raw}"`
          );
        }
        bulk = Number(raw);
        break;
      }
      case '--extra-ids':
        extraIdsFile = value(i++, arg);
        break;
      case '--freeze-at':
        freezeMs = parseFreezeTime(value(i++, arg));
        break;
      case '--revision':
        revision = value(i++, arg);
        break;
      case '--no-delegations':
        includeDelegations = false;
        break;
      default:
        throw new IdentityExportUsageError(`Unknown argument "${arg}"`);
    }
  }
  if (!out) {
    throw new IdentityExportUsageError('--out FILE is required');
  }
  if (revision !== null && !/^[0-9a-f]{40}$/.test(revision.toLowerCase())) {
    throw new IdentityExportUsageError(
      `The revision must be a 40-hex git commit, got "${revision}"`
    );
  }
  return {
    command: 'export',
    out,
    bulk,
    extraIdsFile,
    freezeMs,
    revision: revision?.toLowerCase() ?? null,
    includeDelegations
  };
}

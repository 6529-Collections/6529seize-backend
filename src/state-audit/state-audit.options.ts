import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';

/** Inclusive block span one audit may cover; larger windows are rejected. */
export const MAX_AUDIT_BLOCKS = 2000;
/** Highest block number the parser accepts; keeps arithmetic in safe integers. */
export const MAX_AUDIT_BLOCK_NUMBER = 1_000_000_000;
/** The only chain the ledger describes; must match the RPC client's network. */
export const DEFAULT_CHAIN_ID = 1;
/** Upper bound on the explicit `--wallets` filter. */
export const MAX_WALLET_FILTER = 250;

export type KnownContractName = 'memes' | 'gradients' | 'memelab';

export const KNOWN_CONTRACTS: Record<KnownContractName, string> = {
  memes: MEMES_CONTRACT,
  gradients: GRADIENT_CONTRACT,
  memelab: MEMELAB_CONTRACT
};

export interface StateAuditRequest {
  /** The `--contract` value exactly as given. */
  contract: string;
  fromBlock: number;
  toBlock: number;
  chainId: number;
  /** Lowercased, deduplicated, sorted; empty when no filter was given. */
  wallets: string[];
  out: string | null;
  format: 'json';
}

export type StateAuditCommand =
  | { command: 'help' }
  | { command: 'audit'; request: StateAuditRequest };

export class StateAuditUsageError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const FLAGS = [
  '--contract',
  '--from-block',
  '--to-block',
  '--chain-id',
  '--wallets',
  '--out',
  '--format'
] as const;

export const STATE_AUDIT_HELP = `Usage: 6529 run state-audit -- --contract <memes|gradients|memelab|0x...> --from-block N --to-block M [options]

Read-only audit of the stored transfer ledger (transactions table) against
canonical ERC-721/ERC-1155 transfer logs fetched from the configured RPC.

Options:
  --contract <name|0x...>  memes, gradients, memelab, or one of their addresses.
                           Any other address is reported as unsupported.
  --from-block N           First block of the window (inclusive).
  --to-block M             Last block of the window (inclusive). At most
                           ${MAX_AUDIT_BLOCKS} blocks per run.
  --chain-id N             Must equal the configured chain (default ${DEFAULT_CHAIN_ID}).
  --wallets a,b            Optional filter for the derived nft_owners check
                           (at most ${MAX_WALLET_FILTER} addresses).
  --out <file>             Write the manifest to this file instead of stdout.
  --format json            Output format (json only).

Exit codes: 0 clean, 3 differences_found, 4 inconclusive, 2 usage error,
1 execution failure.

--help prints this text without connecting to the database or the RPC.
The audit never writes to the database and never enqueues reconciliation.

Applying a reviewed manifest is a separate, gated subcommand:
  6529 run state-audit -- apply --help
`;

function usageError(message: string): never {
  throw new StateAuditUsageError(message);
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!(FLAGS as readonly string[]).includes(flag)) {
      usageError(`Unknown option ${flag}. Use --help for supported options.`);
    }
    if (flags.has(flag)) {
      usageError(`${flag} must not be repeated.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError(`${flag} requires a value.`);
    }
    flags.set(flag, value);
  }
  return flags;
}

function integerOption(
  flags: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
  fallback?: number
): number {
  const value = flags.get(name);
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (value === undefined || !/^\d+$/.test(value)) {
    return usageError(`${name} requires a whole decimal number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return usageError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseContract(flags: Map<string, string>): string {
  const value = flags.get('--contract');
  if (!value) {
    return usageError('--contract is required.');
  }
  const name = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_CONTRACTS, name)) {
    return name;
  }
  if (isHexAddress(value)) {
    return value;
  }
  return usageError(
    '--contract must be memes, gradients, memelab, or a 0x-prefixed 40-hex address.'
  );
}

function parseWallets(flags: Map<string, string>): string[] {
  const value = flags.get('--wallets');
  if (value === undefined) {
    return [];
  }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!parts.length) {
    return usageError('--wallets requires at least one address.');
  }
  const invalid = parts.find((part) => !isHexAddress(part));
  if (invalid !== undefined) {
    return usageError(`--wallets contains an invalid address: ${invalid}`);
  }
  const unique = Array.from(new Set(parts.map((part) => part.toLowerCase())));
  if (unique.length > MAX_WALLET_FILTER) {
    return usageError(
      `--wallets accepts at most ${MAX_WALLET_FILTER} distinct addresses.`
    );
  }
  return unique.sort((a, b) => a.localeCompare(b));
}

function parseFormat(flags: Map<string, string>): 'json' {
  const value = flags.get('--format') ?? 'json';
  if (value !== 'json') {
    return usageError('--format supports only json.');
  }
  return value;
}

function parseRange(flags: Map<string, string>): {
  fromBlock: number;
  toBlock: number;
} {
  const fromBlock = integerOption(
    flags,
    '--from-block',
    0,
    MAX_AUDIT_BLOCK_NUMBER
  );
  const toBlock = integerOption(flags, '--to-block', 0, MAX_AUDIT_BLOCK_NUMBER);
  if (toBlock < fromBlock) {
    usageError('--to-block must be greater than or equal to --from-block.');
  }
  if (toBlock - fromBlock + 1 > MAX_AUDIT_BLOCKS) {
    usageError(`The window may cover at most ${MAX_AUDIT_BLOCKS} blocks.`);
  }
  return { fromBlock, toBlock };
}

export function parseStateAuditCommand(args: string[]): StateAuditCommand {
  if (
    args.length === 0 ||
    args.some((arg) => ['--help', '-h', 'help'].includes(arg))
  ) {
    return { command: 'help' };
  }
  const flags = parseFlags(args);
  const contract = parseContract(flags);
  const range = parseRange(flags);
  return {
    command: 'audit',
    request: {
      contract,
      ...range,
      chainId: integerOption(
        flags,
        '--chain-id',
        1,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_CHAIN_ID
      ),
      wallets: parseWallets(flags),
      out: flags.get('--out') ?? null,
      format: parseFormat(flags)
    }
  };
}

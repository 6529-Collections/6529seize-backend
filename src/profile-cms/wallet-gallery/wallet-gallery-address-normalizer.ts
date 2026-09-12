import { ENS_TABLE, WALLET_REGEX } from '@/constants';
import { resolveWalletGalleryEns } from '@/profile-cms/wallet-gallery/wallet-gallery-ens-resolver';
import {
  WalletGalleryNormalizedInputs,
  WalletGalleryWalletInputResolution,
  WalletGalleryWalletResolutionStatus
} from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.types';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { ethers } from 'ethers';

interface EnsLookupRow {
  readonly wallet: string;
  readonly display: string | null;
}

interface ParsedWalletGalleryInput {
  readonly raw: string;
  readonly address: string | null;
  readonly ens: string | null;
}

const EMPTY_LOOKUP_SENTINEL = '__wallet_gallery_empty_lookup__';
// Supported ASCII .eth inputs; this is not a complete ENS name validator.
const ENS_NAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/;
const MAX_ENS_LOOKUPS = 25;
const ENS_LOOKUP_CONCURRENCY = 4;
const ENS_LOOKUP_TIMEOUT_MS = 4000;

interface EnsResolution {
  readonly address: string | null;
  readonly reason: 'ens_not_found' | 'ens_lookup_failed' | null;
}

export class WalletGalleryAddressNormalizer extends LazyDbAccessCompatibleService {
  constructor(
    sqlExecutorGetter: () => SqlExecutor,
    private readonly resolveEns: (
      name: string
    ) => Promise<string | null> = resolveWalletGalleryEns
  ) {
    super(sqlExecutorGetter);
  }

  async normalizeWalletInputs(
    inputs: string[],
    ctx: RequestContext
  ): Promise<WalletGalleryNormalizedInputs> {
    const parsedInputs = inputs.map((input) => parseWalletGalleryInput(input));
    const addressInputs = parsedInputs
      .map((input) => input.address)
      .filter((address): address is string => !!address);
    const ensInputs = parsedInputs
      .map((input) => input.ens)
      .filter((ens): ens is string => !!ens);
    const ensRows = await this.findEnsRows(addressInputs, ensInputs, ctx);
    const ensByWallet = mapEnsRowsByWallet(ensRows);
    const ensByDisplay = mapEnsRowsByDisplay(ensRows);
    const forwardResolutions = await this.resolveEnsNames(ensInputs);

    const resolvedInputs = parsedInputs.map((input) =>
      this.resolveParsedInput(
        input,
        ensByWallet,
        ensByDisplay,
        forwardResolutions
      )
    );

    return {
      inputs: resolvedInputs,
      addresses: distinctStrings(
        resolvedInputs
          .map((input) => input.address)
          .filter((address): address is string => !!address)
      )
    };
  }

  private async resolveEnsNames(
    ensNames: string[]
  ): Promise<Map<string, EnsResolution>> {
    const names = distinctStrings(ensNames).slice(0, MAX_ENS_LOOKUPS);
    const resolutions = new Map<string, EnsResolution>();
    if (!names.length) return resolutions;

    let nextIndex = 0;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, ENS_LOOKUP_TIMEOUT_MS);
    });
    const worker = async () => {
      while (!stopped && nextIndex < names.length) {
        const name = names[nextIndex++];
        resolutions.set(name, await this.resolveEnsOrNull(name));
      }
    };
    try {
      await Promise.race([
        Promise.all(
          Array.from(
            { length: Math.min(ENS_LOOKUP_CONCURRENCY, names.length) },
            worker
          )
        ),
        deadline
      ]);
    } finally {
      // Stop queued work at the request deadline. The four existing lookups
      // each have their own resolver and transport deadlines.
      stopped = true;
      clearTimeout(timeout);
    }
    return resolutions;
  }

  private async resolveEnsOrNull(name: string): Promise<EnsResolution> {
    try {
      const resolved = await this.resolveEns(name);
      const address = resolved ? normalizeEthereumAddress(resolved) : null;
      return address && address !== ethers.ZeroAddress
        ? { address, reason: null }
        : { address: null, reason: 'ens_not_found' };
    } catch {
      return { address: null, reason: 'ens_lookup_failed' };
    }
  }

  private async findEnsRows(
    addresses: string[],
    ensNames: string[],
    ctx: RequestContext
  ): Promise<EnsLookupRow[]> {
    if (!addresses.length && !ensNames.length) {
      return [];
    }
    const timerName = `${this.constructor.name}->findEnsRows`;
    try {
      ctx.timer?.start(timerName);
      return await this.db.execute<EnsLookupRow>(
        `
          SELECT lower(wallet) as wallet, display
          FROM ${ENS_TABLE}
          WHERE lower(wallet) IN (:addresses)
             OR lower(display) IN (:ensNames)
        `,
        {
          addresses: addresses.length ? addresses : [EMPTY_LOOKUP_SENTINEL],
          ensNames: ensNames.length ? ensNames : [EMPTY_LOOKUP_SENTINEL]
        },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private resolveParsedInput(
    input: ParsedWalletGalleryInput,
    ensByWallet: Map<string, EnsLookupRow>,
    ensByDisplay: Map<string, EnsLookupRow>,
    forwardResolutions: Map<string, EnsResolution>
  ): WalletGalleryWalletInputResolution {
    if (input.address) {
      const row = ensByWallet.get(input.address);
      return {
        input: input.raw,
        address: input.address,
        ens: normalizeEnsDisplay(row?.display),
        display: row?.display ?? input.address,
        status: WalletGalleryWalletResolutionStatus.RESOLVED,
        reason: null
      };
    }

    if (input.ens) {
      const resolution = forwardResolutions.get(input.ens);
      const row = ensByDisplay.get(input.ens);
      if (resolution?.address) {
        return {
          input: input.raw,
          address: resolution.address,
          ens: input.ens,
          display:
            row?.wallet.toLowerCase() === resolution.address
              ? (row.display ?? input.ens)
              : input.ens,
          status: WalletGalleryWalletResolutionStatus.RESOLVED,
          reason: null
        };
      }
      return {
        input: input.raw,
        address: null,
        ens: input.ens,
        display: input.ens,
        status: WalletGalleryWalletResolutionStatus.UNRESOLVED,
        reason: resolution?.reason ?? 'ens_lookup_failed'
      };
    }

    return {
      input: input.raw,
      address: null,
      ens: null,
      display: null,
      status: WalletGalleryWalletResolutionStatus.UNRESOLVED,
      reason: 'invalid_format'
    };
  }
}

export const walletGalleryAddressNormalizer =
  new WalletGalleryAddressNormalizer(dbSupplier);

export function normalizeEthereumAddress(input: string): string | null {
  const candidate = input.trim();
  if (!WALLET_REGEX.exec(candidate)) {
    return null;
  }
  try {
    return ethers.getAddress(candidate).toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeEnsName(input: string): string | null {
  const normalized = input.trim().replace(/\.$/, '').toLowerCase();
  return ENS_NAME_PATTERN.test(normalized) ? normalized : null;
}

function parseWalletGalleryInput(input: string): ParsedWalletGalleryInput {
  const raw = input.trim();
  return {
    raw,
    address: normalizeEthereumAddress(raw),
    ens: normalizeEnsName(raw)
  };
}

function normalizeEnsDisplay(
  display: string | null | undefined
): string | null {
  return display ? normalizeEnsName(display) : null;
}

function mapEnsRowsByWallet(rows: EnsLookupRow[]): Map<string, EnsLookupRow> {
  const result = new Map<string, EnsLookupRow>();
  rows.forEach((row) => {
    result.set(row.wallet.toLowerCase(), row);
  });
  return result;
}

function mapEnsRowsByDisplay(rows: EnsLookupRow[]): Map<string, EnsLookupRow> {
  const result = new Map<string, EnsLookupRow>();
  rows.forEach((row) => {
    const display = normalizeEnsDisplay(row.display);
    if (display) {
      result.set(display, row);
    }
  });
  return result;
}

function distinctStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });
  return result;
}

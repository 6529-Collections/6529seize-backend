import { ENS_TABLE, WALLET_REGEX } from '@/constants';
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
// This gates local ENS table lookups; it is not intended to validate ENS rules.
const ENS_NAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/;

export class WalletGalleryAddressNormalizer extends LazyDbAccessCompatibleService {
  constructor(sqlExecutorGetter: () => SqlExecutor) {
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

    const resolvedInputs = parsedInputs.map((input) =>
      this.resolveParsedInput(input, ensByWallet, ensByDisplay)
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
    ensByDisplay: Map<string, EnsLookupRow>
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
      const row = ensByDisplay.get(input.ens);
      if (row) {
        return {
          input: input.raw,
          address: row.wallet,
          ens: normalizeEnsDisplay(row.display) ?? input.ens,
          display: row.display ?? input.ens,
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
        reason: 'ens_not_found'
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

import { extractEvmAddresses } from '@/sanctions/evm-address';
import {
  compareCodePoints,
  isoDatePrefix,
  normalizeOptionalText
} from '@/sanctions/sanctions-text';
import { decodeUtf8 } from '@/sanctions/sanctions-xml';
import { scanFilesForAddresses } from '@/sanctions/parsers/parser-helpers';
import {
  ParsedSanctionsSource,
  RawSanctionsListing,
  SanctionsInputFile,
  SanctionsParseError,
  SanctionsSourceParser
} from '@/sanctions/parsers/sanctions-parser.types';

export const IL_NBCTF_API_PARSER_ID = 'il-nbctf-api/1';

export const IL_WALLETS_FILE = /^wallets-\d+\.json$/;
export const IL_ORDERS_FILE = /^orders-\d+\.json$/;

interface NamedRef {
  readonly name?: unknown;
}

interface WalletItem {
  readonly id?: unknown;
  readonly properties?: {
    readonly walletAddress?: unknown;
    readonly coinType?: unknown;
    readonly designatedOperatives?: NamedRef[] | null;
    readonly designatedOrganizations?: NamedRef[] | null;
  };
}

interface OrderItem {
  readonly name?: unknown;
  readonly properties?: {
    readonly orderType?: unknown;
    readonly orderDate?: unknown;
    readonly validityDate?: unknown;
    readonly isCanceled?: unknown;
    readonly assets?: Array<{ readonly id?: unknown }> | null;
  };
}

interface Order {
  readonly entryId: string;
  readonly orderType: string | null;
  readonly orderDate: string | null;
  readonly validityDate: string | null;
}

function fail(message: string): never {
  throw new SanctionsParseError('il-nbctf', message);
}

function pageItems<T>(file: SanctionsInputFile): T[] {
  const page = JSON.parse(decodeUtf8(file.bytes)) as { items?: unknown };
  if (!Array.isArray(page.items)) {
    fail(`${file.name} has no items array`);
  }
  return page.items as T[];
}

function names(refs: NamedRef[] | null | undefined): string[] {
  return (refs ?? [])
    .map((ref) => normalizeOptionalText(ref.name))
    .filter((name): name is string => name !== null);
}

/** Orders by wallet asset id. Cancelled orders are dropped, like delistings. */
function ordersByAsset(orders: OrderItem[]): {
  byAsset: Record<string, Order[]>;
  latestOrderDate: string | null;
} {
  const byAsset: Record<string, Order[]> = {};
  let latestOrderDate: string | null = null;
  for (const item of orders) {
    const properties = item.properties ?? {};
    const orderDate = isoDatePrefix(
      typeof properties.orderDate === 'string' ? properties.orderDate : null
    );
    if (
      orderDate !== null &&
      (latestOrderDate === null ||
        compareCodePoints(orderDate, latestOrderDate) > 0)
    ) {
      latestOrderDate = orderDate;
    }
    const entryId = normalizeOptionalText(item.name);
    if (entryId === null || properties.isCanceled === true) {
      continue;
    }
    const order: Order = {
      entryId,
      orderType: normalizeOptionalText(properties.orderType),
      orderDate,
      validityDate: isoDatePrefix(
        typeof properties.validityDate === 'string'
          ? properties.validityDate
          : null
      )
    };
    for (const asset of properties.assets ?? []) {
      if (typeof asset.id === 'string') {
        (byAsset[asset.id] = byAsset[asset.id] ?? []).push(order);
      }
    }
  }
  return { byAsset, latestOrderDate };
}

function walletAddressMatches(wallet: WalletItem): string[] {
  const text = wallet.properties?.walletAddress;
  return typeof text === 'string'
    ? extractEvmAddresses(text).map((match) => match.address)
    : [];
}

/** One listing per (address, order); wallets with no live order yield none. */
function walletListings(
  wallet: WalletItem,
  byAsset: Record<string, Order[]>
): RawSanctionsListing[] {
  const properties = wallet.properties ?? {};
  const text =
    typeof properties.walletAddress === 'string'
      ? properties.walletAddress
      : '';
  const addresses = extractEvmAddresses(text);
  if (addresses.length === 0) {
    return [];
  }
  const walletId =
    typeof wallet.id === 'string' ? wallet.id : fail('wallet without id');
  const orders = byAsset[walletId] ?? [];
  const coinType = normalizeOptionalText(properties.coinType);
  const holders = names(properties.designatedOrganizations).concat(
    names(properties.designatedOperatives)
  );
  const listings: RawSanctionsListing[] = [];
  for (const match of addresses) {
    for (const order of orders) {
      listings.push({
        address: match.address,
        entry_id: order.entryId,
        entity: holders.length > 0 ? holders.join('; ') : null,
        programs: order.orderType ? [order.orderType] : [],
        labels: coinType ? [coinType] : [],
        listed_on: order.orderDate,
        valid_until: order.validityDate
      });
    }
  }
  return listings;
}

/**
 * Israel MoD NBCTF seizure and forfeiture orders (Umbraco delivery API JSON,
 * paged). Each EVM wallet is joined to its orders by asset id; one listing
 * per order, carrying the order's validity date. The builder includes lapsed
 * orders; the check only enforces orders in force on the given date.
 */
export const parseIlNbctfApi: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const wallets: WalletItem[] = [];
  const orders: OrderItem[] = [];
  for (const file of files) {
    if (IL_WALLETS_FILE.test(file.name)) {
      wallets.push(...pageItems<WalletItem>(file));
    } else if (IL_ORDERS_FILE.test(file.name)) {
      orders.push(...pageItems<OrderItem>(file));
    } else {
      fail(`unexpected input file ${file.name}`);
    }
  }
  if (wallets.length === 0 || orders.length === 0) {
    fail('both wallet and order pages are required');
  }
  const { byAsset, latestOrderDate } = ordersByAsset(orders);
  const listings: RawSanctionsListing[] = [];
  const excluded: Record<string, true> = {};
  for (const wallet of wallets) {
    const walletResult = walletListings(wallet, byAsset);
    for (const listing of walletResult) {
      listings.push(listing);
    }
    if (walletResult.length === 0) {
      for (const match of walletAddressMatches(wallet)) {
        excluded[match] = true;
      }
    }
  }
  for (const listing of listings) {
    delete excluded[listing.address];
  }
  return {
    source_published: latestOrderDate,
    listings,
    scanned_addresses: scanFilesForAddresses(files),
    excluded_addresses: Object.keys(excluded).sort(compareCodePoints)
  };
};

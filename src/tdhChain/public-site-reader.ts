import {
  bodyJson,
  bodyText,
  FetchedBody,
  RateLimitedFetcher
} from './rate-limited-fetcher';
import { SiteDay } from './site-day';
import { siteDayFromUploads } from './site-uploads';

/**
 * 6529.io's values for one day from its public API, unauthenticated, through
 * a RateLimitedFetcher (two requests a second at most). Six GETs:
 *
 * 1. `/uploads?date=` and 2. `/consolidated_uploads?date=`: the newest 50
 *    upload rows (the API ignores `date` today), of which the day's is taken
 *    by its date;
 * 3, 4. the two CSV files they name, from an Arweave gateway;
 * 5. `/tdh_global_history?page_size=1` and 6. `/blocks?page_size=3`: the
 *    site's newest totals and TDH blocks, kept as evidence.
 *
 * Nothing here reads a database.
 */

export const DEFAULT_SITE_API = 'https://api.6529.io/api';

/** The Arweave gateways the validator's compare crate accepts. */
export const ARWEAVE_HOSTS = [
  'arweave.net',
  'ar-io.dev',
  'ardrive.net',
  'turbo-gateway.com'
];

export interface PublicSiteRead {
  readonly site: SiteDay;
  /** Every body fetched, by a short name, to save beside the report. */
  readonly bodies: Readonly<Record<string, FetchedBody>>;
  readonly notes: readonly string[];
}

export class PublicSiteReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSiteReadError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function uploadUrl(listing: any, date: string, what: string): string {
  const rows: any[] = Array.isArray(listing?.data) ? listing.data : [];
  const ofDay = rows.filter((r) => String(r?.date) === date);
  if (ofDay.length !== 1) {
    throw new PublicSiteReadError(
      `${what}: ${ofDay.length} uploads dated ${date}, expected 1`
    );
  }
  const url = ofDay[0].url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new PublicSiteReadError(`${what}: upload url ${JSON.stringify(url)}`);
  }
  return url;
}

export async function readSiteDayPublic(
  fetcher: RateLimitedFetcher,
  date: string,
  apiBase: string = DEFAULT_SITE_API
): Promise<PublicSiteRead> {
  const base = apiBase.replace(/\/+$/, '');
  const bodies: Record<string, FetchedBody> = {};
  const notes: string[] = [];

  bodies.uploads = await fetcher.get(
    `${base}/uploads?date=${date}&page_size=50`
  );
  bodies.consolidatedUploads = await fetcher.get(
    `${base}/consolidated_uploads?date=${date}&page_size=50`
  );
  const walletUrl = uploadUrl(bodyJson(bodies.uploads), date, 'uploads');
  const consolidatedUrl = uploadUrl(
    bodyJson(bodies.consolidatedUploads),
    date,
    'consolidated_uploads'
  );
  bodies.walletCsv = await fetcher.get(walletUrl);
  bodies.consolidatedCsv = await fetcher.get(consolidatedUrl);
  for (const k of ['walletCsv', 'consolidatedCsv']) {
    if (bodies[k].status !== 200) {
      throw new PublicSiteReadError(
        `${bodies[k].url}: HTTP ${bodies[k].status}`
      );
    }
  }
  bodies.globalHistory = await fetcher.get(
    `${base}/tdh_global_history?page_size=1`
  );
  bodies.blocks = await fetcher.get(`${base}/blocks?page_size=3`);

  const site = siteDayFromUploads(
    bodyText(bodies.walletCsv),
    bodyText(bodies.consolidatedCsv)
  );
  try {
    const latest = bodyJson(bodies.globalHistory)?.data?.[0];
    if (latest && String(latest.date).replace(/-/g, '').slice(0, 8) === date) {
      notes.push(
        `site global history for ${date}: total_boosted_tdh ${latest.total_boosted_tdh}, block ${latest.block}`
      );
    } else if (latest) {
      notes.push(
        `site global history's newest row is ${latest.date}, not ${date}`
      );
    }
  } catch {
    notes.push('site global history unreadable');
  }
  return { site, bodies, notes };
}

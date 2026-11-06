import axios from 'axios';
import { readFileSync } from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { sha256Hex } from '@/sanctions/content-address';
import { JP_MOF_FILE_NAME } from '@/sanctions/parsers/jp-mof-csv.parser';
import {
  KR_FSC_PINNED_FILE_NAME,
  PinnedSourceFile
} from '@/sanctions/parsers/kr-fsc-pinned.parser';
import type { SanctionsSourceId } from '@/sanctions/sanctions-list.types';

/**
 * The fetch stage: downloads every official source. Unlike the build, it is
 * not deterministic (governments update their files), so it records exactly
 * what it fetched, by sha256, in an inputs manifest the build then checks.
 */

const USER_AGENT = '6529-sanctions-list-builder/1 (+https://6529.io)';
const TIMEOUT_MS = 180_000;
const MAX_BYTES = 300 * 1024 * 1024;

const OFAC_SDN_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/download/SDN.XML';
const UK_XML_URL =
  'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml';
const EU_XML_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const CH_XML_URL =
  'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction';
const JP_LIST_PAGE_URL =
  'https://www.mof.go.jp/policy/international_policy/gaitame_kawase/gaitame/economic_sanctions/list.html';
const CA_XML_URL =
  'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml';
const IL_API_URL = 'https://matal.mod.gov.il/umbraco/delivery/api/v2/content';
const IL_WALLETS_PAGE = 500;
const IL_ORDERS_PAGE = 200;

export const KR_FSC_PINNED_PATH = path.join(
  __dirname,
  'sources',
  KR_FSC_PINNED_FILE_NAME
);

export interface FetchedFile {
  readonly name: string;
  readonly url: string;
  readonly bytes: Buffer;
  readonly fetched_at: string;
}

export interface FetchedSource {
  readonly source: SanctionsSourceId;
  readonly files: FetchedFile[];
}

export interface PinnedDocumentCheck {
  readonly source: SanctionsSourceId;
  readonly url: string;
  readonly expected_sha256: string;
  readonly actual_sha256: string | null;
  readonly matches: boolean;
  readonly error: string | null;
}

export type HttpGet = (url: string) => Promise<Buffer>;

export const defaultHttpGet: HttpGet = async (url: string) => {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_BYTES,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (status) => status === 200
  });
  return Buffer.from(response.data);
};

async function fetchOne(
  get: HttpGet,
  name: string,
  url: string
): Promise<FetchedFile> {
  const bytes = await get(url);
  return { name, url, bytes, fetched_at: new Date().toISOString() };
}

/** Finds the newest consolidated CSV linked from the MoF list page. */
export function findJpCsvUrl(listPageHtml: string, pageUrl: string): string {
  const pattern = /href="([^"]*shisantouketsu(\d{8})\.csv)"/g;
  let best: { href: string; date: string } | null = null;
  let match = pattern.exec(listPageHtml);
  while (match !== null) {
    if (best === null || match[2] > best.date) {
      best = { href: match[1], date: match[2] };
    }
    match = pattern.exec(listPageHtml);
  }
  if (best === null) {
    throw new Error('jp-mof: no shisantouketsu CSV link on the list page');
  }
  return new URL(best.href, pageUrl).toString();
}

async function fetchJp(get: HttpGet): Promise<FetchedFile[]> {
  const page = await get(JP_LIST_PAGE_URL);
  const csvUrl = findJpCsvUrl(page.toString('utf8'), JP_LIST_PAGE_URL);
  const name = csvUrl.slice(csvUrl.lastIndexOf('/') + 1);
  if (!JP_MOF_FILE_NAME.test(name)) {
    throw new Error(`jp-mof: unexpected CSV name ${name}`);
  }
  return [await fetchOne(get, name, csvUrl)];
}

async function fetchIlPages(
  get: HttpGet,
  filter: string,
  pageSize: number,
  prefix: string
): Promise<FetchedFile[]> {
  const files: FetchedFile[] = [];
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;
  while (skip < total) {
    const url = `${IL_API_URL}?filter=${filter}&skip=${skip}&take=${pageSize}`;
    const file = await fetchOne(get, `${prefix}-${skip}.json`, url);
    const page = JSON.parse(file.bytes.toString('utf8')) as {
      total?: unknown;
      items?: unknown[];
    };
    if (typeof page.total !== 'number' || !Array.isArray(page.items)) {
      throw new Error(`il-nbctf: unexpected page shape at ${url}`);
    }
    total = page.total;
    files.push(file);
    if (page.items.length === 0) {
      break;
    }
    skip += pageSize;
  }
  return files;
}

async function fetchIl(get: HttpGet): Promise<FetchedFile[]> {
  const wallets = await fetchIlPages(
    get,
    'contentType:cryptocurrencyWallet',
    IL_WALLETS_PAGE,
    'wallets'
  );
  const orders = await fetchIlPages(
    get,
    'contentType:seizureAndForfeitureOrder',
    IL_ORDERS_PAGE,
    'orders'
  );
  return wallets.concat(orders);
}

function pinnedKr(): FetchedFile {
  return {
    name: KR_FSC_PINNED_FILE_NAME,
    url: `repo:src/sanctions/sources/${KR_FSC_PINNED_FILE_NAME}`,
    bytes: readFileSync(KR_FSC_PINNED_PATH),
    fetched_at: new Date().toISOString()
  };
}

const FETCHERS: Record<
  SanctionsSourceId,
  (get: HttpGet) => Promise<FetchedFile[]>
> = {
  'ca-sema': async (get) => [await fetchOne(get, 'sema-lmes.xml', CA_XML_URL)],
  'ch-seco': async (get) => [
    await fetchOne(get, 'consolidated-list.xml', CH_XML_URL)
  ],
  'eu-fsf': async (get) => [
    await fetchOne(get, 'xmlFullSanctionsList_1_1.xml', EU_XML_URL)
  ],
  'il-nbctf': fetchIl,
  'jp-mof': fetchJp,
  'kr-fsc': async () => [pinnedKr()],
  'uk-fcdo': async (get) => [
    await fetchOne(get, 'UK-Sanctions-List.xml', UK_XML_URL)
  ],
  'us-ofac-sdn': async (get) => [await fetchOne(get, 'SDN.XML', OFAC_SDN_URL)]
};

export async function fetchSanctionsSource(
  source: SanctionsSourceId,
  get: HttpGet = defaultHttpGet
): Promise<FetchedSource> {
  return { source, files: await FETCHERS[source](get) };
}

/**
 * Re-downloads the official document behind a pinned (manually reviewed)
 * source and compares its sha256 with the reviewed one. A mismatch means the
 * authority amended the document and a human must update the pinned file.
 */
export async function checkKrPinnedDocument(
  get: HttpGet = defaultHttpGet
): Promise<PinnedDocumentCheck> {
  const pinned = JSON.parse(
    readFileSync(KR_FSC_PINNED_PATH, 'utf8')
  ) as PinnedSourceFile;
  const { url, sha256 } = pinned.document;
  try {
    const actual = sha256Hex(await get(url));
    return {
      source: 'kr-fsc',
      url,
      expected_sha256: sha256,
      actual_sha256: actual,
      matches: actual === sha256,
      error: null
    };
  } catch (error) {
    return {
      source: 'kr-fsc',
      url,
      expected_sha256: sha256,
      actual_sha256: null,
      matches: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

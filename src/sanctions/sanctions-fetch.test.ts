import {
  assertAllowedSourceUrl,
  fetchSanctionsSource,
  findJpCsvUrl,
  HttpGet
} from '@/sanctions/sanctions-fetch';

describe('findJpCsvUrl', () => {
  const page =
    'https://www.mof.go.jp/policy/international_policy/gaitame_kawase/gaitame/economic_sanctions/list.html';

  it('picks the newest consolidated CSV and resolves it against the page', () => {
    const html = `
      <a href="shisantouketsu20260701.csv">old</a>
      <a href="/policy/x/shisantouketsu20261105.csv">new</a>
      <a href="shisantouketsu20261105.xlsx">xlsx</a>`;
    expect(findJpCsvUrl(html, page)).toBe(
      'https://www.mof.go.jp/policy/x/shisantouketsu20261105.csv'
    );
  });

  it('fails loudly when the link disappears', () => {
    expect(() => findJpCsvUrl('<html></html>', page)).toThrow(
      /no shisantouketsu/
    );
  });
});

function ilServer(options: { walletTotals?: number[]; repeatId?: boolean }): {
  get: HttpGet;
  requested: string[];
} {
  const requested: string[] = [];
  const get: HttpGet = async (url) => {
    requested.push(url);
    const isWallets = url.indexOf('cryptocurrencyWallet') !== -1;
    const skip = Number(/skip=(\d+)/.exec(url)![1]);
    const pageSize = isWallets ? 500 : 200;
    const walletPage = skip / 500;
    const total = isWallets
      ? (options.walletTotals ?? [600])[
          Math.min(walletPage, (options.walletTotals ?? [600]).length - 1)
        ]
      : 10;
    const count = Math.max(0, Math.min(pageSize, total - skip));
    const items = Array.from({ length: count }, (_unused, i) => ({
      id: options.repeatId ? 'same' : `${isWallets ? 'w' : 'o'}${skip + i}`
    }));
    return Buffer.from(JSON.stringify({ total, items }));
  };
  return { get, requested };
}

describe('fetchSanctionsSource il-nbctf', () => {
  it('pages through wallets and orders until the total is reached', async () => {
    const { get, requested } = ilServer({});
    const fetched = await fetchSanctionsSource('il-nbctf', get);
    expect(fetched.files.map((file) => file.name)).toEqual([
      'wallets-0.json',
      'wallets-500.json',
      'orders-0.json'
    ]);
    expect(requested).toHaveLength(3);
  });

  it('fails when the total changes while paging', async () => {
    const { get } = ilServer({ walletTotals: [600, 590] });
    await expect(fetchSanctionsSource('il-nbctf', get)).rejects.toThrow(
      /total changed from 600 to 590/
    );
  });

  it('fails when an item repeats across pages', async () => {
    const { get } = ilServer({ repeatId: true });
    await expect(fetchSanctionsSource('il-nbctf', get)).rejects.toThrow(
      /missing or repeated id/
    );
  });

  it('fails when a page short of the total is empty', async () => {
    const get: HttpGet = async () =>
      Buffer.from(JSON.stringify({ total: 3, items: [] }));
    await expect(fetchSanctionsSource('il-nbctf', get)).rejects.toThrow(
      /is empty/
    );
  });

  it('refuses an unexpected page shape', async () => {
    const get: HttpGet = async () => Buffer.from('{"items":"nope"}');
    await expect(fetchSanctionsSource('il-nbctf', get)).rejects.toThrow(
      /unexpected page shape/
    );
  });
});

describe('assertAllowedSourceUrl', () => {
  it.each([
    ['https:', 'sanctionslistservice.ofac.treas.gov'],
    ['https:', 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
    ['https:', 'WWW.MOF.GO.JP']
  ])('allows %s//%s', (protocol, host) => {
    expect(() => assertAllowedSourceUrl(protocol, host)).not.toThrow();
  });

  it.each([
    ['http:', 'sanctionslist.fcdo.gov.uk'],
    ['https:', 'evil.example.com'],
    ['https:', 's3.us-gov-west-1.amazonaws.com.evil.example.com'],
    ['https:', 'webgate.ec.europa.eu.example.com']
  ])('refuses %s//%s', (protocol, host) => {
    expect(() => assertAllowedSourceUrl(protocol, host)).toThrow(/Refusing/);
  });
});

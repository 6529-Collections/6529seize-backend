import {
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

describe('fetchSanctionsSource il-nbctf', () => {
  it('pages through wallets and orders until the total is reached', async () => {
    const requested: string[] = [];
    const get: HttpGet = async (url) => {
      requested.push(url);
      const isWallets = url.indexOf('cryptocurrencyWallet') !== -1;
      const skip = Number(/skip=(\d+)/.exec(url)![1]);
      const total = isWallets ? 600 : 10;
      const remaining = Math.max(0, total - skip);
      const pageSize = isWallets ? 500 : 200;
      const items = new Array(Math.min(remaining, pageSize)).fill({});
      return Buffer.from(JSON.stringify({ total, items }));
    };
    const fetched = await fetchSanctionsSource('il-nbctf', get);
    expect(fetched.files.map((file) => file.name)).toEqual([
      'wallets-0.json',
      'wallets-500.json',
      'orders-0.json'
    ]);
    expect(requested).toHaveLength(3);
  });

  it('refuses an unexpected page shape', async () => {
    const get: HttpGet = async () => Buffer.from('{"items":"nope"}');
    await expect(fetchSanctionsSource('il-nbctf', get)).rejects.toThrow(
      /unexpected page shape/
    );
  });
});

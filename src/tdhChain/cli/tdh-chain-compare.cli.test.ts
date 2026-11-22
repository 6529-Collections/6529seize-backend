import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chainDayFixture,
  fixtureWallet,
  siteFixture,
  siteUploadsCsv
} from '@/tests/fixtures/tdh-chain-day.fixture';
import { formatTokenDayFile, formatWalletDayFile } from '../tdh-day-file';
import { tokenDayFileName, walletDayFileName } from '../tdh-chain-source';
import {
  CliUsageError,
  parseCompareArgs,
  runCompare
} from './tdh-chain-compare.cli';

async function fixtureDirs(
  siteEdit?: (s: ReturnType<typeof siteFixture>) => void
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdh-compare-'));
  const chainDir = path.join(root, 'chain');
  const siteDir = path.join(root, 'site');
  await fs.mkdir(chainDir);
  await fs.mkdir(siteDir);
  const day = chainDayFixture();
  await fs.writeFile(
    path.join(chainDir, walletDayFileName(20737)),
    formatWalletDayFile(day)
  );
  await fs.writeFile(
    path.join(chainDir, tokenDayFileName(20737)),
    formatTokenDayFile(day)
  );
  const site = siteFixture();
  siteEdit?.(site);
  const csv = siteUploadsCsv(site);
  await fs.writeFile(path.join(siteDir, 'wallets.csv'), csv.wallets);
  await fs.writeFile(path.join(siteDir, 'consolidated.csv'), csv.consolidated);
  return { root, chainDir, siteDir, out: path.join(root, 'out') };
}

describe('parseCompareArgs', () => {
  it('reads a day and its sources', () => {
    expect(
      parseCompareArgs([
        '--day',
        '2026-11-24',
        '--chain-gateway',
        'https://g.example',
        '--out',
        'o'
      ])
    ).toEqual({
      cycleDay: 20781,
      chainGateway: 'https://g.example',
      chainDir: null,
      siteApi: 'https://api.6529.io/api',
      siteDir: null,
      ethRpc: null,
      httpHosts: [],
      out: 'o'
    });
    expect(parseCompareArgs(['--help'])).toBe('help');
  });

  it('refuses incomplete or conflicting options', () => {
    const bad = [
      ['--chain-dir', 'c', '--out', 'o'],
      ['--day', '2026-11-24', '--out', 'o'],
      [
        '--day',
        '2026-11-24',
        '--chain-dir',
        'c',
        '--chain-gateway',
        'g',
        '--out',
        'o'
      ],
      ['--day', '2026-11-24', '--chain-dir', 'c'],
      ['--day', '24 Nov', '--chain-dir', 'c', '--out', 'o'],
      [
        '--day',
        '2026-11-24',
        '--chain-dir',
        'c',
        '--out',
        'o',
        '--site-dir',
        's',
        '--site-api',
        'a'
      ],
      ['--day', '2026-11-24', '--chain-dir', 'c', '--out', 'o', '--token', 'x']
    ];
    for (const argv of bad)
      expect(() => parseCompareArgs(argv)).toThrow(CliUsageError);
  });
});

describe('runCompare', () => {
  it('matches the fixture from files and writes the report', async () => {
    const d = await fixtureDirs();
    const run = await runCompare(
      parseCompareArgs([
        '--cycle-day',
        '20737',
        '--chain-dir',
        d.chainDir,
        '--site-dir',
        d.siteDir,
        '--out',
        d.out
      ]) as any
    );
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain('MATCH');
    const report = JSON.parse(
      await fs.readFile(path.join(d.out, 'report.json'), 'utf8')
    );
    expect(report.verdict).toBe('MATCH');
    expect(await fs.readFile(path.join(d.out, 'summary.txt'), 'utf8')).toBe(
      run.summary
    );
  });

  it('exits 3 when the chain side serves no token list', async () => {
    const d = await fixtureDirs();
    await fs.unlink(path.join(d.chainDir, tokenDayFileName(20737)));
    const run = await runCompare(
      parseCompareArgs([
        '--cycle-day',
        '20737',
        '--chain-dir',
        d.chainDir,
        '--site-dir',
        d.siteDir,
        '--out',
        d.out
      ]) as any
    );
    expect(run.exitCode).toBe(3);
    expect(run.summary).toContain('MATCH_WITHOUT_TOKENS');
    const report = JSON.parse(
      await fs.readFile(path.join(d.out, 'report.json'), 'utf8')
    );
    expect(report.toolCommit).toMatch(/^([0-9a-f]{40}|unknown)$/);
  });

  it('exits 1 on a difference and 2 when the chain has no such day', async () => {
    const d = await fixtureDirs((s) => {
      s.wallets[fixtureWallet('2')].boostedTdh = 251;
    });
    const args = parseCompareArgs([
      '--cycle-day',
      '20737',
      '--chain-dir',
      d.chainDir,
      '--site-dir',
      d.siteDir,
      '--out',
      d.out
    ]) as any;
    expect((await runCompare(args)).exitCode).toBe(1);
    expect((await runCompare({ ...args, cycleDay: 20738 })).exitCode).toBe(2);
  });

  it('reads the site through six public GETs and saves them', async () => {
    const d = await fixtureDirs();
    const csv = siteUploadsCsv();
    const api = 'https://api.example/api';
    const seen: string[] = [];
    const answers: Record<string, () => Response> = {
      [`${api}/uploads?date=20261011&page_size=5`]: () =>
        Response.json({
          data: [
            {
              date: '20261011',
              block: 26165481,
              url: 'https://arweave.net/wallets'
            }
          ]
        }),
      [`${api}/consolidated_uploads?date=20261011&page_size=5`]: () =>
        Response.json({
          data: [
            {
              date: '20261011',
              block: 26165481,
              url: 'https://arweave.net/consolidated'
            }
          ]
        }),
      'https://arweave.net/wallets': () => new Response(csv.wallets),
      'https://arweave.net/consolidated': () => new Response(csv.consolidated),
      [`${api}/tdh_global_history?page_size=1`]: () =>
        Response.json({
          data: [
            { date: '2026-10-11', block: 26165481, total_boosted_tdh: 1827 }
          ]
        }),
      [`${api}/blocks?page_size=3`]: () => Response.json({ data: [] })
    };
    const run = await runCompare(
      parseCompareArgs([
        '--cycle-day',
        '20737',
        '--chain-dir',
        d.chainDir,
        '--site-api',
        api,
        '--out',
        d.out
      ]) as any,
      async (url, init) => {
        seen.push(url);
        expect(init.headers).toEqual({
          'User-Agent': 'tdh-chain-compare/1',
          Accept: '*/*'
        });
        return answers[url]
          ? answers[url]()
          : new Response('', { status: 404 });
      }
    );
    expect(run.exitCode).toBe(0);
    expect(seen).toHaveLength(6);
    expect(run.report!.notes).toContain(
      'site global history for 20261011: total_boosted_tdh 1827, block 26165481'
    );
    expect(
      await fs.readFile(path.join(d.out, 'inputs', 'walletCsv'), 'utf8')
    ).toBe(csv.wallets);
  });
});

import * as path from 'node:path';
import { parseArgs } from '@/rebuild/cli';

describe('rebuild:check options', () => {
  it('has defaults for a full run', () => {
    expect(parseArgs([], '/repo')).toEqual({
      home: path.join('/repo', '.rebuild'),
      area: null,
      mark: 'head',
      final: false,
      mysqlPort: 3407,
      apiPort: 0,
      sources: {},
      chainHeight: null,
      ethBlock: null
    });
  });

  it('reads every option', () => {
    const parsed = parseArgs(
      [
        '--home',
        '/runs',
        '--area',
        'mint',
        '--mark',
        'switch',
        '--final',
        '--mysql-port',
        '3500',
        '--api-port',
        '3501',
        '--source',
        'gateway=http://127.0.0.1:7000',
        '--source',
        'files=/fixtures/files',
        '--source',
        'ethereum=anvil',
        '--source',
        'relays=relay',
        '--chain-height',
        '1840',
        '--eth-block',
        '512'
      ],
      '/repo'
    );
    expect(parsed).toMatchObject({
      home: path.resolve('/runs'),
      area: 'mint',
      mark: 'switch',
      final: true,
      mysqlPort: 3500,
      apiPort: 3501,
      sources: {
        gateway: { kind: 'live', url: 'http://127.0.0.1:7000' },
        files: { kind: 'files', dir: path.resolve('/fixtures/files') },
        ethereum: { kind: 'anvil', state: null },
        relays: { kind: 'relay', dir: null }
      },
      chainHeight: 1840,
      ethBlock: 512
    });
  });

  it('refuses unknown options and bad values', () => {
    expect(() => parseArgs(['--nope'], '/repo')).toThrow('Unknown option');
    expect(() => parseArgs(['--mark', 'later'], '/repo')).toThrow();
    expect(() => parseArgs(['--source', 'chain=x'], '/repo')).toThrow();
    expect(() => parseArgs(['--mysql-port', 'x'], '/repo')).toThrow();
    expect(() => parseArgs(['--area'], '/repo')).toThrow('needs a value');
  });
});

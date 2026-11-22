import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeJsonDocument } from './identity-export.writer';

describe('writeJsonDocument', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-export-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes what JSON.stringify would, one element a line', async () => {
    const document = {
      format: '6529.identity-export.v1',
      freeze_ms: null,
      identities: [
        {
          profile_id: 'a',
          wallets: ['0x1', '0x2'],
          website: 'https://e.org/"q"'
        },
        { profile_id: null, wallets: [] }
      ],
      ratings: [],
      stats: { identities: 2 },
      skipped: undefined
    };
    const file = path.join(dir, 'export.json');
    await writeJsonDocument(file, document);
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(document)));
    expect(
      text.split('\n').filter((it) => it.startsWith('    {'))
    ).toHaveLength(2);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  FREEZE_PLACEHOLDERS_SHA256,
  readPlaceholdersFile
} from '../placeholder-restore';
import { PlaceholderAtFreezeLine } from '../placeholders-at-freeze.format';
import {
  worldPlaceholdersFile,
  writePlaceholdersFixture
} from './fixture-file';
import {
  IDENTITY_WORLD_PLACEHOLDER_IDS,
  IDENTITY_WORLD_WALLETS
} from './world-ids';

describe("the world's placeholders file", () => {
  it('is what the steps read until the freeze writes its own', () => {
    expect(FREEZE_PLACEHOLDERS_SHA256).toBeNull();
  });

  it("holds the world's three placeholder profiles, built from its ids", async () => {
    const { bytes, sha256 } = worldPlaceholdersFile();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    const lines: PlaceholderAtFreezeLine[] = [];
    const header = await readPlaceholdersFile(bytes, sha256, async (batch) => {
      lines.push(...batch);
    });
    expect(header).toMatchObject({ count: 3 });
    expect(
      lines.map((it) => [it.profile_id, it.wallet, it.identity?.wallets])
    ).toEqual([
      [
        IDENTITY_WORLD_PLACEHOLDER_IDS.siteFounder,
        IDENTITY_WORLD_WALLETS.siteFounder,
        [IDENTITY_WORLD_WALLETS.siteFounder]
      ],
      [
        IDENTITY_WORLD_PLACEHOLDER_IDS.untaken,
        IDENTITY_WORLD_WALLETS.untaken,
        [IDENTITY_WORLD_WALLETS.untaken]
      ],
      [
        IDENTITY_WORLD_PLACEHOLDER_IDS.untakenTdh,
        IDENTITY_WORLD_WALLETS.untakenTdh,
        [IDENTITY_WORLD_WALLETS.untakenTdh]
      ]
    ]);
  });
});

describe('writePlaceholdersFixture', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-files-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('puts it into the seed files, beside what is listed', () => {
    fs.writeFileSync(
      path.join(dir, 'files.json'),
      JSON.stringify({ other: 'ab'.repeat(32) })
    );
    const { bytes, sha256 } = worldPlaceholdersFile();
    expect(writePlaceholdersFixture(dir)).toBe(sha256);
    expect(fs.readFileSync(path.join(dir, sha256)).equals(bytes)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'))
    ).toEqual({ other: 'ab'.repeat(32), [sha256]: sha256 });
  });
});

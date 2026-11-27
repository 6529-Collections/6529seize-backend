import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { NULL_ADDRESS } from '@/constants';
import { FILE_INDEX } from '@/rebuild/sources/file-server';
import {
  PLACEHOLDERS_FORMAT,
  PlaceholderAtFreezeLine,
  PlaceholdersAtFreezeHeader
} from '../placeholders-at-freeze.format';
import {
  IDENTITY_WORLD_PLACEHOLDER_IDS,
  IDENTITY_WORLD_WALLETS
} from './world-ids';

/** When the world's placeholder profiles were made, and the freeze. */
const CREATED_MS = 1_763_000_000_000;
const FREEZE_MS = 1_764_000_000_000;

/**
 * A placeholder profile as the site's code makes it for a wallet
 * (IdentitiesService.bulkCreateIdentities, no signed-in wallet), with the
 * identities row it fills in.
 */
function placeholderLine(
  profileId: string,
  wallet: string
): PlaceholderAtFreezeLine {
  const handle = `id-${wallet}`;
  return {
    profile_id: profileId,
    wallet,
    handle,
    normalised_handle: handle,
    created_at_ms: CREATED_MS,
    created_by_wallet: NULL_ADDRESS,
    updated_at_ms: null,
    updated_by_wallet: null,
    pfp_url: null,
    banner_1: null,
    banner_2: null,
    website: null,
    classification: 'PSEUDONYM',
    sub_classification: null,
    identity: {
      consolidation_key: wallet,
      primary_address: wallet,
      handle,
      normalised_handle: handle,
      pfp: null,
      banner1: null,
      banner2: null,
      classification: 'PSEUDONYM',
      sub_classification: null,
      rep: 0,
      cic: 0,
      wallets: [wallet]
    }
  };
}

export interface WorldPlaceholdersFile {
  readonly bytes: Buffer;
  readonly sha256: string;
}

let built: WorldPlaceholdersFile | undefined;

/**
 * The world's placeholders file, as the freeze would write it for the
 * world's three placeholder profiles (the site founder's, which the
 * founder rule takes, and two no chain identity takes), sorted by profile
 * id. Built from the world's ids, so the repository holds no address. The
 * seed and the rebuilder build it apart, on one machine, and get the same
 * bytes, so the same SHA-256.
 */
export function worldPlaceholdersFile(): WorldPlaceholdersFile {
  if (built) return built;
  const ids = IDENTITY_WORLD_PLACEHOLDER_IDS;
  const wallets = IDENTITY_WORLD_WALLETS;
  const lines = [
    placeholderLine(ids.siteFounder, wallets.siteFounder),
    placeholderLine(ids.untaken, wallets.untaken),
    placeholderLine(ids.untakenTdh, wallets.untakenTdh)
  ];
  const header: PlaceholdersAtFreezeHeader = {
    format: PLACEHOLDERS_FORMAT,
    freeze_ms: FREEZE_MS,
    tdh_block: 1,
    exporter_revision: 'rebuild-world fixture',
    count: lines.length
  };
  const ndjson = [header, ...lines]
    .map((it) => `${JSON.stringify(it)}\n`)
    .join('');
  const bytes = gzipSync(Buffer.from(ndjson, 'utf8'));
  built = {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  return built;
}

/**
 * Puts the world's placeholders file into the run's seed files, named by
 * its SHA-256 and listed in that directory's own index, so the run's files
 * source serves it whatever directory it was given: in production the
 * freeze writes the file, here the world's seed does. Returns its SHA-256.
 */
export function writePlaceholdersFixture(seedFilesDir: string): string {
  const { bytes, sha256 } = worldPlaceholdersFile();
  fs.mkdirSync(seedFilesDir, { recursive: true });
  fs.writeFileSync(path.join(seedFilesDir, sha256), bytes);
  const index = path.join(seedFilesDir, FILE_INDEX);
  const listed: Record<string, string> = fs.existsSync(index)
    ? JSON.parse(fs.readFileSync(index, 'utf8'))
    : {};
  fs.writeFileSync(
    index,
    `${JSON.stringify({ ...listed, [sha256]: sha256 }, null, 2)}\n`
  );
  return sha256;
}

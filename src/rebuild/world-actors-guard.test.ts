import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RebuildStep } from '@/rebuild/manifest.types';
import { AREA_MANIFESTS } from '@/rebuild/manifests';

// The world's actors are chain identities: a seed reads them by wallet, or
// takes a probe's fixed id from probeProfileId, which identity.actors-check
// backs (src/rebuild/run/probe-fixture.steps.ts), and never writes or
// hard-codes them. These names write their rows, give their fixed ids or make a
// principal without reading one, so only the modules that own them,
// manifests (a probe's literal path, a seed's step name) and tests may name
// them. A comment that names one counts too: say it another way.

const SRC = path.resolve(__dirname, '..');
const toPosix = (file: string) =>
  path.relative(SRC, file).split(path.sep).join('/');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    // A node_modules junction is a link, not a directory; a real one is
    // skipped by name.
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist'
        ? []
        : sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every .ts file under src, read once: its path from src, and its text. */
const SOURCES: ReadonlyMap<string, string> = new Map(
  sourceFiles(SRC).map((file) => [toPosix(file), fs.readFileSync(file, 'utf8')])
);

const OWNERS = new Set([
  'rebuild/manifests/probe-fixture.ts',
  'rebuild/run/probe-fixture.steps.ts',
  'tests/fixtures/world-actors.fixture.ts'
]);
const isTest = (file: string) => file.endsWith('.test.ts');
const isManifest = (file: string) => file.startsWith('rebuild/manifests/');

const RULES: {
  name: RegExp;
  allowed: (file: string) => boolean;
  /** A file of a seed that must be refused, for the misuse test. */
  example: string;
}[] = [
  {
    // The tests' stand-in for the identity world.
    name: /tests\/fixtures\/world-actors\.fixture/,
    allowed: isTest,
    example: `import { x } from '@/tests/fixtures/world-actors.fixture';`
  },
  {
    name: /\b(writeWorldActorRows|importedPrincipalId)\b/,
    allowed: isTest,
    example: 'await writeWorldActorRows(actors);'
  },
  {
    name: /\b(worldActorProfileId|worldActorIdentity)\b/,
    allowed: (file) => isTest(file) || isManifest(file),
    example: "const id = worldActorProfileId('records-service');"
  },
  {
    // The identity area's seed, and the identity mirror's rebuild step,
    // whose fallback it is; never deployed mirror code.
    name: /\bseedProbeIdentities\b/,
    allowed: (file) =>
      isTest(file) ||
      isManifest(file) ||
      file === 'identity-chain-mirror/identity-chain-mirror.rebuild.ts',
    example: 'await seedProbeIdentities();'
  }
];

describe("the world's actors' rows and ids", () => {
  it('are named only by their owners, manifests and tests', () => {
    const files = Array.from(SOURCES.keys());
    // The scan reached this tree.
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('rebuild/world-actors-guard.test.ts');
    const misused: string[] = [];
    for (const name of files) {
      if (OWNERS.has(name)) continue;
      const text = SOURCES.get(name)!;
      for (const rule of RULES) {
        if (rule.name.test(text) && !rule.allowed(name)) {
          misused.push(`${name}: ${rule.name.source}`);
        }
      }
    }
    expect(misused).toEqual([]);
  });

  it.each(RULES.map((rule) => [rule.name.source, rule]))(
    'refuses a seed that names %s',
    (_, rule) => {
      expect(rule.name.test(rule.example)).toBe(true);
      expect(rule.allowed('mint/mint.rebuild.steps.ts')).toBe(false);
      expect(
        rule.allowed('identity-chain-mirror/identity-chain-mirror.service.ts')
      ).toBe(false);
      expect(rule.allowed('mint/mint.rebuild.steps.test.ts')).toBe(true);
    }
  );

  it("lets the identity mirror's rebuild step, and only it, name the identity seed", () => {
    const [seedRule] = RULES.filter((rule) =>
      rule.name.test('seedProbeIdentities')
    );
    expect(
      seedRule.allowed('identity-chain-mirror/identity-chain-mirror.rebuild.ts')
    ).toBe(true);
    expect(
      seedRule.allowed('identity-chain-mirror/identity-chain-mirror.service.ts')
    ).toBe(false);
  });
});

// A raw write into profiles lives only in the files listed below. profiles
// is keyed by its normalised handle, not its id, so a seed's own row for a
// profile id the world already holds is a second profile under that id. The
// world's actors' rows are identity.probe-profiles', the records service's
// among them: the mint and publish seeds read it by its wallet and write no
// profile. The identity rebuilder restores the untaken placeholders'
// profiles from the freeze file. Any other raw write, anywhere under src,
// fails here until it is reviewed and listed. Counted: SQL that inserts or
// replaces into the table; a write helper (insert, upsert, write, put)
// handed the table in any argument; a row set tagged with the table
// (`table: PROFILES_TABLE`, or the table's name in quotes or backticks: the
// test fixtures' and the planted references' forms, which generic writers
// insert as given); and a call of withProfiles, which builds one. Out of
// this scan's reach: ORM writes (a Profile repository's insert or save), and
// aliases of the table made in another file, by let or by destructuring;
// there are none today.
const PROBE_PROFILES_SEED = 'identity.probe-profiles';

/** The files that may hold a raw profiles write, and how many each holds. */
const PROFILES_WRITERS: Record<string, number> = {
  // The profiles and identity mirror write paths.
  'profiles/profiles.db.ts': 2,
  'identity-chain-mirror/identity-chain-mirror.db.ts': 1,
  // identity.probe-profiles: the world's actors as plain rows, when the run
  // has no identity world (identity's seed calls seedProbeIdentities).
  'rebuild/run/probe-fixture.steps.ts': 1,
  // The identity rebuilder: the untaken placeholders' profiles, restored.
  'identity-chain-mirror/placeholder-restore.ts': 1,
  // The test fixtures' profiles row set, and its one caller outside a test.
  'tests/fixtures/profile.fixture.ts': 1,
  'tests/fixtures/identity-metrics-sync.fixture.ts': 1
};

/** The source tree's non-test files, as read once above. */
const NON_TEST_SOURCES = Array.from(SOURCES)
  .filter(([name]) => !isTest(name))
  .map(([name, text]) => ({ name, text }));

/** The table's constant, and the file's own aliases of it. */
function tableNames(text: string): string {
  const names = ['PROFILES_TABLE'];
  for (const alias of Array.from(
    text.matchAll(
      /\bconst\s+(\w+)\s*=\s*PROFILES_TABLE\b|\bPROFILES_TABLE\s+as\s+(\w+)/g
    )
  )) {
    names.push(alias[1] ?? alias[2]);
  }
  return `(?:${names.join('|')})\\b`;
}

/** A write helper's name and its open parenthesis; `put` only as a word part. */
const WRITE_HELPER =
  /\b(?:\w*(?:[Ii]nsert|[Uu]psert|[Ww]rite)\w*|[Pp]ut\w*|\w+Put\w*)\s*\(/g;
/** A withProfiles call, not its declaration. */
const WITH_PROFILES = /(?<!\bfunction\s+)\bwithProfiles\s*\(/g;

/** The index of the parenthesis that closes the one at `open`, or the end. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length - 1;
}

/**
 * Each raw profiles write in a text: an insert's SQL, a write helper's call
 * from its name, a row set's tag, or a withProfiles call.
 */
function profilesWrites(text: string): string[] {
  const table = tableNames(text);
  const sql = new RegExp(
    `\\b(?:insert|replace)\\s+(?:(?:low_priority|delayed|high_priority)\\s+)?(?:ignore\\s+)?into\\s+(?:\\$\\{${table}\\}|\`?profiles\\b)`,
    'gi'
  );
  // The table as an argument of its own, not inside a template's SQL.
  const argument = new RegExp(
    `(?<!\\$\\{\\s*)\\b${table}|['"\`]profiles['"\`]`
  );
  const writes = Array.from(text.matchAll(sql), (match) => match[0]);
  for (const match of Array.from(text.matchAll(WRITE_HELPER))) {
    const index = match.index ?? 0;
    const open = index + match[0].length - 1;
    const close = closeOf(text, open);
    if (argument.test(text.slice(open + 1, close))) {
      writes.push(text.slice(index, close + 1));
    }
  }
  for (const match of Array.from(
    text.matchAll(
      new RegExp(`\\btable:\\s*(?:${table}|['"\`]profiles['"\`])`, 'g')
    )
  )) {
    writes.push(match[0]);
  }
  for (const match of Array.from(text.matchAll(WITH_PROFILES))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    writes.push(text.slice(match.index ?? 0, closeOf(text, open) + 1));
  }
  return writes;
}

/** How many raw profiles writes each file holds, for files with any. */
function profilesWriteCounts(
  files: readonly { name: string; text: string }[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { name, text } of files) {
    const found = profilesWrites(text).length;
    if (found > 0) counts[name] = found;
  }
  return counts;
}

// The mint seed's old probe profile, which made a second row per probe.
const OLD_PROBE_PROFILE = [
  'async function insertProfile(profileId: string, wallet: string) {',
  '  await sqlExecutor.execute(',
  '    `insert ignore into ${PROFILES_TABLE}',
  '       (external_id, handle, normalised_handle, primary_wallet)',
  '     values (:profileId, :profileId, :profileId, :wallet)`,',
  '    { profileId, wallet }',
  '  );',
  '}'
].join('\n');

describe('raw writes into profiles', () => {
  it('are only where the list allows', () => {
    // The scan reached this tree.
    expect(NON_TEST_SOURCES.length).toBeGreaterThan(1000);
    expect(profilesWriteCounts(NON_TEST_SOURCES)).toEqual(PROFILES_WRITERS);
  });

  it('count a write moved out of a seed into any other file', () => {
    const moved = [
      ...NON_TEST_SOURCES,
      { name: 'mint-log/mint-log-rebuild.ids.ts', text: OLD_PROBE_PROFILE },
      { name: 'tests/fixtures/probe-profiles.ts', text: OLD_PROBE_PROFILE },
      {
        name: 'mint-log/mint-log-rebuild.seed-rows.ts',
        text: 'await seedRows([withProfiles([probe])]);'
      }
    ];
    expect(profilesWriteCounts(moved)).toEqual({
      ...PROFILES_WRITERS,
      'mint-log/mint-log-rebuild.ids.ts': 1,
      'tests/fixtures/probe-profiles.ts': 1,
      'mint-log/mint-log-rebuild.seed-rows.ts': 1
    });
  });

  it("let identity's probe-profiles step write the world's actors", () => {
    const step = AREA_MANIFESTS.flatMap((manifest) => manifest.seeds).find(
      (seed: RebuildStep) => seed.id === PROBE_PROFILES_SEED
    )!;
    // Identity's own seed: the mirror writes the actors' profiles from the
    // identity world, and without one it calls seedProbeIdentities, whose
    // raw write is the listed one.
    expect('module' in step.run && `${step.run.module}.ts`).toBe(
      'src/identity-chain-mirror/identity-chain-mirror.rebuild.ts'
    );
    expect(
      SOURCES.get('identity-chain-mirror/identity-chain-mirror.rebuild.ts')
    ).toMatch(/\bseedProbeIdentities\(\)/);
    const name = 'rebuild/run/probe-fixture.steps.ts';
    expect(PROFILES_WRITERS[name]).toBe(1);
  });

  it('find each raw insert form once', () => {
    const forms = [
      OLD_PROBE_PROFILE,
      "await insertIgnore(PROFILES_TABLE, { handle: 'someone', normalised_handle: 'someone' });",
      "const HANDLE = 'someone';\nawait insertIgnore(PROFILES_TABLE, { handle: HANDLE, normalised_handle: HANDLE });",
      'await db.execute(`insert into ${PROFILES_TABLE} (handle, normalised_handle) values (:handle, :handle)`, { handle });',
      'await db.execute(`replace into ${PROFILES_TABLE} (handle, normalised_handle) values (:handle, :handle)`, { handle });',
      "await db.execute('INSERT INTO profiles (external_id) VALUES (?)', [id]);",
      "await db.execute('INSERT LOW_PRIORITY INTO profiles (external_id) VALUES (?)', [id]);",
      'await db.execute(`insert delayed ignore into ${PROFILES_TABLE} (external_id) values (:id)`, { id });',
      // An alias of the table's constant, and write helpers.
      'const TABLE = PROFILES_TABLE;\nawait db.execute(`insert ignore into ${TABLE} (external_id) values (:id)`, { id });',
      'await upsertRow(PROFILES_TABLE, { external_id: id });',
      'await insertRows(connection, PROFILES_TABLE, [{ external_id: id }]);',
      'await bulkPut(connection, PROFILES_TABLE, rows);',
      // A SQL constant, then the call that runs it: one write.
      'const SQL = `insert ignore into ${PROFILES_TABLE} (handle, normalised_handle) values (:handle, :handle)`;\nawait db.execute(SQL, { handle });'
    ];
    for (const text of forms) {
      expect(profilesWrites(text)).toHaveLength(1);
    }
  });

  it('count row sets tagged with the table and withProfiles calls', () => {
    expect(
      profilesWrites('export const seed = { table: PROFILES_TABLE, rows };')
    ).toHaveLength(1);
    // The table by its name, as a list of row sets fed to a generic writer
    // holds it.
    expect(
      profilesWrites("const sets = [{ table: 'profiles', rows }];")
    ).toHaveLength(1);
    expect(
      profilesWrites('const sets = [{ table: "profiles", rows }];')
    ).toHaveLength(1);
    expect(
      profilesWrites('const sets = [{ table: `profiles`, rows }];')
    ).toHaveLength(1);
    expect(
      profilesWrites('await seedDatabase([withProfiles([profile])]);')
    ).toHaveLength(1);
    // Its declaration builds nothing.
    expect(
      profilesWrites(
        'export function withProfiles(entities: Profile[]): Seed {'
      )
    ).toEqual([]);
  });

  it('leave reads and names that only contain put alone', () => {
    for (const text of [
      'compute(PROFILES_TABLE);',
      'input(PROFILES_TABLE);',
      'output(PROFILES_TABLE);',
      'await writeLog(`select handle from ${PROFILES_TABLE}`);',
      'await db.execute(`select * from ${PROFILES_TABLE} where external_id = :id`, { id });'
    ]) {
      expect(profilesWrites(text)).toEqual([]);
    }
    expect(profilesWrites('await putRows(PROFILES_TABLE, rows);')).toHaveLength(
      1
    );
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';

// The world's actors are chain identities: a seed reads them by wallet
// (src/rebuild/run/probe-fixture.steps.ts) and never writes or hard-codes
// them. These names write their rows, give their fixed ids or make a
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
    const files = sourceFiles(SRC).map(toPosix);
    // The scan reached this tree.
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('rebuild/world-actors-guard.test.ts');
    const misused: string[] = [];
    for (const name of files) {
      if (OWNERS.has(name)) continue;
      const text = fs.readFileSync(path.join(SRC, name), 'utf8');
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

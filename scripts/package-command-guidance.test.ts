import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (file: string): string =>
  readFileSync(path.join(repoRoot, file), 'utf8');

const activeGuidanceFiles = [
  'AGENTS.md',
  'README.md',
  'docs/_manager/profile-cms-gallery-generator/README.md',
  'docs/alchemy-sdk-removal.md',
  'docs/decentralized-media-resolver-review-and-rollout.md',
  'docs/og-metadata-endpoints.md',
  'docs/staging-db-local-sync.md',
  'prompts/development.md',
  'specs/1383-curations-iteration1.md',
  '.agents/skills/api-skill/SKILL.md',
  '.agents/skills/community-metrics/SKILL.md',
  '.agents/skills/database-skill/SKILL.md',
  '.agents/skills/identity-notifications/SKILL.md',
  '.agents/skills/staging-db-local-sync/SKILL.md',
  '.agents/skills/write-prs/SKILL.md',
  'ops/skills/api-skill/SKILL.md',
  'ops/skills/community-metrics/SKILL.md',
  'ops/skills/database-skill/SKILL.md',
  'ops/skills/identity-notifications/SKILL.md',
  'ops/skills/staging-db-local-sync/SKILL.md',
  'ops/skills/write-prs/SKILL.md',
  'ops/settings.local.json'
];

const automationFiles = [
  '.github/workflows/deploy.yml',
  '.github/workflows/on-pull-request.yml',
  'scripts/check-changed.mjs',
  'scripts/generate-deploy-config.mjs'
];

describe('6529 package command guidance', () => {
  it.each(activeGuidanceFiles)(
    'keeps %s free of obsolete direct package commands',
    (file) => {
      const content = read(file);

      expect(content).not.toMatch(
        /`(?:corepack npm|npm (?:ci|i|install|run|test|audit|exec|uninstall|update)|npx\b)/
      );
      expect(content).not.toMatch(
        /^\s*(?:corepack npm|npm (?:ci|i|install|run|test|audit|exec|uninstall|update)|npx\b)/m
      );
      expect(content).not.toMatch(/Bash\((?:corepack|npm|npx)\b/);
    }
  );

  it.each(automationFiles)(
    'routes package commands in %s through 6529',
    (file) => {
      const content = read(file);

      expect(content).not.toMatch(
        /^\s*(?:run:\s*)?(?:corepack(?:\s|$)|npm (?:ci|i|install|run|test|audit|exec|uninstall|update)|npx\b)/m
      );
    }
  );

  it('documents root and API wrapper examples centrally', () => {
    const guidance = read('docs/package-commands.md');

    expect(guidance).toContain('6529 run backend:local');
    expect(guidance).toContain('cd src/api-serverless');
    expect(guidance).toContain('6529 run generate:openapi');
    expect(guidance).toContain('./bin/6529 bootstrap');
    expect(read('.envrc')).toContain('PATH_add bin');
  });
});

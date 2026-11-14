import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Deploy configuration and runtime code must stay account-neutral so the same
 * commit deploys to any AWS account (staging and production live in
 * different accounts). Derive the account instead: `${aws:accountId}` in
 * Serverless files, `${AWS::AccountId}` in CloudFormation, `aws sts
 * get-caller-identity` in workflows, and environment or SDK lookups at
 * runtime. Tests and fixtures may use literal IDs.
 */
const repoRoot = path.resolve(__dirname, '..');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Twelve digits that are not part of a longer word, number or decimal.
const ACCOUNT_ID = /(?<![\w.])\d{12}(?!\w)/g;

function findAccountIds(text: string): string[] {
  return text.replace(UUID, '').match(ACCOUNT_ID) ?? [];
}

function isGuarded(file: string): boolean {
  if (file === '.github/workflows/deploy.yml') return true;
  if (file === 'scripts/generate-deploy-config.mjs') return true;
  if (file.startsWith('serverless-config/')) return true;
  if (!file.startsWith('src/')) return false;
  if (/\/serverless\.ya?ml$/.test(file)) return true;
  return file.endsWith('.ts') && !isTestOrFixture(file);
}

function isTestOrFixture(file: string): boolean {
  return (
    /\.(test|spec)\.ts$/.test(file) ||
    file.endsWith('.fixture.ts') ||
    file.startsWith('src/tests/') ||
    file.includes('/fixtures/') ||
    file.includes('/__mocks__/')
  );
}

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

describe('AWS account ID guard', () => {
  it.each([
    ['role: arn:aws:iam::123456789012:role/lambda-vpc-role', ['123456789012']],
    ['https://sqs.eu-west-1.amazonaws.com/123456789012/q', ['123456789012']],
    ['bucket-123456789012-us-east-1', ['123456789012']],
    ["'123456789012'", ['123456789012']],
    ['role: arn:aws:iam::${aws:accountId}:role/lambda-vpc-role', []],
    ["context_id: '00000000-0000-0000-0000-000000000000'", []],
    ["'0x000000000000ad05ccc4f10045630fb830b95127'", []],
    ['1234.567890123457', []],
    ['1234567890123', []]
  ])('finds account IDs in %j', (text, expected) => {
    expect(findAccountIds(text)).toEqual(expected);
  });

  it('keeps deploy configuration and runtime code free of account IDs', () => {
    const files = trackedFiles().filter(isGuarded);
    expect(files).toContain('serverless-config/staging/vpc.js');
    expect(files).toContain('src/tdhLoop/serverless.yaml');

    const offenders = files.flatMap((file) =>
      findAccountIds(readFileSync(path.join(repoRoot, file), 'utf8')).map(
        (id) => `${file}: ${id}`
      )
    );
    expect(offenders).toEqual([]);
  });
});

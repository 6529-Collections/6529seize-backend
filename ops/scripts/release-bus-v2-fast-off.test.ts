import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, 'release-bus-v2-fast-off.mjs');
const TOKEN = 'rollback-test-token-that-must-never-be-printed';

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempRoot: string;
let mockBin: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'release-bus-v2-fast-off-'));
  mockBin = path.join(tempRoot, 'bin');
  await mkdir(mockBin);
  const ghPath = path.join(mockBin, 'gh');
  await writeFile(
    ghPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
      '  printf "%s\\n" "$MOCK_GH_TOKEN"',
      '  exit 0',
      'fi',
      'if [ "$1" = "variable" ]; then exit 0; fi',
      'exit 2',
      ''
    ].join('\n'),
    'utf8'
  );
  await chmod(ghPath, 0o700);

  const awsPath = path.join(mockBin, 'aws');
  await writeFile(
    awsPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "sts" ]; then',
      '  printf \'{"Account":"%s","Arn":"arn:aws:iam::%s:user/test-operator"}\\n\' "$MOCK_AWS_ACCOUNT" "$MOCK_AWS_ACCOUNT"',
      '  exit 0',
      'fi',
      'if [ "$1" = "events" ] && [ "$2" = "list-rules" ]; then',
      '  if [ "${MOCK_RULE_COUNT:-1}" = "0" ]; then printf \'[]\\n\'; exit 0; fi',
      '  printf \'["releaseBus-prod-V2ReconcilerEventsRuleSchedule1-test"]\\n\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "events" ] && [ "$2" = "disable-rule" ]; then exit 0; fi',
      'if [ "$1" = "events" ] && [ "$2" = "describe-rule" ]; then printf \'DISABLED\\n\'; exit 0; fi',
      'if [ "$1" = "lambda" ] && [ "$2" = "get-function-configuration" ]; then',
      '  printf \'{"RevisionId":"revision-1","LastUpdateStatus":"Successful","Environment":{"Variables":{"KEEP":"value","RELEASE_BUS_V2_MODE":"OFF","RELEASE_BUS_V2_BETA_ALLOWLIST":""}}}\\n\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "lambda" ] && [ "$2" = "update-function-configuration" ]; then',
      '  keep=0',
      '  mode=0',
      '  worker=0',
      '  for argument in "$@"; do',
      '    case "$argument" in',
      '      *\'"KEEP":"value"\'*) keep=1 ;;',
      '    esac',
      '    case "$argument" in',
      '      *\'"RELEASE_BUS_V2_MODE":"OFF"\'*) mode=1 ;;',
      '    esac',
      '    case "$argument" in',
      '      releaseBusV2Reconciler) worker=1 ;;',
      '    esac',
      '  done',
      '  if [ "$worker" = "1" ] && [ "${MOCK_FAIL_WORKER_UPDATE:-0}" = "1" ]; then exit 4; fi',
      '  if [ "$keep" = "1" ] && [ "$mode" = "1" ]; then exit 0; fi',
      '  exit 3',
      'fi',
      'if [ "$1" = "lambda" ] && [ "$2" = "wait" ]; then exit 0; fi',
      'exit 2',
      ''
    ].join('\n'),
    'utf8'
  );
  await chmod(awsPath, 0o700);
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function runScript(
  apiUrl: string,
  args = ['--execute'],
  account = '987989283142',
  overrides: NodeJS.ProcessEnv = {}
): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        env: {
          ...process.env,
          PATH: mockBin,
          MOCK_GH_TOKEN: TOKEN,
          MOCK_AWS_ACCOUNT: account,
          RELEASE_BUS_API_URL: apiUrl,
          ...overrides
        },
        maxBuffer: 1024 * 1024,
        timeout: 10_000
      },
      (error, stdout, stderr) => {
        try {
          expect(`${stdout}${stderr}`).not.toContain(TOKEN);
          resolve({
            code:
              error === null
                ? 0
                : typeof error.code === 'number'
                  ? error.code
                  : 1,
            stdout,
            stderr
          });
        } catch (assertionError) {
          reject(assertionError);
        }
      }
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('release-bus-v2 fast OFF rollback', () => {
  it('preserves environment values and verifies empty OFF', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? ''
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify(
          request.method === 'GET'
            ? { mode: 'OFF', controls: [] }
            : { mode: 'STAGING' }
        )
      );
    });
    const url = await listen(server);
    try {
      const result = await runScript(url);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('V2 ALL pause accepted');
      expect(result.stderr).toContain('Verified seizeAPI empty OFF');
      expect(result.stderr).toContain(
        'Verified releaseBusV2Reconciler empty OFF'
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'OFF',
        beta_allowlist: 'empty',
        schedule: 'DISABLED',
        controls_pause_requested: true,
        functions: ['seizeAPI', 'releaseBusV2Reconciler'],
        aws_account: '987989283142',
        aws_region: 'us-east-1',
        actor_arn: 'arn:aws:iam::987989283142:user/test-operator'
      });
      expect(JSON.parse(result.stdout).started_at).toMatch(/Z$/);
      expect(JSON.parse(result.stdout).completed_at).toMatch(/Z$/);
      expect(requests).toEqual([
        { method: 'POST', url: '/deploy/release-bus-v2/pause' },
        { method: 'GET', url: '/deploy/release-bus-v2/controls' }
      ]);
    } finally {
      await close(server);
    }
  });

  it('refuses to mutate a different AWS account', async () => {
    const result = await runScript(
      'http://127.0.0.1:1',
      ['--execute'],
      '111111111111'
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Expected AWS account 987989283142');
  });

  it('requires the explicit execute flag', async () => {
    const result = await runScript('http://127.0.0.1:1', []);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Usage:');
  });

  it('fails closed when the reconciler schedule cannot be identified', async () => {
    const result = await runScript(
      'http://127.0.0.1:1',
      ['--execute'],
      '987989283142',
      { MOCK_RULE_COUNT: '0' }
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'Expected exactly one v2 reconciler schedule; found 0'
    );
  });

  it('reports a bounded partial failure for safe command rerun', async () => {
    const result = await runScript(
      'http://127.0.0.1:1',
      ['--execute'],
      '987989283142',
      { MOCK_FAIL_WORKER_UPDATE: '1' }
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Verified seizeAPI empty OFF');
    expect(result.stderr).toContain(
      'releaseBusV2Reconciler OFF update failed after 3 revision-safe attempts'
    );
  });
});

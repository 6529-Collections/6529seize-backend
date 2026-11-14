import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

type WorkflowStep = { name: string; run?: string };

const workflow = parse(
  readFileSync(
    path.resolve(__dirname, '../.github/workflows/deploy.yml'),
    'utf8'
  )
);
const steps: WorkflowStep[] = workflow.jobs['build-and-deploy'].steps;
const deployApi = steps.find((step) => step.name === 'Deploy API')!;

const valueNotForLogs = 'value-not-for-logs';
const currentEnvironment = {
  GIT_COMMIT: 'previous',
  CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL: 'https://sqs.example/queue',
  ATTACHMENTS_INGEST_S3_BUCKET: 'previous-bucket',
  API_GATEWAY_WS_ENDPOINT: 'https://ws.example',
  UNMANAGED_SETTING: valueNotForLogs,
  MEMBERSHIP_READ_MODE: 'retired'
};

const fakeCommands = `
git() { printf 'fixture'; }
sleep() { :; }
aws() {
  printf '%s\\n' "$*" >> "$MOCK_CALLS"
  case "$2" in
    get-function-configuration)
      read_count=$(( $(cat "$MOCK_READ_COUNT" 2>/dev/null || printf 0) + 1 ))
      printf '%s' "$read_count" > "$MOCK_READ_COUNT"
      if [ "$read_count" = "$MOCK_FAILING_READ" ]; then
        printf 'read failure %s\\n' "$UNMANAGED_VALUE" >&2
        return 254
      fi
      if [ "$read_count" = 2 ] && [ -n "$MOCK_SECOND_ENVIRONMENT" ]; then
        printf '%s' "$MOCK_SECOND_ENVIRONMENT"
      else
        printf '%s' "$MOCK_ENVIRONMENT"
      fi
      ;;
    update-function-configuration)
      previous=''
      for argument in "$@"; do
        if [ "$previous" = --environment ]; then cp "\${argument#file://}" "$MOCK_CAPTURE"; fi
        previous="$argument"
      done
      printf '{"Environment":{"Variables":{"UNMANAGED_SETTING":"%s"}}}' "$UNMANAGED_VALUE"
      ;;
  esac
}
`;

/**
 * The current environment document the fake `aws` returns. An explicit
 * `environment: undefined` has no JSON form, and an unset variable would make
 * the fake read fail for an unrelated reason, so it is refused here.
 */
function currentEnvironmentDocument(overrides: {
  environment?: unknown;
  rawEnvironment?: string;
}): string {
  if (overrides.rawEnvironment !== undefined) {
    return overrides.rawEnvironment;
  }
  if (!('environment' in overrides)) {
    return JSON.stringify(currentEnvironment);
  }
  const document = JSON.stringify(overrides.environment);
  if (document === undefined) {
    throw new Error(
      'environment override has no JSON form; use rawEnvironment instead'
    );
  }
  return document;
}

/**
 * Only what the step and its shell utilities need; nothing from the test
 * runner's own environment (credentials, AWS profile, CI settings) leaks in.
 */
function minimalProcessEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot']) {
    const value = process.env[key];
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return inherited;
}

function runDeployApi(
  overrides: {
    environment?: unknown;
    rawEnvironment?: string;
    failingRead?: number;
    inputEnvironment?: string;
    secondReadEnvironment?: unknown;
  } = {}
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'deploy-api-env-'));
  const posixDirectory = directory.split(path.sep).join('/');
  const runnerTemp = path.join(directory, 'runner-temp');
  const capture = path.join(directory, 'env_config.json');
  const calls = path.join(directory, 'calls.txt');
  const mockEnvironment = currentEnvironmentDocument(overrides);
  try {
    spawnSync('bash', ['-c', `mkdir -p "${posixDirectory}/runner-temp"`]);
    const result = spawnSync(
      'bash',
      ['-c', `${fakeCommands}\n${deployApi.run}`],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...minimalProcessEnvironment(),
          HOME: posixDirectory,
          RUNNER_TEMP: `${posixDirectory}/runner-temp`,
          MOCK_CALLS: `${posixDirectory}/calls.txt`,
          MOCK_READ_COUNT: `${posixDirectory}/read-count.txt`,
          MOCK_CAPTURE: `${posixDirectory}/env_config.json`,
          MOCK_FAILING_READ: String(overrides.failingRead ?? 0),
          MOCK_ENVIRONMENT: mockEnvironment,
          MOCK_SECOND_ENVIRONMENT:
            'secondReadEnvironment' in overrides
              ? JSON.stringify(overrides.secondReadEnvironment)
              : '',
          UNMANAGED_VALUE: valueNotForLogs,
          INPUT_ENVIRONMENT: overrides.inputEnvironment ?? 'prod',
          ATTACHMENTS_INGEST_S3_BUCKET: 'attachments-bucket',
          DROP_MEDIA_SANITIZE_IMAGES: 'false',
          DROP_MEDIA_INGEST_S3_BUCKET: 'ingest-bucket',
          DROP_MEDIA_INGEST_S3_REGION: 'eu-west-1',
          DROP_MEDIA_INGEST_STAGE: 'prod',
          DROP_MEDIA_SANITIZER_SQS_QUEUE_NAME: 'drop-media-sanitizer',
          API_GATEWAY_WS_ENDPOINT: 'https://ws.6529.io',
          ARTWORK_DOCUMENTATION_ENABLED_VALUE: '',
          ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED_VALUE: ''
        }
      }
    );
    return {
      ...result,
      calls: existsSync(calls)
        ? readFileSync(calls, 'utf8').trimEnd().split('\n')
        : [],
      written: existsSync(capture)
        ? JSON.parse(readFileSync(capture, 'utf8'))
        : null,
      leftovers: readdirSync(runnerTemp)
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function subcommands(calls: string[]) {
  return calls.map((call) => call.split(' ')[1]);
}

describe('API environment deployment', () => {
  it('merges deploy-managed keys into the complete current environment', () => {
    const result = runDeployApi();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(subcommands(result.calls)).toEqual([
      'get-function-configuration',
      'update-function-code',
      'get-function-configuration',
      'update-function-configuration'
    ]);
    expect(result.written.Variables).toEqual({
      DROP_FORGE_STAGE: 'prod',
      GIT_COMMIT: 'fixture',
      CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL:
        'https://sqs.us-east-1.amazonaws.com/987989283142/claims-media-arweave-upload',
      ATTACHMENTS_INGEST_S3_BUCKET: 'attachments-bucket',
      API_GATEWAY_WS_ENDPOINT: 'https://ws.6529.io',
      UNMANAGED_SETTING: valueNotForLogs,
      DROP_MEDIA_SANITIZE_IMAGES: 'false',
      DROP_MEDIA_INGEST_S3_BUCKET: 'ingest-bucket',
      DROP_MEDIA_INGEST_S3_REGION: 'eu-west-1',
      DROP_MEDIA_INGEST_STAGE: 'prod',
      DROP_MEDIA_SANITIZER_SQS_QUEUE_NAME: 'drop-media-sanitizer',
      ARTWORK_DOCUMENTATION_ENABLED: 'false',
      ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED: 'false',
      ARTWORK_DOCUMENTATION_S3_REGION: 'us-east-1',
      ARTWORK_DOCUMENTATION_S3_BUCKET:
        '6529-artwork-documentation-987989283142-us-east-1'
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(valueNotForLogs);
    expect(result.leftovers).toEqual([]);
  });

  it('uses the staging region outside production', () => {
    const result = runDeployApi({ inputEnvironment: 'staging' });
    expect(result.status).toBe(0);
    expect(result.written.Variables.DROP_FORGE_STAGE).toBe('staging');
    expect(result.written.Variables.ARTWORK_DOCUMENTATION_S3_REGION).toBe(
      'eu-west-1'
    );
    expect(result.written.Variables.CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL).toBe(
      'https://sqs.eu-west-1.amazonaws.com/987989283142/claims-media-arweave-upload'
    );
  });

  it('fails before changing code when the configuration read fails', () => {
    const result = runDeployApi({ failingRead: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Could not read the current seizeAPI environment'
    );
    expect(subcommands(result.calls)).toEqual(['get-function-configuration']);
    expect(`${result.stdout}${result.stderr}`).not.toContain(valueNotForLogs);
    expect(result.leftovers).toEqual([]);
  });

  it('never replaces the environment when the post-update read fails', () => {
    const result = runDeployApi({ failingRead: 2 });
    expect(result.status).toBe(1);
    expect(subcommands(result.calls)).toEqual([
      'get-function-configuration',
      'update-function-code',
      'get-function-configuration'
    ]);
    expect(result.written).toBeNull();
    expect(result.leftovers).toEqual([]);
  });

  it.each([
    [{}, 'GIT_COMMIT,CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL'],
    [null, 'GIT_COMMIT,CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL'],
    [[], 'GIT_COMMIT,CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL'],
    [
      { ...currentEnvironment, API_GATEWAY_WS_ENDPOINT: undefined },
      'missing required keys (API_GATEWAY_WS_ENDPOINT)'
    ]
  ])(
    'rejects an empty or incomplete environment %j by key name only',
    (environment, message) => {
      const result = runDeployApi({ environment });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(subcommands(result.calls)).toEqual(['get-function-configuration']);
      expect(`${result.stdout}${result.stderr}`).not.toContain(valueNotForLogs);
    }
  );

  it.each([{}, null])(
    'never replaces the environment when the post-update read returns %j',
    (secondReadEnvironment) => {
      const result = runDeployApi({ secondReadEnvironment });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'missing required keys (GIT_COMMIT,CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL'
      );
      expect(subcommands(result.calls)).toEqual([
        'get-function-configuration',
        'update-function-code',
        'get-function-configuration'
      ]);
      expect(result.written).toBeNull();
      expect(result.leftovers).toEqual([]);
    }
  );

  it.each(['', '\n  \n'])(
    'rejects an empty configuration read %j before changing code',
    (rawEnvironment) => {
      const result = runDeployApi({ rawEnvironment });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'The current seizeAPI environment read back empty'
      );
      expect(subcommands(result.calls)).toEqual(['get-function-configuration']);
      expect(result.written).toBeNull();
      expect(result.leftovers).toEqual([]);
    }
  );

  it('refuses an environment override without a JSON form', () => {
    expect(() => runDeployApi({ environment: undefined })).toThrow(
      'environment override has no JSON form'
    );
  });

  it('rejects an unreadable configuration document', () => {
    const result = runDeployApi({
      rawEnvironment: `{"A": "${valueNotForLogs}"`
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not valid JSON');
    expect(`${result.stdout}${result.stderr}`).not.toContain(valueNotForLogs);
    expect(result.leftovers).toEqual([]);
  });
});

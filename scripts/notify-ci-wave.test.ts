import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

type RunResult = {
  readonly code: number | null;
  readonly stderr: string;
  readonly payload: Record<string, unknown> | null;
};

async function runNotifier(
  overrides: Record<string, string> = {}
): Promise<RunResult> {
  let payload: Record<string, unknown> | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), 'scripts/notify-ci-wave.mjs')],
    {
      env: {
        ...process.env,
        CI_PIPELINES_ALERT_URL: `http://127.0.0.1:${address.port}`,
        CI_PIPELINES_ALERT_SECRET: 'test-secret',
        CI_PIPELINES_TARGET_ENV: 'prod',
        CI_PIPELINES_STATUS: 'success',
        CI_PIPELINES_TITLE: 'Deploy complete',
        CI_PIPELINES_SERVICE: 'api',
        CI_RELEASE_NOTES_PROMPT_PATH:
          'ops/release-notes/release-notes.prompt.md',
        GITHUB_REPOSITORY: '6529-Collections/6529seize-backend',
        GITHUB_WORKFLOW: 'Deploy a service',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_NUMBER: '45',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_REF_NAME: 'main',
        ...overrides
      }
    }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve) =>
    child.on('exit', resolve)
  );
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return { code, stderr, payload };
}

describe('notify-ci-wave release-note metadata', () => {
  it('sends canonical release train contributors and the deployed SHA', async () => {
    const expectedSha = 'b'.repeat(40);
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'train-123',
      CI_RELEASE_CONTRIBUTORS: JSON.stringify([
        'GelatoGenesis',
        'prxt6529',
        'gelatogenesis'
      ]),
      CI_PIPELINES_SHA: expectedSha
    });

    expect(result).toMatchObject({
      code: 0,
      stderr: '',
      payload: {
        release_train_id: 'train-123',
        contributor_github_logins: ['GelatoGenesis', 'prxt6529'],
        sha: expectedSha
      }
    });
  });

  it('rejects release contributors without a train id', async () => {
    const result = await runNotifier({
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['GelatoGenesis'])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_TRAIN_ID is required with CI_RELEASE_CONTRIBUTORS'
    );
    expect(result.payload).toBeNull();
  });

  it('keeps new fields atomic until the updated dispatcher supplies contributors', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'train-123',
      CI_RELEASE_CONTRIBUTORS: '[]'
    });

    expect(result.code).toBe(0);
    expect(result.payload).not.toHaveProperty('release_train_id');
    expect(result.payload).not.toHaveProperty('contributor_github_logins');
  });

  it('rejects invalid release contributor metadata', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'train-123',
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['not a login'])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_CONTRIBUTORS contains an invalid GitHub login'
    );
    expect(result.payload).toBeNull();
  });

  it.each(['trailing-', 'double--hyphen'])(
    'rejects impossible GitHub login %s',
    async (login) => {
      const result = await runNotifier({
        CI_RELEASE_TRAIN_ID: 'train-123',
        CI_RELEASE_CONTRIBUTORS: JSON.stringify([login])
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'CI_RELEASE_CONTRIBUTORS contains an invalid GitHub login'
      );
    }
  );

  it('sends canonical per-PR v2 release-note groups', async () => {
    const result = await runNotifier({
      CI_RELEASE_NOTE_GROUPS: JSON.stringify([
        {
          release_group_id: 'pr-1801',
          release_group_services: ['worker', 'api', 'api'],
          pull_request_number: 1801,
          publish_release_note: true
        }
      ])
    });

    expect(result).toMatchObject({
      code: 0,
      stderr: '',
      payload: {
        release_note_groups: [
          {
            release_group_id: 'pr-1801',
            release_group_services: ['api', 'worker'],
            pull_request_number: 1801,
            publish_release_note: true
          }
        ]
      }
    });
    expect(result.payload).not.toHaveProperty('release_group_id');
    expect(result.payload).not.toHaveProperty('release_group_services');
    expect(result.payload).not.toHaveProperty('pull_request_number');
    expect(result.payload).not.toHaveProperty('publish_release_note');
  });

  it('sends overlapping structured groups for the deployed service', async () => {
    const result = await runNotifier({
      CI_RELEASE_PULL_REQUEST: '9999',
      CI_RELEASE_GROUP_SERVICES: 'wrongLegacyService',
      CI_RELEASE_NOTE_PUBLISH: 'false',
      CI_RELEASE_NOTE_GROUPS: JSON.stringify([
        {
          release_group_id: 'pr-1801',
          release_group_services: ['worker', 'api'],
          pull_request_number: 1801,
          publish_release_note: true
        },
        {
          release_group_id: 'pr-1802',
          release_group_services: ['api'],
          pull_request_number: 1802,
          publish_release_note: true
        }
      ])
    });

    expect(result.code).toBe(0);
    expect(result.payload?.release_note_groups).toHaveLength(2);
    expect(result.payload).not.toHaveProperty('release_group_id');
    expect(result.payload).not.toHaveProperty('pull_request_number');
  });

  it('rejects structured groups without a deployed service', async () => {
    const result = await runNotifier({
      CI_PIPELINES_SERVICE: '',
      CI_RELEASE_NOTE_GROUPS: JSON.stringify([
        {
          release_group_id: 'pr-1801',
          release_group_services: ['api'],
          pull_request_number: 1801,
          publish_release_note: true
        }
      ])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_NOTE_GROUPS contains an invalid group'
    );
  });

  it('rejects duplicate structured group ids', async () => {
    const result = await runNotifier({
      CI_RELEASE_NOTE_GROUPS: JSON.stringify([
        {
          release_group_id: 'same-group',
          release_group_services: ['api'],
          pull_request_number: 1801,
          publish_release_note: true
        },
        {
          release_group_id: 'same-group',
          release_group_services: ['api'],
          pull_request_number: 1802,
          publish_release_note: true
        }
      ])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_NOTE_GROUPS contains duplicate groups'
    );
  });

  it('never sends release-note fields for staging', async () => {
    const result = await runNotifier({
      CI_PIPELINES_TARGET_ENV: 'staging',
      CI_RELEASE_PULL_REQUEST: '1801',
      CI_RELEASE_GROUP_SERVICES: 'api',
      CI_RELEASE_NOTE_PUBLISH: 'true'
    });

    expect(result.code).toBe(0);
    expect(result.payload).not.toHaveProperty('release_notes_prompt_path');
    expect(result.payload).not.toHaveProperty('release_note_groups');
    expect(result.payload).not.toHaveProperty('publish_release_note');
  });

  it('rejects an opt-out that also requests publication', async () => {
    const result = await runNotifier({
      CI_RELEASE_NOTE_OPT_OUT: 'true',
      CI_RELEASE_NOTE_PUBLISH: 'true'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Release-note opt-out cannot include release-note groups or a publish request'
    );
    expect(result.payload).toBeNull();
  });
});

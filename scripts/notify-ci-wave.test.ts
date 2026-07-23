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

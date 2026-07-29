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
        CI_RELEASE_NOTE_OPT_OUT: 'true',
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

async function runManualEvidenceNotifier({
  pull,
  files = [{ filename: 'src/api-serverless/src/example.ts' }],
  commits = [
    {
      author: { login: 'Commit-Author', type: 'User' },
      committer: { login: 'Commit-Committer', type: 'User' }
    }
  ],
  comparison = { status: 'ahead' }
}: {
  readonly pull: Record<string, unknown>;
  readonly files?: readonly Record<string, unknown>[];
  readonly commits?: readonly Record<string, unknown>[];
  readonly comparison?: Record<string, unknown>;
}): Promise<RunResult> {
  const githubServer = createServer((request, response) => {
    const pathName = request.url ?? '';
    let body: unknown;
    if (pathName.endsWith('/pulls/42')) {
      body = pull;
    } else if (pathName.includes('/compare/')) {
      body = comparison;
    } else if (pathName.includes('/pulls/42/files')) {
      body = files;
    } else if (pathName.includes('/pulls/42/commits')) {
      body = commits;
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) =>
    githubServer.listen(0, '127.0.0.1', resolve)
  );
  const address = githubServer.address();
  if (!address || typeof address === 'string') throw new Error('missing port');

  try {
    return await runNotifier({
      CI_RELEASE_PULL_REQUEST: '42',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
      GITHUB_TOKEN: 'test-token',
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      githubServer.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('notify-ci-wave release-note metadata', () => {
  it.each([
    {
      environment: 'prod',
      branch: 'main',
      deployedSha: 'a'.repeat(40),
      changedFile: 'src/constants/example.ts',
      pull: {
        number: 42,
        merged_at: '2026-07-28T12:00:00Z',
        merge_commit_sha: 'a'.repeat(40),
        user: { login: 'PR-Author', type: 'User' }
      }
    },
    {
      environment: 'staging',
      branch: 'feature/manual-staging',
      deployedSha: 'b'.repeat(40),
      changedFile: 'src/api-serverless/src/example.ts',
      pull: {
        number: 42,
        merged_at: null,
        head: {
          ref: 'feature/manual-staging',
          sha: 'b'.repeat(40)
        },
        user: { login: 'PR-Author', type: 'User' }
      }
    }
  ])(
    'derives manual backend contributors for $environment from exact PR and service evidence',
    async ({ environment, branch, deployedSha, changedFile, pull }) => {
      const githubServer = createServer((request, response) => {
        const pathName = request.url ?? '';
        let body: unknown;
        if (pathName.endsWith('/pulls/42')) {
          body = pull;
        } else if (pathName.includes('/pulls/42/files')) {
          body = [{ filename: changedFile }];
        } else if (pathName.includes('/pulls/42/commits')) {
          body = [
            {
              author: { login: 'Commit-Author', type: 'User' },
              committer: { login: 'Commit-Committer', type: 'User' }
            },
            {
              author: { login: 'dependabot[bot]', type: 'Bot' }
            }
          ];
        } else {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) =>
        githubServer.listen(0, '127.0.0.1', resolve)
      );
      const address = githubServer.address();
      if (!address || typeof address === 'string')
        throw new Error('missing port');

      try {
        const result = await runNotifier({
          CI_RELEASE_PULL_REQUEST: '42',
          CI_RELEASE_NOTE_OPT_OUT: 'false',
          CI_PIPELINES_TARGET_ENV: environment,
          GITHUB_REF_NAME: branch,
          GITHUB_SHA: deployedSha,
          GITHUB_TOKEN: 'test-token',
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`
        });

        expect(result).toMatchObject({
          code: 0,
          stderr: '',
          payload: {
            contributor_evidence: 'manual-pr',
            contributor_github_logins: [
              'PR-Author',
              'Commit-Author',
              'Commit-Committer'
            ]
          }
        });
        expect(result.payload).not.toHaveProperty('release_train_id');
      } finally {
        await new Promise<void>((resolve, reject) =>
          githubServer.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('times out stalled contributor evidence and still sends the CI notification', async () => {
    const githubServer = createServer(() => {
      // Deliberately leave the evidence request open until the notifier aborts.
    });
    await new Promise<void>((resolve) =>
      githubServer.listen(0, '127.0.0.1', resolve)
    );
    const address = githubServer.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');

    try {
      const result = await runNotifier({
        CI_RELEASE_PULL_REQUEST: '42',
        CI_RELEASE_NOTE_OPT_OUT: 'false',
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        CI_GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS: '25'
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        'Contributors row omitted because exact manual deployment scope could not be established: GitHub contributor evidence request timed out after 25ms: /pulls/42'
      );
      expect(result.payload).not.toHaveProperty('contributor_evidence');
      expect(result.payload).not.toHaveProperty('contributor_github_logins');
    } finally {
      githubServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        githubServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each([
    {
      name: 'an open PR whose head and branch do not match',
      pull: {
        number: 42,
        merged_at: null,
        head: { ref: 'different-branch', sha: 'b'.repeat(40) },
        user: { login: 'PR-Author', type: 'User' }
      },
      diagnostic: 'Open PR #42 does not exactly match deployed branch main'
    },
    {
      name: 'a merged PR that is absent from the deployed SHA',
      pull: {
        number: 42,
        merged_at: '2026-07-28T12:00:00Z',
        merge_commit_sha: 'b'.repeat(40),
        user: { login: 'PR-Author', type: 'User' }
      },
      comparison: { status: 'behind' },
      diagnostic: `Deployed SHA ${'a'.repeat(40)} does not contain PR #42`
    },
    {
      name: 'a PR that does not affect the deployed service',
      pull: {
        number: 42,
        merged_at: '2026-07-28T12:00:00Z',
        merge_commit_sha: 'a'.repeat(40),
        user: { login: 'PR-Author', type: 'User' }
      },
      files: [{ filename: 'src/other-service/example.ts' }],
      diagnostic: 'PR #42 does not contain changes for api'
    }
  ])(
    'omits manual contributors for $name',
    async ({ pull, files, comparison, diagnostic }) => {
      const result = await runManualEvidenceNotifier({
        pull,
        ...(files ? { files } : {}),
        ...(comparison ? { comparison } : {})
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Contributors row omitted because exact manual deployment scope could not be established: ${diagnostic}`
      );
      expect(result.payload).not.toHaveProperty('contributor_evidence');
      expect(result.payload).not.toHaveProperty('contributor_github_logins');
    }
  );

  it('excludes explicit non-user account types from manual contributors', async () => {
    const result = await runManualEvidenceNotifier({
      pull: {
        number: 42,
        merged_at: '2026-07-28T12:00:00Z',
        merge_commit_sha: 'a'.repeat(40),
        user: { login: 'release-organization', type: 'Organization' }
      },
      commits: [
        {
          author: { login: 'release-app', type: 'App' },
          committer: { login: 'release-bot', type: 'Bot' }
        }
      ]
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.payload).not.toHaveProperty('contributor_evidence');
    expect(result.payload).not.toHaveProperty('contributor_github_logins');
  });

  it('sends canonical release train contributors and the deployed SHA', async () => {
    const expectedSha = 'b'.repeat(40);
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
        release_train_id: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
        release_operation_key:
          'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
        contributor_evidence: 'release-bus-operation',
        contributor_github_logins: ['GelatoGenesis', 'prxt6529'],
        sha: expectedSha
      }
    });
  });

  it('preserves Release Bus contributors for an internal release-note opt-out', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['GelatoGenesis']),
      CI_RELEASE_NOTE_GROUPS: '[]',
      CI_RELEASE_NOTE_OPT_OUT: 'true'
    });

    expect(result).toMatchObject({
      code: 0,
      stderr: '',
      payload: {
        contributor_evidence: 'release-bus-operation',
        contributor_github_logins: ['GelatoGenesis']
      }
    });
    expect(result.payload).not.toHaveProperty('release_notes_prompt_path');
  });

  it('rejects user-supplied contributors on a manual deployment', async () => {
    const result = await runNotifier({
      CI_RELEASE_PULL_REQUEST: '42',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['GelatoGenesis'])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Manual deployments cannot supply contributors; exact PR evidence is required'
    );
    expect(result.payload).toBeNull();
  });

  it('requires Release Bus train and operation identities together', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_CONTRIBUTORS: '[]'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_TRAIN_ID and CI_RELEASE_OPERATION_KEY must be supplied together'
    );
    expect(result.payload).toBeNull();
  });

  it('rejects invalid release contributor metadata', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['not a login'])
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_RELEASE_CONTRIBUTORS contains an invalid GitHub login'
    );
    expect(result.payload).toBeNull();
  });

  it.each(['trailing-', 'double--hyphen', `${'a'.repeat(35)}[bot]`])(
    'rejects impossible GitHub login %s',
    async (login) => {
      const result = await runNotifier({
        CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
        CI_RELEASE_OPERATION_KEY:
          'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
        CI_RELEASE_CONTRIBUTORS: JSON.stringify([login])
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'CI_RELEASE_CONTRIBUTORS contains an invalid GitHub login'
      );
    }
  );

  it('rejects an invalid deployed SHA override', async () => {
    const result = await runNotifier({
      CI_PIPELINES_SHA: 'not-a-git-sha'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'CI_PIPELINES_SHA must be a 40-character lowercase Git SHA'
    );
    expect(result.payload).toBeNull();
  });

  it('sends canonical per-PR v2 release-note groups', async () => {
    const result = await runNotifier({
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_GROUP_SERVICES: 'wrongLegacyService',
      CI_RELEASE_NOTE_PUBLISH: 'false',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
      CI_RELEASE_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      CI_RELEASE_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:backend:api:a1',
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
      CI_RELEASE_NOTE_OPT_OUT: 'false',
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
      'Manual no-PR opt-out cannot include a PR, contributors, release-note metadata, or a publish request'
    );
    expect(result.payload).toBeNull();
  });

  it.each(['staging', 'prod'])(
    'allows an explicit no-PR %s operation without contributors or release notes',
    async (environment) => {
      const result = await runNotifier({
        CI_PIPELINES_TARGET_ENV: environment,
        CI_RELEASE_PULL_REQUEST: '',
        CI_RELEASE_NOTE_OPT_OUT: 'true'
      });

      expect(result).toMatchObject({
        code: 0,
        stderr: '',
        payload: {
          environment
        }
      });
      expect(result.payload).not.toHaveProperty('contributor_evidence');
      expect(result.payload).not.toHaveProperty('contributor_github_logins');
      expect(result.payload).not.toHaveProperty('release_notes_prompt_path');
      expect(result.payload).not.toHaveProperty('publish_release_note');
    }
  );

  it('rejects an empty manual PR without explicit opt-out', async () => {
    const result = await runNotifier({
      CI_RELEASE_PULL_REQUEST: '',
      CI_RELEASE_NOTE_OPT_OUT: 'false'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Manual deployments require CI_RELEASE_PULL_REQUEST or explicit CI_RELEASE_NOTE_OPT_OUT=true'
    );
    expect(result.payload).toBeNull();
  });

  it('rejects contributor metadata on an explicit no-PR operation', async () => {
    const result = await runNotifier({
      CI_RELEASE_CONTRIBUTORS: JSON.stringify(['GelatoGenesis']),
      CI_RELEASE_NOTE_OPT_OUT: 'true'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Manual no-PR opt-out cannot include a PR, contributors, release-note metadata, or a publish request'
    );
    expect(result.payload).toBeNull();
  });
});

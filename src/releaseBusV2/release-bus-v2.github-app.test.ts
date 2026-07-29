import fetch, { Response } from 'node-fetch';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  isValidGitHubWorkflowActor,
  ReleaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError,
  releaseBusPrCiPolicyInventory,
  releaseBusPullRequestMergeStateEligible,
  safeGitHubWorkflowLabel,
  sanitizeGitHubWorkflowJobs,
  workflowRunMatchesOperation,
  type GitHubWorkflowJob
} from '@/releaseBusV2/release-bus-v2.github-app';

const { buildPolicyBundle } =
  require('../../scripts/pr-ci-policy-bundle.cjs') as {
    buildPolicyBundle(input: { root: string }): { canonical: string };
  };

jest.mock('node-fetch', () => {
  const actual = jest.requireActual('node-fetch');
  return { ...actual, __esModule: true, default: jest.fn() };
});

function appWithCachedToken(requestTimeoutMs?: number): ReleaseBusGitHubApp {
  const app = new ReleaseBusGitHubApp(requestTimeoutMs);
  (
    app as unknown as {
      cachedToken: { value: string; expiresAt: number };
    }
  ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
  return app;
}

const EVIDENCE_GATES = {
  backend: [
    'generated-files',
    'lint',
    'format',
    'backend-test-and-typecheck',
    'api-build',
    'pr-ci-policy-bundle'
  ],
  frontend: [
    'package-manager-discipline',
    'dependency-analysis',
    'reviewbot-contract',
    'generated-agent-files',
    'release-bus-workflow-contract',
    'changed-lint',
    'changed-typecheck',
    'test-typecheck',
    'related-jest-selection',
    'production-build-or-plan-not-required',
    'pr-ci-policy-bundle'
  ]
} as const;

const EVIDENCE_WORKFLOWS = {
  backend: '.github/workflows/on-pull-request.yml',
  frontend: '.github/workflows/app-pr-ci.yml'
} as const;

const EVIDENCE_CHECKS = {
  backend: 'Build backend and API',
  frontend: 'Installed app checks'
} as const;

const TRUSTED_WORKFLOW_BLOBS = {
  backend: {
    legacy: '0cc8865dbb869b5156b46cc45e8581b259052916',
    modern: 'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40'
  },
  frontend: {
    legacy: 'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c',
    modern: '2dcada8aac190b3e9c4fc13d64de06f4d945fbc3'
  }
} as const;

function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

function setDottedString(
  document: Record<string, unknown>,
  dottedKey: string,
  value: string
): void {
  const segments = dottedKey.split('.');
  let current = document;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next =
      current[segment] &&
      typeof current[segment] === 'object' &&
      !Array.isArray(current[segment])
        ? (current[segment] as Record<string, unknown>)
        : {};
    current[segment] = next;
    current = next;
  });
}

function readDottedString(
  document: Readonly<Record<string, unknown>>,
  dottedKey: string
): string {
  const value = dottedKey
    .split('.')
    .reduce<unknown>(
      (current, segment) =>
        current && typeof current === 'object'
          ? (current as Readonly<Record<string, unknown>>)[segment]
          : undefined,
      document
    );
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Missing package policy value ${dottedKey}`);
  return value;
}

function backendPolicyBundleFromVerifierInventory(): string {
  const root = process.cwd();
  const inventory = releaseBusPrCiPolicyInventory('backend', true);
  const packages = new Map(
    inventory.packages.map((policy) => [policy.path, policy])
  );
  const lines: string[] = [];
  for (const relativePath of inventory.paths) {
    const policy = packages.get(relativePath);
    const bytes = readFileSync(path.join(root, relativePath));
    if (!policy) {
      lines.push(`file\t${relativePath}\t${gitBlobSha(bytes)}\n`);
      continue;
    }
    const document = JSON.parse(bytes.toString('utf8')) as Readonly<
      Record<string, unknown>
    >;
    const scripts =
      document.scripts &&
      typeof document.scripts === 'object' &&
      !Array.isArray(document.scripts)
        ? (document.scripts as Readonly<Record<string, unknown>>)
        : {};
    for (const key of policy.scriptKeys) {
      const value = scripts[key];
      if (typeof value !== 'string' || value.length === 0)
        throw new Error(`Missing package policy script ${relativePath}#${key}`);
      lines.push(
        `package-script\t${relativePath}#${key}\t${JSON.stringify(value)}\n`
      );
    }
    for (const key of policy.fieldKeys)
      lines.push(
        `package-field\t${relativePath}#${key}\t${JSON.stringify(
          readDottedString(document, key)
        )}\n`
      );
  }
  lines.push('runtime-pin\tnode\t"22.17.1"\n');
  return lines
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    )
    .join('');
}

function policyFixture(
  repository: 'backend' | 'frontend',
  modern: boolean,
  workflowBlob: string,
  packageScriptOverrides: Readonly<Record<string, string>> = {}
): {
  readonly tree: Record<string, unknown>;
  readonly blobs: ReadonlyMap<string, Buffer>;
  readonly bundle: Buffer;
} {
  const inventory = releaseBusPrCiPolicyInventory(repository, modern);
  const blobs = new Map<string, Buffer>();
  const packageEntries = new Map<string, { sha: string; size: number }>();
  const lines: string[] = [];
  for (const policy of inventory.packages) {
    const document: Record<string, unknown> = { scripts: {} };
    for (const key of policy.scriptKeys)
      (document.scripts as Record<string, unknown>)[key] =
        packageScriptOverrides[key] ?? `fixture:${key}`;
    for (const key of policy.fieldKeys) {
      if (
        !modern &&
        repository === 'backend' &&
        ((policy.path === 'package.json' &&
          [
            'dependencies.adm-zip',
            'devDependencies.jest',
            'devDependencies.yaml'
          ].includes(key)) ||
          (policy.path === 'src/api-serverless/package.json' &&
            key === 'dependencies.adm-zip'))
      )
        continue;
      setDottedString(
        document,
        key,
        key === 'packageManager'
          ? repository === 'backend'
            ? 'npm@10.9.8'
            : 'pnpm@10.33.0'
          : `fixture:${key}`
      );
    }
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    const sha = gitBlobSha(bytes);
    blobs.set(sha, bytes);
    packageEntries.set(policy.path, { sha, size: bytes.length });
    for (const key of policy.scriptKeys)
      lines.push(
        `package-script\t${repository === 'frontend' ? key : `${policy.path}#${key}`}\t${JSON.stringify((document.scripts as Record<string, string>)[key])}\n`
      );
    for (const key of policy.fieldKeys) {
      const value = key
        .split('.')
        .reduce<unknown>(
          (current, segment) =>
            current && typeof current === 'object'
              ? (current as Record<string, unknown>)[segment]
              : undefined,
          document
        );
      if (typeof value === 'string')
        lines.push(
          `package-field\t${repository === 'frontend' ? key : `${policy.path}#${key}`}\t${JSON.stringify(value)}\n`
        );
    }
  }
  const tree = inventory.paths.map((path) => {
    const packageEntry = packageEntries.get(path);
    const sha =
      packageEntry?.sha ??
      (path === EVIDENCE_WORKFLOWS[repository]
        ? workflowBlob
        : gitBlobSha(Buffer.from(`fixture:${path}`)));
    if (!packageEntry) lines.push(`file\t${path}\t${sha}\n`);
    return {
      path,
      type: 'blob',
      sha,
      size: packageEntry?.size ?? Buffer.byteLength(`fixture:${path}`)
    };
  });
  if (modern) lines.push('runtime-pin\tnode\t"22.17.1"\n');
  lines.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  return {
    tree: { truncated: false, tree },
    blobs,
    bundle: Buffer.from(lines.join(''))
  };
}

function evidenceArchive(input: {
  readonly repository: 'backend' | 'frontend';
  readonly headSha: string;
  readonly mergeSha: string;
  readonly workflow?: string;
  readonly gates?: readonly string[];
  readonly checksumPath?: string;
  readonly manifestOverride?: Record<string, unknown>;
  readonly policyBundle?: Buffer;
}): Buffer {
  const policyBundle =
    input.policyBundle ??
    Buffer.from(
      `file\tfixture\t${'f'.repeat(40)}\nruntime-pin\tnode\t"22.17.1"\n`
    );
  const manifest = Buffer.from(
    `${JSON.stringify({
      schema_version: 1,
      evidence_contract: 'exact-merge-tree-pr-ci-v1',
      repository: input.repository,
      merge_sha: input.mergeSha,
      head_sha: input.headSha,
      workflow: input.workflow ?? EVIDENCE_WORKFLOWS[input.repository],
      policy_bundle_contract: 'pr-ci-policy-bundle-v1',
      policy_bundle_digest: createHash('sha256')
        .update(policyBundle)
        .digest('hex'),
      policy_bundle_line_count: policyBundle
        .toString('utf8')
        .split('\n')
        .filter(Boolean).length,
      required_gates: input.gates ?? EVIDENCE_GATES[input.repository],
      ...(input.manifestOverride ?? {})
    })}\n`
  );
  const archive = new AdmZip();
  archive.addFile('manifest.json', manifest);
  archive.addFile('policy-bundle.txt', policyBundle);
  archive.addFile(
    'SHA256SUMS',
    Buffer.from(
      `${createHash('sha256').update(manifest).digest('hex')}  ${input.checksumPath ?? './manifest.json'}\n${createHash('sha256').update(policyBundle).digest('hex')}  ./policy-bundle.txt\n`
    )
  );
  return archive.toBuffer();
}

function backendEvidenceArchive(input: {
  readonly headSha: string;
  readonly mergeSha: string;
  readonly workflow?: string;
  readonly checksumPath?: string;
  readonly manifestOverride?: Record<string, unknown>;
}): Buffer {
  return evidenceArchive({ repository: 'backend', ...input });
}

function withZeroDeclaredEntrySize(
  archiveBytes: Buffer,
  entryName: string
): Buffer {
  const mutated = Buffer.from(archiveBytes);
  for (let offset = 0; offset <= mutated.length - 46; offset += 1) {
    if (mutated.readUInt32LE(offset) !== 0x02014b50) continue;
    const fileNameLength = mutated.readUInt16LE(offset + 28);
    const extraLength = mutated.readUInt16LE(offset + 30);
    const commentLength = mutated.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > mutated.length)
      throw new Error('Invalid ZIP central directory fixture');
    if (mutated.subarray(nameStart, nameEnd).toString('utf8') === entryName) {
      const localHeaderOffset = mutated.readUInt32LE(offset + 42);
      if (
        localHeaderOffset + 30 > mutated.length ||
        mutated.readUInt32LE(localHeaderOffset) !== 0x04034b50
      )
        throw new Error('Invalid ZIP local header fixture');
      mutated.writeUInt32LE(0, offset + 24);
      mutated.writeUInt32LE(0, localHeaderOffset + 22);
      return mutated;
    }
    offset = nameEnd + extraLength + commentLength - 1;
  }
  throw new Error(`ZIP fixture entry ${entryName} was not found`);
}

function queueQualificationResponses(input: {
  readonly repository?: 'backend' | 'frontend';
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeSha: string;
  readonly runId?: number;
  readonly baseWorkflowBlob?: string;
  readonly mergeWorkflowBlob?: string;
  readonly archive?: Buffer;
  readonly artifactOverride?: Record<string, unknown>;
  readonly artifacts?: readonly Record<string, unknown>[];
  readonly skipArtifactDownload?: boolean;
  readonly runOverride?: Record<string, unknown>;
  readonly checkOverride?: Record<string, unknown>;
  readonly packageScriptOverrides?: Readonly<Record<string, string>>;
  readonly alternatePolicyPath?: string;
  readonly changedPolicyPath?: string;
}): jest.MockedFunction<typeof fetch> {
  const repository = input.repository ?? 'backend';
  const runId = input.runId ?? 12345;
  const workflow = EVIDENCE_WORKFLOWS[repository];
  const baseWorkflowBlob =
    input.baseWorkflowBlob ?? TRUSTED_WORKFLOW_BLOBS[repository].modern;
  const mergeWorkflowBlob =
    input.mergeWorkflowBlob ?? TRUSTED_WORKFLOW_BLOBS[repository].modern;
  const baseFixture = policyFixture(
    repository,
    baseWorkflowBlob !== TRUSTED_WORKFLOW_BLOBS[repository].legacy,
    baseWorkflowBlob
  );
  const mergeFixture = policyFixture(
    repository,
    mergeWorkflowBlob !== TRUSTED_WORKFLOW_BLOBS[repository].legacy,
    mergeWorkflowBlob,
    input.packageScriptOverrides
  );
  const mergeTree = structuredClone(mergeFixture.tree) as {
    truncated: boolean;
    tree: Array<Record<string, unknown>>;
  };
  if (input.alternatePolicyPath)
    mergeTree.tree.push({
      path: input.alternatePolicyPath,
      type: 'blob',
      sha: '7'.repeat(40),
      size: 1
    });
  if (input.changedPolicyPath) {
    const entry = mergeTree.tree.find(
      ({ path }) => path === input.changedPolicyPath
    );
    if (entry) entry.sha = '7'.repeat(40);
  }
  const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          number: 42,
          state: 'open',
          mergeable: true,
          mergeable_state: 'blocked',
          user: { login: 'PR-Author', type: 'User' },
          head: { sha: input.headSha, ref: 'agent/test' },
          base: { sha: input.baseSha, ref: 'main' },
          merge_commit_sha: input.mergeSha
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          check_runs: [
            {
              id: 99,
              name: EVIDENCE_CHECKS[repository],
              status: 'completed',
              conclusion: 'success',
              completed_at: '2026-07-23T04:00:00Z',
              details_url: `https://github.com/6529-Collections/6529seize-${repository}/actions/runs/${runId}/job/7`,
              ...(input.checkOverride ?? {})
            }
          ]
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          artifacts: input.artifacts ?? [
            {
              id: 100,
              name: `release-bus-v2-pr-${input.mergeSha}`,
              digest: `sha256:${'d'.repeat(64)}`,
              expired: false,
              size_in_bytes: 1024,
              workflow_run: { id: runId, head_sha: input.headSha },
              ...(input.artifactOverride ?? {})
            }
          ]
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: runId,
          name: EVIDENCE_CHECKS[repository],
          path: workflow,
          display_title: `${repository} PR CI`,
          status: 'completed',
          conclusion: 'success',
          head_sha: input.headSha,
          html_url: `https://github.com/example/actions/runs/${runId}`,
          event: 'pull_request',
          actor: { login: 'github-actions[bot]' },
          ...(input.runOverride ?? {})
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'file',
          sha: baseWorkflowBlob
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'file',
          sha: mergeWorkflowBlob
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: { sha: '1'.repeat(40) } }))
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: { sha: '2'.repeat(40) } }))
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(baseFixture.tree)))
    .mockResolvedValueOnce(new Response(JSON.stringify(mergeTree)));
  const blobDocuments = new Map([
    ...Array.from(baseFixture.blobs.entries()),
    ...Array.from(mergeFixture.blobs.entries())
  ]);
  const orderedBlobShas = new Set<string>();
  for (const { path } of releaseBusPrCiPolicyInventory(repository, true)
    .packages) {
    for (const fixture of [baseFixture.tree, mergeTree]) {
      const entry = (
        fixture.tree as Array<{ path?: string; sha?: string }>
      ).find((candidate) => candidate.path === path);
      if (entry?.sha) orderedBlobShas.add(entry.sha);
    }
  }
  for (const sha of Array.from(orderedBlobShas)) {
    const bytes = blobDocuments.get(sha);
    if (!bytes) throw new Error(`Missing test policy blob ${sha}`);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sha,
          encoding: 'base64',
          content: bytes.toString('base64'),
          size: bytes.length
        })
      )
    );
  }
  if (!input.skipArtifactDownload)
    fetchMock.mockResolvedValueOnce(
      new Response(
        input.archive ??
          evidenceArchive({
            repository,
            headSha: input.headSha,
            mergeSha: input.mergeSha,
            policyBundle: mergeFixture.bundle
          })
      )
    );
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        {
          author: { login: 'Commit-Author', type: 'User' },
          committer: { login: 'Commit-Committer', type: 'User' }
        },
        {
          author: { login: '6529-release-bus[bot]', type: 'Bot' },
          committer: { login: 'github-actions', type: 'Bot' }
        }
      ])
    )
  );
  return fetchMock;
}

describe('backend PR CI policy bundle contract', () => {
  it('keeps producer and verifier canonical inventories byte-identical', () => {
    const produced = buildPolicyBundle({ root: process.cwd() }).canonical;

    expect(backendPolicyBundleFromVerifierInventory()).toBe(produced);
    expect(
      releaseBusPrCiPolicyInventory('backend', true).packages.find(
        ({ path: packagePath }) => packagePath === 'package.json'
      )?.fieldKeys
    ).toContain('devDependencies.@types/jest');
  });
});

describe('GitHub immutable release refs', () => {
  const ref = 'release-bus-v2/staging-train-train-id-frontend';
  const exactSha = 'a'.repeat(40);

  afterEach(() => {
    (fetch as jest.MockedFunction<typeof fetch>).mockReset();
  });

  it('creates an absent immutable release ref without force', async () => {
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ref: `refs/heads/${ref}` }), {
        status: 201
      })
    );

    await appWithCachedToken().createRef('frontend', ref, exactSha);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/git/refs');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${ref}`,
          sha: exactSha
        })
      })
    );
  });

  it('aborts a GitHub request at the configured request deadline', async () => {
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );

    await expect(
      appWithCachedToken(5).resolveRef('frontend', 'main')
    ).rejects.toMatchObject({
      name: ReleaseBusGitHubInfrastructureError.name,
      message: 'GitHub request timed out after 5ms'
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it('is idempotent only when a racing ref resolves to the exact SHA', async () => {
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Reference already exists' }), {
          status: 422
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: { sha: exactSha } }))
      );

    await expect(
      appWithCachedToken().createRef('frontend', ref, exactSha)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a racing ref resolves to another SHA', async () => {
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Reference already exists' }), {
          status: 422
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }))
      );

    await expect(
      appWithCachedToken().createRef('frontend', ref, exactSha)
    ).rejects.toThrow(
      'Failed to create frontend ref release-bus-v2/staging-train-train-id-frontend: Reference already exists'
    );
  });
});

describe('GitHub pull request qualification evidence', () => {
  it('reads checks from the PR head and binds the artifact to its merge tree', async () => {
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const runId = 12345;
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha,
      mergeSha,
      runId
    });

    try {
      const qualification =
        await appWithCachedToken().getPullRequestQualification(
          'backend',
          42,
          headSha
        );

      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/commits/${headSha}/check-runs`
      );
      expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain(mergeSha);
      expect(qualification).toMatchObject({
        baseSha,
        mergeSha,
        checksRunId: String(runId),
        artifactRunId: String(runId),
        artifactName: `release-bus-v2-pr-${mergeSha}`,
        artifactDigest: 'd'.repeat(64),
        contributorGithubLogins: [
          'PR-Author',
          'Commit-Author',
          'Commit-Committer'
        ]
      });
      expect(String(fetchMock.mock.calls[3]?.[0])).toContain(
        `/actions/runs/${runId}`
      );
      expect(String(fetchMock.mock.calls[4]?.[0])).toContain(
        `.github/workflows/on-pull-request.yml?ref=${baseSha}`
      );
      expect(String(fetchMock.mock.calls[5]?.[0])).toContain(
        `.github/workflows/on-pull-request.yml?ref=${mergeSha}`
      );
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes(`/git/commits/${baseSha}`)
        )
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/actions/artifacts/100/zip')
        )
      ).toBe(true);
    } finally {
      fetchMock.mockReset();
    }
  });

  it.each([
    {
      repository: 'backend' as const,
      baseWorkflowBlob: TRUSTED_WORKFLOW_BLOBS.backend.modern,
      mergeWorkflowBlob: TRUSTED_WORKFLOW_BLOBS.backend.modern
    },
    {
      repository: 'frontend' as const,
      baseWorkflowBlob: TRUSTED_WORKFLOW_BLOBS.frontend.modern,
      mergeWorkflowBlob: TRUSTED_WORKFLOW_BLOBS.frontend.modern
    }
  ])(
    'accepts the exact trusted modern $repository workflow and canonical evidence fixture',
    async ({ repository, baseWorkflowBlob, mergeWorkflowBlob }) => {
      const headSha = 'a'.repeat(40);
      const baseSha = 'b'.repeat(40);
      const mergeSha = 'c'.repeat(40);
      const fetchMock = queueQualificationResponses({
        repository,
        headSha,
        baseSha,
        mergeSha,
        baseWorkflowBlob,
        mergeWorkflowBlob
      });

      try {
        await expect(
          appWithCachedToken().getPullRequestQualification(
            repository,
            42,
            headSha
          )
        ).resolves.toMatchObject({
          baseSha,
          mergeSha,
          artifactName: `release-bus-v2-pr-${mergeSha}`
        });
      } finally {
        fetchMock.mockReset();
      }
    }
  );

  it.each([
    {
      repository: 'backend' as const,
      legacyBlob: '0cc8865dbb869b5156b46cc45e8581b259052916',
      artifacts: undefined,
      artifactOverride: { size_in_bytes: 50 * 1024 * 1024 }
    },
    {
      repository: 'frontend' as const,
      legacyBlob: 'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c',
      artifacts: [] as readonly Record<string, unknown>[],
      artifactOverride: undefined
    }
  ])(
    'accepts only the exact unchanged legacy $repository workflow without parsing old deploy bytes',
    async ({ repository, legacyBlob, artifacts, artifactOverride }) => {
      const headSha = 'a'.repeat(40);
      const baseSha = 'b'.repeat(40);
      const mergeSha = 'c'.repeat(40);
      const fetchMock = queueQualificationResponses({
        repository,
        headSha,
        baseSha,
        mergeSha,
        baseWorkflowBlob: legacyBlob,
        mergeWorkflowBlob: legacyBlob,
        artifacts,
        artifactOverride,
        skipArtifactDownload: true
      });

      try {
        await expect(
          appWithCachedToken().getPullRequestQualification(
            repository,
            42,
            headSha
          )
        ).resolves.toMatchObject({
          workflowPath: EVIDENCE_WORKFLOWS[repository],
          baseWorkflowBlobSha: legacyBlob,
          mergeWorkflowBlobSha: legacyBlob,
          trustMode: 'legacy-exact-workflow-v0',
          ...(repository === 'frontend'
            ? {
                artifactRunId: null,
                artifactName: null,
                artifactDigest: null
              }
            : { artifactRunId: '12345' })
        });
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes('/actions/artifacts/100/zip')
          )
        ).toBe(false);
      } finally {
        fetchMock.mockReset();
      }
    }
  );

  it('rejects a workflow blob transition that was not exactly preauthorized', async () => {
    const headSha = 'a'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha: 'c'.repeat(40),
      baseWorkflowBlob: '1'.repeat(40),
      mergeWorkflowBlob: '2'.repeat(40)
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('without an exact preauthorized blob transition');
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/actions/artifacts/100/zip')
        )
      ).toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('rejects a candidate that turns a required backend package gate into a no-op', async () => {
    const headSha = 'a'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha,
      packageScriptOverrides: { build: 'true' }
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('gate policy bundle changed');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('rejects protected gate drift but permits unrelated existing config variants', async () => {
    const headSha = 'a'.repeat(40);
    const driftFetch = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha: 'c'.repeat(40),
      changedPolicyPath: 'jest.config.ts'
    });
    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('gate policy bundle changed');
    } finally {
      driftFetch.mockReset();
    }

    const existingVariantFetch = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha: 'c'.repeat(40),
      alternatePolicyPath: 'eslint.config.single.mjs'
    });
    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).resolves.toMatchObject({
        mergeGatePolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    } finally {
      existingVariantFetch.mockReset();
    }
  });

  it('persists separate exact base and merge gate-policy bundle digests', async () => {
    const headSha = 'a'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).resolves.toMatchObject({
        baseGatePolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        mergeGatePolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    } finally {
      fetchMock.mockReset();
    }
  });

  it.each([
    {
      name: 'wrong workflow path',
      options: {
        runOverride: { path: '.github/workflows/untrusted.yml' }
      },
      message: 'not from the required exact-head workflow'
    },
    {
      name: 'oversized artifact metadata',
      options: {
        artifactOverride: { size_in_bytes: 128 * 1024 + 1 }
      },
      message: 'no bounded exact green merge-tree CI evidence artifact'
    },
    {
      name: 'noncanonical checksum path',
      options: {
        archive: backendEvidenceArchive({
          headSha: 'a'.repeat(40),
          mergeSha: 'c'.repeat(40),
          checksumPath: 'manifest.json'
        })
      },
      message: 'checksum is invalid'
    },
    {
      name: 'wrong required gate inventory',
      options: {
        archive: backendEvidenceArchive({
          headSha: 'a'.repeat(40),
          mergeSha: 'c'.repeat(40),
          manifestOverride: { required_gates: ['lint'] }
        })
      },
      message: 'does not bind the exact head'
    }
  ])('rejects $name', async ({ options, message }) => {
    const headSha = 'a'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha: 'c'.repeat(40),
      ...options
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow(message);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('caps streamed evidence bytes before ZIP parsing', async () => {
    const headSha = 'a'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha: 'c'.repeat(40),
      archive: Buffer.alloc(128 * 1024 + 1)
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('archive exceeds the size limit');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('caps uncompressed evidence entries before reading their data', async () => {
    const headSha = 'a'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha,
      archive: backendEvidenceArchive({
        headSha,
        mergeSha,
        manifestOverride: { padding: 'x'.repeat(70 * 1024) }
      })
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('expands beyond the size limit');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('rejects a nonempty compressed entry that declares zero output bytes', async () => {
    const headSha = 'a'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const archive = backendEvidenceArchive({ headSha, mergeSha });
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha,
      archive: withZeroDeclaredEntrySize(archive, 'policy-bundle.txt')
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('expands beyond the size limit');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('rejects extra ZIP directory entries instead of ignoring them', async () => {
    const headSha = 'a'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const archive = new AdmZip(backendEvidenceArchive({ headSha, mergeSha }));
    archive.addFile('unexpected/', Buffer.alloc(0));
    const fetchMock = queueQualificationResponses({
      headSha,
      baseSha: 'b'.repeat(40),
      mergeSha,
      archive: archive.toBuffer()
    });

    try {
      await expect(
        appWithCachedToken().getPullRequestQualification('backend', 42, headSha)
      ).rejects.toThrow('archive has unexpected files');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('keeps qualification available when commit contributor enrichment fails', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 429
      })
    );

    try {
      await expect(
        (
          app as unknown as {
            getPullRequestContributorGithubLogins(
              repository: 'backend',
              pullNumber: number,
              pull: { user: { login: string; type: string } }
            ): Promise<readonly string[]>;
          }
        ).getPullRequestContributorGithubLogins('backend', 42, {
          user: { login: 'PR-Author', type: 'User' }
        })
      ).resolves.toEqual(['PR-Author']);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('accepts only identities explicitly classified as users', async () => {
    const app = appWithCachedToken();
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            author: { login: 'Human-Author', type: 'User' },
            committer: {
              login: 'Organization-Committer',
              type: 'Organization'
            }
          }
        ])
      )
    );

    try {
      await expect(
        (
          app as unknown as {
            getPullRequestContributorGithubLogins(
              repository: 'backend',
              pullNumber: number,
              pull: {
                user: { login: string; type?: string };
              }
            ): Promise<readonly string[]>;
          }
        ).getPullRequestContributorGithubLogins('backend', 42, {
          user: { login: 'Legacy-User' }
        })
      ).resolves.toEqual(['Human-Author']);
    } finally {
      fetchMock.mockReset();
    }
  });
});

describe('GitHub pull request release eligibility', () => {
  it('accepts a ruleset-blocked but explicitly mergeable exact tree', () => {
    expect(releaseBusPullRequestMergeStateEligible(true, 'blocked')).toBe(true);
  });

  it.each(['dirty', 'draft', 'unknown', undefined])(
    'rejects an unresolved %s merge state',
    (state) => {
      expect(releaseBusPullRequestMergeStateEligible(true, state)).toBe(false);
    }
  );

  it('rejects a known merge conflict regardless of state label', () => {
    expect(releaseBusPullRequestMergeStateEligible(false, 'blocked')).toBe(
      false
    );
  });
});

describe('GitHub workflow operation identity', () => {
  it('accepts human and GitHub App workflow actors', () => {
    expect(isValidGitHubWorkflowActor('GelatoGenesis')).toBe(true);
    expect(isValidGitHubWorkflowActor('6529-release-bus[bot]')).toBe(true);
    expect(isValidGitHubWorkflowActor('github-actions[bot]')).toBe(false);
    expect(isValidGitHubWorkflowActor('release-bus[admin]')).toBe(false);
    expect(isValidGitHubWorkflowActor(`${'a'.repeat(40)}`)).toBe(false);
  });

  it('reads the exact Release Bus App actor from a workflow run', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 12345,
          run_attempt: 2,
          name: 'Release Bus v2 - Compose Backend',
          path: '.github/workflows/release-bus-v2-compose.yml',
          display_title: 'Compose backend v2 train beta [rb2:beta:a1]',
          status: 'in_progress',
          conclusion: null,
          head_branch: 'main',
          head_sha: 'a'.repeat(40),
          html_url: 'https://github.com/example/actions/runs/12345',
          event: 'workflow_dispatch',
          actor: { login: '6529-release-bus[bot]' }
        })
      )
    );

    try {
      await expect(
        app.getWorkflowRunIdentity('backend', '12345')
      ).resolves.toMatchObject({
        actor: '6529-release-bus[bot]',
        attempt: 2,
        conclusion: null,
        event: 'workflow_dispatch',
        headBranch: 'main',
        headSha: 'a'.repeat(40),
        status: 'in_progress'
      });
    } finally {
      fetchMock.mockReset();
    }
  });

  it('reads the exact workflow blob at the immutable run head', async () => {
    const app = appWithCachedToken();
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'file',
          sha: 'B'.repeat(40)
        })
      )
    );

    try {
      await expect(
        app.getWorkflowBlobIdentity(
          'frontend',
          'release-bus-v2-preflight.yml',
          'a'.repeat(40)
        )
      ).resolves.toBe('b'.repeat(40));
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        `/contents/.github/workflows/release-bus-v2-preflight.yml?ref=${'a'.repeat(
          40
        )}`
      );
    } finally {
      fetchMock.mockReset();
    }
  });

  it.each([
    ['../deploy.yml', 'a'.repeat(40), 'filename'],
    ['Deploy.yml', 'a'.repeat(40), 'filename'],
    ['deploy.yaml', 'a'.repeat(40), 'filename'],
    ['deploy.yml', 'main', 'ref'],
    ['deploy.yml', 'A'.repeat(40), 'ref']
  ])(
    'rejects a malformed workflow blob identity %s at %s',
    async (workflow, ref, field) => {
      const app = appWithCachedToken();
      const fetchMock = fetch as jest.MockedFunction<typeof fetch>;

      await expect(
        app.getWorkflowBlobIdentity('backend', workflow, ref)
      ).rejects.toThrow(`Invalid GitHub workflow ${field}`);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('matches only the exact bracketed operation key', () => {
    const operationKey = 'rb:train-1:r1:preflight:aabbcc:a2';

    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [${operationKey}]`,
        operationKey
      )
    ).toBe(true);
    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [prefix-${operationKey}]`,
        operationKey
      )
    ).toBe(false);
    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [${operationKey}-suffix]`,
        operationKey
      )
    ).toBe(false);
  });
});

describe('GitHub workflow dispatch failure classification', () => {
  it('treats a secondary-rate-limit 403 as retryable infrastructure', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 403,
        headers: { 'Retry-After': '30' }
      })
    );

    try {
      await expect(
        app.dispatchWorkflow('backend', 'deploy.yml', 'main', {})
      ).rejects.toMatchObject({
        name: ReleaseBusGitHubInfrastructureError.name,
        message: expect.stringContaining('secondary rate limit')
      });
    } finally {
      fetchMock.mockReset();
    }
  });
});

describe('GitHub staging idle handshake', () => {
  it('treats an active staging E2E run as shared staging ownership', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 12345,
              name: 'Staging E2E',
              display_title: 'Guarded staging E2E',
              status: 'in_progress'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasActiveStagingMutationOrE2ERun('frontend')
      ).resolves.toBe(true);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('ignores only the exact validated current manual run during drain checks', async () => {
    const app = appWithCachedToken();
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 12345,
                name: 'Deploy a service',
                path: '.github/workflows/deploy.yml',
                display_title: 'Deploy api to staging [manual]',
                status: 'in_progress'
              }
            ]
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workflow_runs: [] }))
      );

    try {
      await expect(
        app.hasActiveStagingMutationOrE2ERun('backend', ['12345'])
      ).resolves.toBe(false);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        'status=queued&per_page=100&page=1'
      );
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        'status=in_progress&per_page=100&page=1'
      );
    } finally {
      fetchMock.mockReset();
    }
  });

  it('detects a completed staging deploy after the handshake and ignores exact train runs', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 100,
              name: 'Deploy api to staging train exact [rb2:exact]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging train exact [rb2:exact]',
              created_at: '2026-07-23T13:22:10Z'
            },
            {
              id: 101,
              name: 'Deploy api to staging [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging [manual]',
              created_at: '2026-07-23T13:23:22Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since, ['100'])
      ).resolves.toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        'created=%3E%3D2026-07-23T13%3A22%3A00.000Z'
      );
    } finally {
      fetchMock.mockReset();
    }
  });

  it('does not treat ignored exact train workflows as external mutation', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 100,
              name: 'Release Bus - Staging E2E exact train',
              path: '.github/workflows/staging-e2e.yml',
              display_title: 'Exact train E2E',
              created_at: '2026-07-23T13:22:20Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('frontend', since, ['100'])
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('excludes a date-filter result created before the fence window', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              name: 'Deploy api to staging [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging [manual]',
              created_at: '2026-07-23T13:21:59Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since)
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('paginates the beta fence history before accepting an idle result', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              name: 'Unrelated CI',
              path: '.github/workflows/ci.yml',
              display_title: 'Unrelated CI',
              created_at: '2026-07-23T13:23:00Z'
            }))
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 101,
                name: 'Web Deploy - STAGING',
                path: '.github/workflows/deploy-staging.yml',
                display_title: 'Web Deploy - STAGING',
                created_at: '2026-07-23T13:22:30Z'
              }
            ]
          })
        )
      );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('frontend', since)
      ).resolves.toBe(true);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('page=2');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('does not confuse a staging-canary title with shared staging', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 101,
              name: 'Deploy api to staging-canary [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging-canary [manual]',
              created_at: '2026-07-23T13:22:30Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since)
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('fails closed on a malformed exact train workflow id', async () => {
    const app = new ReleaseBusGitHubApp();

    await expect(
      app.hasStagingMutationOrE2ERunSince(
        'backend',
        Date.parse('2026-07-23T13:22:00Z'),
        ['reserved:operation']
      )
    ).rejects.toThrow('Invalid staging workflow fence run id');
  });
});

function job(index: number): GitHubWorkflowJob {
  return {
    id: index,
    name: ` Job ${index}\u0000 `,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/example/actions/jobs/${index}`,
    started_at: null,
    completed_at: null,
    steps: Array.from({ length: 101 }, (_, stepIndex) => ({
      name: ` Step ${stepIndex}\u0007 `,
      status: 'completed',
      conclusion: 'success',
      started_at: null,
      completed_at: null
    }))
  };
}

describe('GitHub workflow progress sanitization', () => {
  it('bounds job and step counts and strips control characters', () => {
    const jobs = sanitizeGitHubWorkflowJobs(
      Array.from({ length: 101 }, (_, index) => job(index))
    );

    expect(jobs).toHaveLength(100);
    expect(jobs[0].name).toBe('Job 0');
    expect(jobs[0].steps).toHaveLength(100);
    expect(jobs[0].steps?.[0].name).toBe('Step 0');
  });

  it('bounds persisted labels and drops empty values', () => {
    expect(safeGitHubWorkflowLabel('x'.repeat(501))).toHaveLength(500);
    expect(safeGitHubWorkflowLabel('\u0000\u0007')).toBeNull();
  });
});

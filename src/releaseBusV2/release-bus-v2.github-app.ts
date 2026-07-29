import { createHash, createSign } from 'node:crypto';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import AdmZip from 'adm-zip';
import { Logger } from '@/logging';
import { isReleaseBusGitHubAppActor } from '@/releaseBusV2/release-bus-v2.constants';
import { isHumanGithubContributorLogin } from '@/release-notes/release-note-contributors.config';
import type { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.types';

// The helper owns the abort signal so every request has one authoritative
// timeout classification; callers cannot replace it with an outer signal.
type GitHubRequestInit = Omit<RequestInit, 'signal'>;
type InstallationToken = {
  readonly token: string;
  readonly expires_at: string;
};
type GitHubRef = { readonly object?: { readonly sha?: string } };
type GitHubContentsIdentity = {
  readonly type?: string;
  readonly sha?: string;
  readonly encoding?: string;
  readonly content?: string;
  readonly size?: number;
};
type GitHubGitCommit = {
  readonly tree?: { readonly sha?: string };
};
type GitHubGitTree = {
  readonly truncated?: boolean;
  readonly tree?: readonly {
    readonly path?: string;
    readonly type?: string;
    readonly sha?: string;
    readonly size?: number;
  }[];
};
type GitHubGitBlob = {
  readonly sha?: string;
  readonly encoding?: string;
  readonly content?: string;
  readonly size?: number;
};
type GitHubMatchingRef = {
  readonly ref: string;
  readonly object?: { readonly sha?: string };
};
export type GitHubWorkflowStep = {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
};

export function workflowRunMatchesOperation(
  displayTitle: string,
  operationKey: string
): boolean {
  return displayTitle.includes(`[${operationKey}]`);
}

export function isValidGitHubWorkflowActor(actor: string): boolean {
  // GitHub App workflow actors use the app slug followed by the literal
  // `[bot]` suffix. Only the Release Bus App may drive automated operations;
  // human logins retain GitHub's 39-character limit for manual attribution.
  return (
    /^[A-Za-z0-9-]{1,39}$/.test(actor) || isReleaseBusGitHubAppActor(actor)
  );
}
export type GitHubWorkflowJob = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly steps?: GitHubWorkflowStep[];
};
export type GitHubRun = {
  readonly id: number;
  readonly run_attempt?: number;
  readonly name: string;
  readonly path?: string;
  readonly display_title: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly head_branch?: string;
  readonly html_url: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly event?: string;
  readonly actor?: { readonly login?: string };
  readonly jobs?: GitHubWorkflowJob[];
};

export type ReleaseBusWorkflowRunIdentity = {
  readonly actor: string;
  readonly attempt: number;
  readonly conclusion: string | null;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly name: string;
  readonly path: string;
  readonly displayTitle: string;
  readonly status: string;
};
type GitHubMembership = {
  readonly state?: string;
  readonly role?: string;
};
type GitHubCommitStatus = {
  readonly context?: string;
  readonly state?: string;
  readonly description?: string | null;
};
type GitHubPullRequestDetails = {
  readonly number?: number;
  readonly state?: string;
  readonly mergeable?: boolean | null;
  readonly mergeable_state?: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly head?: { readonly sha?: string; readonly ref?: string };
  readonly base?: { readonly sha?: string; readonly ref?: string };
  readonly merge_commit_sha?: string | null;
};
type GitHubPullRequestCommit = {
  readonly author?: { readonly login?: string; readonly type?: string } | null;
  readonly committer?: {
    readonly login?: string;
    readonly type?: string;
  } | null;
};
type GitHubCheckRun = {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly details_url?: string | null;
  readonly completed_at?: string | null;
};
type GitHubArtifact = {
  readonly id?: number;
  readonly name?: string;
  readonly digest?: string | null;
  readonly expired?: boolean;
  readonly size_in_bytes?: number;
  readonly workflow_run?: { readonly id?: number; readonly head_sha?: string };
};

const REQUIRED_PR_CI_EVIDENCE = {
  backend: {
    workflow: '.github/workflows/on-pull-request.yml',
    checkName: 'Build backend and API',
    gates: [
      'generated-files',
      'lint',
      'format',
      'backend-test-and-typecheck',
      'api-build',
      'pr-ci-policy-bundle'
    ]
  },
  frontend: {
    workflow: '.github/workflows/app-pr-ci.yml',
    checkName: 'Installed app checks',
    gates: [
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
  }
} as const;

const MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES = 128 * 1024;
const MAX_PR_CI_EVIDENCE_ENTRY_BYTES = 64 * 1024;

// Workflow changes cannot attest to their own trustworthiness. A reviewed
// control-plane PR must first preauthorize one exact old->new Git blob pair;
// only a later PR may use that new workflow. Remove consumed transitions after
// every repository's main has advanced past the authorized workflow.
const TRUSTED_PR_CI_WORKFLOW_TRANSITIONS: Readonly<
  Record<
    ReleaseBusV2Repository,
    readonly {
      readonly from: string;
      readonly to: string;
      readonly expiresAt: number;
    }[]
  >
> = {
  backend: [
    {
      from: '0cc8865dbb869b5156b46cc45e8581b259052916',
      to: 'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ],
  frontend: [
    {
      from: 'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c',
      to: '6fdbbd94f0d5fe8dfca93a96d5583ecc58f017da',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ]
};

const LEGACY_PR_CI_WORKFLOW_BLOBS: Readonly<
  Record<ReleaseBusV2Repository, string>
> = {
  backend: '0cc8865dbb869b5156b46cc45e8581b259052916',
  frontend: 'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c'
};

const BACKEND_PR_CI_GATE_POLICY_FILES = new Set([
  '.github/workflows/deploy.yml',
  '.github/workflows/on-pull-request.yml',
  '.github/workflows/release-bus-v2-preflight.yml',
  '.prettierignore',
  '.prettierrc',
  'eslint.config.mjs',
  'jest.config.ts',
  'scripts/assert-pr-ci-source-clean.mjs',
  'scripts/check-package-manager.mjs',
  'scripts/generate-deploy-config.mjs',
  'scripts/pr-ci-policy-bundle.cjs',
  'scripts/release-bus-backend-package-strategies.mjs',
  'scripts/release-bus-package-backend.mjs',
  'src/.prettierrc',
  'src/api-serverless/esbuild.config.mjs',
  'src/api-serverless/generate-openapi-routes.ts',
  'src/api-serverless/restructure-openapi.ts',
  'src/api-serverless/tsconfig.json',
  'src/api-serverless/tsconfig.paths.json',
  'src/config/deploy-services.json',
  'src/releaseBusV2/release-bus-v2-performance-workflow.test.ts',
  'src/tests/_setup/globalSetup.ts',
  'src/tests/_setup/globalTeardown.ts',
  'src/tests/_setup/perTestHooks.ts',
  'tsconfig.json'
]);

const BACKEND_PR_CI_PACKAGE_POLICY_FILES = new Set([
  'package.json',
  'src/api-serverless/package.json'
]);

type TrustedGatePolicyTransition = {
  readonly from: string | null;
  readonly to: string;
  readonly expiresAt: number;
};

const TRUSTED_BACKEND_PR_CI_GATE_POLICY_TRANSITIONS: Readonly<
  Record<string, readonly TrustedGatePolicyTransition[]>
> = {
  '.github/workflows/deploy.yml': [
    {
      from: '520395da44b53f27dd38d37e706baf8912936485',
      to: '3a4bc83abe629a2950edbd65a99d0b9c65aebb39',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ],
  'scripts/generate-deploy-config.mjs': [
    {
      from: 'a70486a49f592c9f03a5d456d6586abbe10ea790',
      to: '1e83afae874a5b2c9d377e45d75e275c0ac33af9',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ]
};

const BACKEND_PACKAGE_POLICY = {
  'package.json': {
    scriptKeys: [
      'build',
      'ci:assert-source-clean',
      'format:check',
      'generate:deploy-config',
      'lint:check',
      'postbuild',
      'prebuild',
      'pretest',
      'test'
    ],
    fieldKeys: [
      'packageManager',
      'dependencies.adm-zip',
      'devDependencies.@types/jest',
      'devDependencies.@typescript-eslint/parser',
      'devDependencies.esbuild',
      'devDependencies.eslint',
      'devDependencies.jest',
      'devDependencies.prettier',
      'devDependencies.ts-jest',
      'devDependencies.ts-node',
      'devDependencies.typescript',
      'devDependencies.typescript-eslint',
      'devDependencies.yaml'
    ]
  },
  'src/api-serverless/package.json': {
    scriptKeys: [
      'build',
      'generate',
      'generate:openapi',
      'postbuild',
      'prebuild',
      'restructure-openapi'
    ],
    fieldKeys: [
      'packageManager',
      'dependencies.adm-zip',
      'dependencies.@openapitools/openapi-generator-cli',
      'devDependencies.esbuild',
      'devDependencies.eslint',
      'devDependencies.ts-node',
      'devDependencies.typescript'
    ]
  }
} as const;

const FRONTEND_PR_CI_GATE_POLICY_FILES = new Set([
  '.github/6529bot.yml',
  '.github/workflows/app-pr-ci.yml',
  '.github/workflows/production-e2e.yml',
  '.github/workflows/release-bus-deploy-production.yml',
  '.github/workflows/release-bus-deploy-staging.yml',
  '.github/workflows/release-bus-v2-compose.yml',
  '.github/workflows/release-bus-v2-preflight.yml',
  '.github/workflows/staging-e2e.yml',
  '.prettierignore',
  '__tests__/scripts/dependency-risk-gate.test.ts',
  '__tests__/scripts/deployment-bus.test.ts',
  '__tests__/scripts/e2e-packs.test.ts',
  '__tests__/scripts/lint-package-json.test.ts',
  '__tests__/scripts/package-public-review-artifacts.test.ts',
  '__tests__/scripts/pr-ci-policy-bundle.test.ts',
  '__tests__/scripts/release-bus-artifact-compatibility.test.ts',
  '__tests__/scripts/release-bus-install-dependencies.test.ts',
  '__tests__/scripts/release-bus-performance-contract.test.ts',
  '__tests__/scripts/release-bus-v2-compose-workflow.test.ts',
  '__tests__/scripts/sync-agent-files.test.ts',
  '__tests__/scripts/sync-e2e-manifest.test.ts',
  '__tests__/scripts/sync-help-index.test.ts',
  '__tests__/scripts/testing-strategy.test.ts',
  'bin/6529',
  'config/env.schema.ts',
  'config/env.schema.validation.ts',
  'eslint.config.diff.mjs',
  'eslint.config.mjs',
  'eslint.config.single.mjs',
  'eslint.config.tight.mjs',
  'jest.config.js',
  'jest.setup.js',
  'knip.jsonc',
  'next-sitemap.build.cjs',
  'next.config.ts',
  'ops/deployment-bus/manifest.v1.schema.json',
  'ops/deployment-bus/release-bus-performance-contract.v1.json',
  'ops/scripts/deployment-bus.cjs',
  'ops/scripts/release-bus-status.mjs',
  'ops/scripts/release-bus-status.test.ts',
  'ops/scripts/testing-strategy.cjs',
  'ops/testing-strategy/mutation-endpoint-registry.json',
  'ops/testing-strategy/mutation-endpoint-registry.v1.schema.json',
  'ops/testing-strategy/validation-manifest.v1.schema.json',
  'playwright.config.ts',
  'prettier.config.mjs',
  'scripts/assert-no-package-lock.cjs',
  'scripts/build-env-schema.cjs',
  'scripts/dependency-risk-gate.cjs',
  'scripts/e2e-packs.cjs',
  'scripts/enforce-package-manager.cjs',
  'scripts/generate-openapi.cjs',
  'scripts/lint-package-json.cjs',
  'scripts/package-public-review-artifacts.cjs',
  'scripts/pr-ci-policy-bundle.cjs',
  'scripts/release-bus-install-dependencies.cjs',
  'scripts/require-6529-command.cjs',
  'scripts/run-secure-pnpm.cjs',
  'scripts/sync-agent-files.cjs',
  'scripts/sync-e2e-manifest.cjs',
  'scripts/sync-help-index.cjs',
  'scripts/typecheck-changed.cjs',
  'scripts/typecheck-test-baseline.json',
  'scripts/typecheck-test-ratchet.cjs',
  'tests/packs.manifest.cjs',
  'tsconfig.jest.json',
  'tsconfig.json',
  'tsconfig.playwright.json',
  'tsconfig.typecheck.json'
]);

const BACKEND_MODERN_ONLY_GATE_POLICY_FILES = new Set([
  'scripts/pr-ci-policy-bundle.cjs',
  'scripts/release-bus-backend-package-strategies.mjs',
  'scripts/release-bus-package-backend.mjs',
  'src/releaseBusV2/release-bus-v2-performance-workflow.test.ts'
]);

const FRONTEND_MODERN_ONLY_GATE_POLICY_FILES = new Set([
  '__tests__/scripts/release-bus-performance-contract.test.ts',
  'ops/deployment-bus/release-bus-performance-contract.v1.json',
  'scripts/pr-ci-policy-bundle.cjs'
]);

const FRONTEND_PACKAGE_POLICY = {
  'package.json': {
    scriptKeys: [
      'agent-files:sync',
      'base-build',
      'build',
      'build:env-schema',
      'deadcode:knip',
      'dependency:risk-gate',
      'dev',
      'e2e-manifest:check',
      'e2e:packs',
      'generate',
      'guard:no-package-lock',
      'help-index:sync',
      'install:secure:frozen',
      'lint:changed',
      'lint:package-json',
      'lint:quiet',
      'postbuild',
      'prebuild',
      'test:e2e:critical-shell',
      'test:e2e:production:admin-guards-readonly',
      'test:e2e:production:collections-readonly',
      'test:e2e:production:delegation-readonly',
      'test:e2e:production:media-readonly',
      'test:e2e:production:network-open-data-readonly',
      'test:e2e:production:profile-deep-links-readonly',
      'test:e2e:production:public-content-readonly',
      'test:e2e:production:public-groups-tools-readonly',
      'test:e2e:production:readonly',
      'test:e2e:production:search-waves-readonly',
      'test:e2e:production:social-readonly',
      'test:e2e:smoke',
      'test:e2e:staging',
      'test:e2e:staging:admin-guards-readonly',
      'test:e2e:staging:collections-readonly',
      'test:e2e:staging:delegation-readonly',
      'test:e2e:staging:input-detection-readonly',
      'test:e2e:staging:media-readonly',
      'test:e2e:staging:network-open-data-readonly',
      'test:e2e:staging:profile-deep-links-readonly',
      'test:e2e:staging:public-content-readonly',
      'test:e2e:staging:public-groups-tools-readonly',
      'test:e2e:staging:search-waves-readonly',
      'test:e2e:staging:smoke',
      'test:e2e:staging:social-readonly',
      'test:no-coverage',
      'testing-strategy',
      'typecheck:changed',
      'typecheck:jest',
      'typecheck:playwright',
      'typecheck:tests'
    ],
    fieldKeys: [
      'packageManager',
      'dependencies.cross-env',
      'dependencies.next',
      'dependencies.next-sitemap',
      'devDependencies.@jest/globals',
      'devDependencies.@playwright/test',
      'devDependencies.@types/jest',
      'devDependencies.babel-jest',
      'devDependencies.eslint',
      'devDependencies.eslint-config-next',
      'devDependencies.eslint-config-prettier',
      'devDependencies.eslint-plugin-diff',
      'devDependencies.eslint-plugin-import',
      'devDependencies.eslint-plugin-promise',
      'devDependencies.eslint-plugin-react-compiler',
      'devDependencies.eslint-plugin-react-hooks',
      'devDependencies.eslint-plugin-react-you-might-not-need-an-effect',
      'devDependencies.eslint-plugin-security',
      'devDependencies.eslint-plugin-sonarjs',
      'devDependencies.eslint-plugin-tailwindcss',
      'devDependencies.eslint-plugin-unused-imports',
      'devDependencies.jest',
      'devDependencies.jest-environment-jsdom',
      'devDependencies.knip',
      'devDependencies.playwright',
      'devDependencies.prettier',
      'devDependencies.ts-jest',
      'devDependencies.typescript',
      'devDependencies.typescript-eslint'
    ]
  }
} as const;

const TRUSTED_FRONTEND_PR_CI_GATE_POLICY_TRANSITIONS: Readonly<
  Record<string, readonly TrustedGatePolicyTransition[]>
> = {};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactStringList(
  actual: unknown,
  expected: readonly string[]
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function trustedWorkflowTransition(
  repository: ReleaseBusV2Repository,
  from: string,
  to: string
): boolean {
  if (from === to)
    return (
      from === LEGACY_PR_CI_WORKFLOW_BLOBS[repository] ||
      TRUSTED_PR_CI_WORKFLOW_TRANSITIONS[repository].some(
        (transition) => transition.to === from.toLowerCase()
      )
    );
  return TRUSTED_PR_CI_WORKFLOW_TRANSITIONS[repository].some(
    (transition) =>
      Date.now() <= transition.expiresAt &&
      transition.from === from.toLowerCase() &&
      transition.to === to.toLowerCase()
  );
}

const TRUSTED_PR_CI_GATE_POLICY_BUNDLE_TRANSITIONS: Readonly<
  Record<
    ReleaseBusV2Repository,
    readonly {
      readonly from: string;
      readonly to: string;
      readonly expiresAt: number;
    }[]
  >
> = {
  backend: [
    {
      from: '12ee0bd6c718124c80ce3cd9c09d1287677027cb653db0ffeab21af1cd785143',
      to: '89b2da6f3742cd9a3cf2ae7599084e442c742dd1f781133446a789b5a24c4195',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    },
    {
      from: '12ee0bd6c718124c80ce3cd9c09d1287677027cb653db0ffeab21af1cd785143',
      to: '890b4c9d976f66be52ff24fd0569f4d994515716822ac9f2dd42bcc22208af8c',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ],
  frontend: [
    {
      from: '57d9f94b108788cf3ed1e5f80156caf2d8b31974c375ec0b353e607e2e74b4d8',
      to: 'ddd9afbff8b7de02ee1fb86395a7f3cde4485b408073d34e1532fa29c30f4fab',
      expiresAt: Date.UTC(2026, 7, 31, 23, 59, 59)
    }
  ]
};

function trustedGatePolicyBundleTransition(
  repository: ReleaseBusV2Repository,
  from: string,
  to: string
): boolean {
  return (
    from === to ||
    TRUSTED_PR_CI_GATE_POLICY_BUNDLE_TRANSITIONS[repository].some(
      (transition) =>
        Date.now() <= transition.expiresAt &&
        transition.from === from &&
        transition.to === to
    )
  );
}

function trustedGatePolicyPathTransition(
  repository: ReleaseBusV2Repository,
  path: string,
  from: string | null,
  to: string | null
): boolean {
  if (from === to) return true;
  const transitions =
    repository === 'backend'
      ? TRUSTED_BACKEND_PR_CI_GATE_POLICY_TRANSITIONS[path]
      : TRUSTED_FRONTEND_PR_CI_GATE_POLICY_TRANSITIONS[path];
  return Boolean(
    transitions?.some(
      (transition) =>
        Date.now() <= transition.expiresAt &&
        transition.from === from &&
        transition.to === to
    )
  );
}

function readPackageString(
  manifest: Record<string, unknown>,
  dottedKey: string
): string | null {
  let value: unknown = manifest;
  for (const segment of dottedKey.split('.')) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    )
      return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parsePackageDocument(
  repository: ReleaseBusV2Repository,
  path: string,
  contents: Buffer
): Record<string, unknown> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(contents.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${repository} PR CI gate policy ${path} is not valid JSON`
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(
      `${repository} PR CI gate policy ${path} is not a JSON object`
    );
  return manifest;
}

function packagePolicyLines(
  repository: ReleaseBusV2Repository,
  path: string,
  contents: Buffer,
  modern: boolean
): string[] {
  const manifest = parsePackageDocument(repository, path, contents);
  const expectedPackageManager =
    repository === 'backend' ? 'npm@10.9.8' : 'pnpm@10.33.0';
  if (readPackageString(manifest, 'packageManager') !== expectedPackageManager)
    throw new Error(
      `${repository} PR CI gate policy ${path} must pin ${expectedPackageManager}`
    );
  const policy =
    repository === 'backend'
      ? BACKEND_PACKAGE_POLICY[path as keyof typeof BACKEND_PACKAGE_POLICY]
      : FRONTEND_PACKAGE_POLICY['package.json'];
  if (!policy)
    throw new Error(`${repository} PR CI package policy path is not trusted`);
  const scripts =
    manifest.scripts &&
    typeof manifest.scripts === 'object' &&
    !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const lines: string[] = [];
  for (const key of policy.scriptKeys) {
    const value = scripts[key];
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(
        `${repository} PR CI gate policy ${path} has no required script ${key}`
      );
    lines.push(
      `package-script\t${repository === 'frontend' ? key : `${path}#${key}`}\t${JSON.stringify(value)}\n`
    );
  }
  for (const key of policy.fieldKeys) {
    const value = readPackageString(manifest, key);
    if (!value) {
      if (
        !modern &&
        repository === 'backend' &&
        ((path === 'package.json' &&
          [
            'dependencies.adm-zip',
            'devDependencies.jest',
            'devDependencies.yaml'
          ].includes(key)) ||
          (path === 'src/api-serverless/package.json' &&
            key === 'dependencies.adm-zip'))
      )
        continue;
      throw new Error(
        `${repository} PR CI gate policy ${path} has no required package field ${key}`
      );
    }
    lines.push(
      `package-field\t${repository === 'frontend' ? key : `${path}#${key}`}\t${JSON.stringify(value)}\n`
    );
  }
  return lines;
}

function bytewiseSort(values: string[]): string[] {
  return values.sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  );
}

function assertSafePolicyPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    /[\t\r\n\0]/.test(path)
  )
    throw new Error(`PR CI gate policy has unsafe repository path ${path}`);
}

export function releaseBusPrCiPolicyInventory(
  repository: ReleaseBusV2Repository,
  modern: boolean
): {
  readonly paths: readonly string[];
  readonly packages: readonly {
    readonly path: string;
    readonly scriptKeys: readonly string[];
    readonly fieldKeys: readonly string[];
  }[];
} {
  const allPaths =
    repository === 'backend'
      ? new Set([
          ...Array.from(BACKEND_PR_CI_GATE_POLICY_FILES),
          ...Array.from(BACKEND_PR_CI_PACKAGE_POLICY_FILES)
        ])
      : new Set([
          ...Array.from(FRONTEND_PR_CI_GATE_POLICY_FILES),
          'package.json'
        ]);
  const modernOnly =
    repository === 'backend'
      ? BACKEND_MODERN_ONLY_GATE_POLICY_FILES
      : FRONTEND_MODERN_ONLY_GATE_POLICY_FILES;
  const policy =
    repository === 'backend' ? BACKEND_PACKAGE_POLICY : FRONTEND_PACKAGE_POLICY;
  return {
    paths: Array.from(allPaths)
      .filter((path) => modern || !modernOnly.has(path))
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right))
      ),
    packages: Object.entries(policy).map(([path, value]) => ({
      path,
      scriptKeys: [...value.scriptKeys],
      fieldKeys: [...value.fieldKeys]
    }))
  };
}

async function boundedResponseBuffer(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
  )
    throw new Error('Pull request CI evidence archive exceeds the size limit');
  if (!response.body)
    throw new Error('Pull request CI evidence archive is empty');

  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > maxBytes)
      throw new Error(
        'Pull request CI evidence archive exceeds the size limit'
      );
    return Buffer.from(response.body);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response.body as unknown as AsyncIterable<
    Buffer | Uint8Array | string
  >) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      (
        response.body as unknown as {
          destroy?: () => void;
        }
      ).destroy?.();
      throw new Error(
        'Pull request CI evidence archive exceeds the size limit'
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

const REPOSITORIES: Readonly<Record<ReleaseBusV2Repository, string>> = {
  frontend: '6529seize-frontend',
  backend: '6529seize-backend'
};
const MAX_WORKFLOW_JOBS = 100;
const MAX_WORKFLOW_STEPS = 100;
const MAX_WORKFLOW_LABEL_LENGTH = 500;
const MAX_STAGING_FENCE_PAGES = 10;
const MAX_PULL_REQUEST_COMMIT_PAGES = 3;
const GITHUB_PAGE_SIZE = 100;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PR_CI_GATE_POLICY_FILES = 96;
const MAX_PR_CI_GATE_POLICY_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PR_CI_GATE_POLICY_CANONICAL_BYTES = 64 * 1024;
const MAX_PR_CI_GATE_POLICY_PACKAGE_BYTES = 512 * 1024;
const PR_CI_POLICY_BUNDLE_CONTRACT = 'pr-ci-policy-bundle-v1';

export class ReleaseBusGitHubInfrastructureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseBusGitHubInfrastructureError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isInfrastructureStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSecondaryRateLimit(response: Response): boolean {
  return (
    response.status === 403 &&
    (response.headers.has('retry-after') ||
      response.headers.get('x-ratelimit-remaining') === '0')
  );
}

export function safeGitHubWorkflowLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized ? sanitized.slice(0, MAX_WORKFLOW_LABEL_LENGTH) : null;
}

export function sanitizeGitHubWorkflowJobs(
  jobs: readonly GitHubWorkflowJob[]
): GitHubWorkflowJob[] {
  return jobs.slice(0, MAX_WORKFLOW_JOBS).map((job) => ({
    ...job,
    name: safeGitHubWorkflowLabel(job.name) ?? 'Unnamed workflow job',
    steps: job.steps?.slice(0, MAX_WORKFLOW_STEPS).map((step) => ({
      ...step,
      name: safeGitHubWorkflowLabel(step.name) ?? 'Unnamed workflow step'
    }))
  }));
}

export function releaseBusPullRequestMergeStateEligible(
  mergeable: boolean | null | undefined,
  mergeableState: string | undefined
): boolean {
  if (mergeable === false) return false;
  if (['clean', 'unstable', 'behind'].includes(mergeableState ?? ''))
    return true;
  // The Release Bus GitHub App is a ruleset bypass actor. Production v2 also
  // needs `always` bypass mode so it can non-force fast-forward the exact
  // staging-validated commit instead of manufacturing a different PR merge
  // commit. Human/team bypass actors remain pull-request-only.
  // GitHub still reports `blocked` for maintainer-review requirements, so only
  // accept that state when the merge tree itself is explicitly mergeable. The
  // exact merge-tree checks are independently required below.
  return mergeable === true && mergeableState === 'blocked';
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

function assertAllowedWritableRef(ref: string): void {
  if (
    ref === 'main' ||
    ref === '1a-staging' ||
    /^release-bus-v2\/(staging|production|qualification|rollback)-train-[A-Za-z0-9._-]+$/.test(
      ref
    )
  )
    return;
  throw new Error(`Release Bus GitHub App cannot write ref ${ref}`);
}

export class ReleaseBusGitHubApp {
  private readonly logger = Logger.get(this.constructor.name);
  private cachedToken: {
    readonly value: string;
    readonly expiresAt: number;
  } | null = null;

  public constructor(
    private readonly requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS
  ) {}

  private get owner(): string {
    return process.env.RELEASE_BUS_GITHUB_ORG ?? '6529-Collections';
  }

  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000)
      return this.cachedToken.value;
    const appId = process.env.RELEASE_BUS_GITHUB_APP_ID;
    const installationId = process.env.RELEASE_BUS_GITHUB_INSTALLATION_ID;
    const privateKey = process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY?.replace(
      /\\n/g,
      '\n'
    );
    if (!appId || !installationId || !privateKey)
      throw new Error('GitHub App credentials are not configured');
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: 'POST',
          headers: this.headers(appJwt(appId, privateKey))
        }
      );
    } catch (error) {
      if (error instanceof ReleaseBusGitHubInfrastructureError) throw error;
      throw new ReleaseBusGitHubInfrastructureError(
        'GitHub App token request failed before a response was received'
      );
    }
    await this.assertOk(response, 'create GitHub App installation token');
    const payload = (await response.json()) as InstallationToken;
    this.cachedToken = {
      value: payload.token,
      expiresAt: Date.parse(payload.expires_at)
    };
    return payload.token;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': '6529-release-bus',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: GitHubRequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    timeoutId.unref();

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal as RequestInit['signal']
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ReleaseBusGitHubInfrastructureError(
          `GitHub request timed out after ${this.requestTimeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request(
    repository: ReleaseBusV2Repository,
    path: string,
    options: GitHubRequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetchWithTimeout(
        `https://api.github.com/repos/${this.owner}/${REPOSITORIES[repository]}${path}`,
        {
          ...options,
          headers: { ...this.headers(token), ...(options.headers ?? {}) }
        }
      );
    } catch (error) {
      if (error instanceof ReleaseBusGitHubInfrastructureError) throw error;
      throw new ReleaseBusGitHubInfrastructureError(
        `GitHub ${repository} request failed before a response was received`
      );
    }
  }

  private async organizationRequest(
    path: string,
    options: GitHubRequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetchWithTimeout(`https://api.github.com${path}`, {
        ...options,
        headers: { ...this.headers(token), ...(options.headers ?? {}) }
      });
    } catch (error) {
      if (error instanceof ReleaseBusGitHubInfrastructureError) throw error;
      throw new ReleaseBusGitHubInfrastructureError(
        'GitHub organization request failed before a response was received'
      );
    }
  }

  private async assertOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    let message = `${response.status} ${response.statusText}`;
    try {
      message =
        ((await response.json()) as { message?: string }).message ?? message;
    } catch {
      /* redacted status is enough */
    }
    const errorMessage = `Failed to ${operation}: ${message}`;
    if (
      isInfrastructureStatus(response.status) ||
      isSecondaryRateLimit(response)
    )
      throw new ReleaseBusGitHubInfrastructureError(errorMessage);
    throw new Error(errorMessage);
  }

  public async resolveRef(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<string> {
    const response = await this.request(
      repository,
      `/git/ref/heads/${encodeURIComponent(ref)}`
    );
    await this.assertOk(response, `resolve ${repository} ref ${ref}`);
    const sha = ((await response.json()) as GitHubRef).object?.sha;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha))
      throw new Error(`Invalid SHA returned for ${repository}:${ref}`);
    return sha.toLowerCase();
  }

  public async getPullRequestQualification(
    repository: ReleaseBusV2Repository,
    pullNumber: number,
    expectedHeadSha: string
  ): Promise<{
    readonly baseSha: string;
    readonly mergeSha: string;
    readonly checksRunId: string;
    readonly checksCompletedAt: number;
    readonly artifactRunId: string | null;
    readonly artifactName: string | null;
    readonly artifactDigest: string | null;
    readonly workflowPath: string;
    readonly baseWorkflowBlobSha: string;
    readonly mergeWorkflowBlobSha: string;
    readonly baseGatePolicyDigest: string;
    readonly mergeGatePolicyDigest: string;
    readonly trustMode: 'evidence-manifest-v1' | 'legacy-exact-workflow-v0';
    readonly contributorGithubLogins: readonly string[];
  }> {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
      throw new Error('Invalid pull request number');
    const response = await this.request(repository, `/pulls/${pullNumber}`);
    await this.assertOk(
      response,
      `read ${repository} pull request ${pullNumber}`
    );
    const pull = (await response.json()) as GitHubPullRequestDetails;
    const headSha = pull.head?.sha?.toLowerCase();
    const baseSha = pull.base?.sha?.toLowerCase();
    const mergeSha = pull.merge_commit_sha?.toLowerCase();
    if (pull.state !== 'open' || headSha !== expectedHeadSha.toLowerCase())
      throw new Error(
        'Pull request is not open at the exact requested head SHA'
      );
    if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha))
      throw new Error('Pull request has no valid base SHA');
    if (!mergeSha || !/^[a-f0-9]{40}$/.test(mergeSha))
      throw new Error('Pull request has no exact merge-tree SHA');
    if (
      !releaseBusPullRequestMergeStateEligible(
        pull.mergeable,
        pull.mergeable_state
      )
    )
      throw new Error(
        `Pull request is not eligible against its current base (${pull.mergeable_state ?? 'unknown'}); required checks or mergeability are unresolved`
      );

    const checksResponse = await this.request(
      repository,
      `/commits/${headSha}/check-runs?per_page=100`
    );
    await this.assertOk(
      checksResponse,
      `read ${repository} pull request checks`
    );
    const checks =
      ((await checksResponse.json()) as { check_runs?: GitHubCheckRun[] })
        .check_runs ?? [];
    if (checks.length === 0)
      throw new Error('Pull request head has no check evidence');
    const incomplete = checks.filter((check) => check.status !== 'completed');
    if (incomplete.length > 0)
      throw new Error(
        `Pull request checks are still running: ${incomplete.map((check) => check.name ?? 'unnamed').join(', ')}`
      );
    const allowedConclusions = new Set(['success', 'neutral', 'skipped']);
    const failed = checks.filter(
      (check) => !check.conclusion || !allowedConclusions.has(check.conclusion)
    );
    if (failed.length > 0)
      throw new Error(
        `Pull request checks are not green: ${failed.map((check) => check.name ?? 'unnamed').join(', ')}`
      );
    const completedAt = Math.max(
      ...checks
        .map((check) => Date.parse(check.completed_at ?? ''))
        .filter(Number.isFinite)
    );
    const checksRunId =
      checks
        .map((check) => check.details_url ?? '')
        .map((url) => /\/actions\/runs\/(\d+)/.exec(url)?.[1])
        .find((id): id is string => Boolean(id)) ??
      String(checks[0]?.id ?? '0');
    const greenWorkflowRunIds = new Set(
      checks
        .map((check) => check.details_url ?? '')
        .map((url) => /\/actions\/runs\/(\d+)/.exec(url)?.[1])
        .filter((id): id is string => Boolean(id))
    );
    const evidenceContract = REQUIRED_PR_CI_EVIDENCE[repository];
    const evidenceCheck = checks.find((check) => {
      const runId = /\/actions\/runs\/(\d+)/.exec(check.details_url ?? '')?.[1];
      return (
        check.name === evidenceContract.checkName &&
        runId !== undefined &&
        greenWorkflowRunIds.has(runId)
      );
    });
    if (!evidenceCheck)
      throw new Error(
        'Pull request does not include the required exact-head PR CI check'
      );
    const evidenceRunId = /\/actions\/runs\/(\d+)/.exec(
      evidenceCheck.details_url ?? ''
    )?.[1];
    if (!evidenceRunId)
      throw new Error(
        'Pull request exact-head PR CI check has no workflow run identity'
      );

    const artifactsResponse = await this.request(
      repository,
      `/actions/artifacts?name=${encodeURIComponent(`release-bus-v2-pr-${mergeSha}`)}&per_page=100`
    );
    await this.assertOk(
      artifactsResponse,
      `read ${repository} pull request artifacts`
    );
    const artifact = (
      ((await artifactsResponse.json()) as { artifacts?: GitHubArtifact[] })
        .artifacts ?? []
    )
      .filter(
        (item) =>
          !item.expired &&
          item.name === `release-bus-v2-pr-${mergeSha}` &&
          item.workflow_run?.head_sha?.toLowerCase() ===
            expectedHeadSha.toLowerCase() &&
          String(item.workflow_run?.id ?? '') === evidenceRunId &&
          /^sha256:[a-f0-9]{64}$/.test(item.digest ?? '')
      )
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0];
    const evidenceRunResponse = await this.request(
      repository,
      `/actions/runs/${evidenceRunId}`
    );
    await this.assertOk(
      evidenceRunResponse,
      `read ${repository} pull request CI evidence workflow`
    );
    const evidenceRun = (await evidenceRunResponse.json()) as GitHubRun;
    const expectedWorkflowPath = evidenceContract.workflow;
    if (
      evidenceRun.event !== 'pull_request' ||
      evidenceRun.status !== 'completed' ||
      evidenceRun.conclusion !== 'success' ||
      evidenceRun.head_sha.toLowerCase() !== expectedHeadSha.toLowerCase() ||
      (evidenceRun.path !== expectedWorkflowPath &&
        !evidenceRun.path?.startsWith(`${expectedWorkflowPath}@`))
    )
      throw new Error(
        'Pull request CI evidence is not from the required exact-head workflow'
      );
    const [baseWorkflow, mergeWorkflow] = await Promise.all([
      this.getContentIdentity(repository, expectedWorkflowPath, baseSha),
      this.getContentIdentity(repository, expectedWorkflowPath, mergeSha)
    ]);
    if (
      !trustedWorkflowTransition(
        repository,
        baseWorkflow.sha,
        mergeWorkflow.sha
      )
    )
      throw new Error(
        'Pull request changes its own trusted PR CI evidence workflow without an exact preauthorized blob transition'
      );
    const legacyExactWorkflow =
      baseWorkflow.sha === LEGACY_PR_CI_WORKFLOW_BLOBS[repository] &&
      mergeWorkflow.sha === LEGACY_PR_CI_WORKFLOW_BLOBS[repository];
    const trustMode = legacyExactWorkflow
      ? 'legacy-exact-workflow-v0'
      : 'evidence-manifest-v1';
    const gatePolicy = await this.validatePullRequestCiGatePolicyClosure(
      repository,
      baseSha,
      mergeSha,
      {
        path: expectedWorkflowPath,
        baseBlobSha: baseWorkflow.sha,
        mergeBlobSha: mergeWorkflow.sha
      }
    );
    if (!legacyExactWorkflow) {
      if (
        !artifact?.workflow_run?.id ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        Number(artifact.size_in_bytes) < 1 ||
        Number(artifact.size_in_bytes) > MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES
      )
        throw new Error(
          'Pull request has no bounded exact green merge-tree CI evidence artifact'
        );
      await this.validatePullRequestCiEvidenceArtifact(repository, artifact, {
        headSha,
        mergeSha,
        workflow: expectedWorkflowPath,
        gates: evidenceContract.gates,
        policyBundle: gatePolicy.merge
      });
    }
    const contributorGithubLogins =
      await this.getPullRequestContributorGithubLogins(
        repository,
        pullNumber,
        pull
      );
    return {
      baseSha,
      mergeSha,
      checksRunId,
      checksCompletedAt: Number.isFinite(completedAt)
        ? completedAt
        : Date.now(),
      artifactRunId: artifact?.workflow_run?.id
        ? String(artifact.workflow_run.id)
        : null,
      artifactName: artifact?.name ?? null,
      artifactDigest: artifact?.digest?.replace(/^sha256:/, '') ?? null,
      workflowPath: expectedWorkflowPath,
      baseWorkflowBlobSha: baseWorkflow.sha,
      mergeWorkflowBlobSha: mergeWorkflow.sha,
      baseGatePolicyDigest: gatePolicy.base.digest,
      mergeGatePolicyDigest: gatePolicy.merge.digest,
      trustMode,
      contributorGithubLogins
    };
  }

  private async getContentIdentity(
    repository: ReleaseBusV2Repository,
    filePath: string,
    ref: string
  ): Promise<{ readonly sha: string }> {
    const response = await this.request(
      repository,
      `/contents/${filePath}?ref=${encodeURIComponent(ref)}`
    );
    await this.assertOk(
      response,
      `read trusted ${repository} workflow at ${ref}`
    );
    const identity = (await response.json()) as GitHubContentsIdentity;
    if (
      identity.type !== 'file' ||
      !identity.sha ||
      !/^[a-f0-9]{40}$/i.test(identity.sha)
    )
      throw new Error('Trusted PR CI workflow has no exact blob identity');
    return { sha: identity.sha.toLowerCase() };
  }

  private async validatePullRequestCiGatePolicyClosure(
    repository: ReleaseBusV2Repository,
    baseSha: string,
    mergeSha: string,
    workflow: {
      readonly path: string;
      readonly baseBlobSha: string;
      readonly mergeBlobSha: string;
    }
  ): Promise<{
    readonly base: {
      readonly bytes: Buffer;
      readonly digest: string;
      readonly lineCount: number;
    };
    readonly merge: {
      readonly bytes: Buffer;
      readonly digest: string;
      readonly lineCount: number;
    };
  }> {
    const baseModern =
      workflow.baseBlobSha !== LEGACY_PR_CI_WORKFLOW_BLOBS[repository];
    const mergeModern =
      workflow.mergeBlobSha !== LEGACY_PR_CI_WORKFLOW_BLOBS[repository];
    const [baseTree, mergeTree] = await Promise.all([
      this.getBoundedPolicyTree(repository, baseSha),
      this.getBoundedPolicyTree(repository, mergeSha)
    ]);
    const baseInventory = releaseBusPrCiPolicyInventory(repository, baseModern);
    const mergeInventory = releaseBusPrCiPolicyInventory(
      repository,
      mergeModern
    );
    const basePaths = [...baseInventory.paths];
    const mergePaths = [...mergeInventory.paths];
    for (const [label, paths, tree] of [
      ['base', basePaths, baseTree] as const,
      ['merge', mergePaths, mergeTree] as const
    ]) {
      if (paths.length > MAX_PR_CI_GATE_POLICY_FILES)
        throw new Error(
          `${repository} PR CI gate policy ${label} file inventory is too large`
        );
      let totalBytes = 0;
      for (const path of paths) {
        assertSafePolicyPath(path);
        const entry = tree.get(path);
        if (!entry)
          throw new Error(
            `${repository} PR CI gate policy ${label} is missing required path ${path}`
          );
        totalBytes += entry.size;
      }
      if (totalBytes > MAX_PR_CI_GATE_POLICY_SOURCE_BYTES)
        throw new Error(
          `${repository} PR CI gate policy ${label} source is too large`
        );
    }
    const packagePaths = mergeInventory.packages.map(({ path }) => path);
    const packageBlobShas = new Set<string>();
    for (const path of packagePaths) {
      const baseEntry = baseTree.get(path);
      const mergeEntry = mergeTree.get(path);
      if (baseEntry) packageBlobShas.add(baseEntry.sha);
      if (mergeEntry) packageBlobShas.add(mergeEntry.sha);
    }
    const packageDocuments = new Map<string, Buffer>();
    await Promise.all(
      Array.from(packageBlobShas).map(async (blobSha) => {
        packageDocuments.set(
          blobSha,
          await this.getBoundedGitBlob(repository, blobSha)
        );
      })
    );
    const buildBundle = (
      paths: readonly string[],
      tree: ReadonlyMap<
        string,
        { readonly sha: string; readonly size: number }
      >,
      modern: boolean
    ) => {
      const lines: string[] = [];
      for (const path of paths) {
        const entry = tree.get(path);
        if (!entry)
          throw new Error(
            `${repository} PR CI gate policy is missing required path ${path}`
          );
        if (packagePaths.includes(path)) {
          const contents = packageDocuments.get(entry.sha);
          if (!contents)
            throw new Error(
              `${repository} PR CI gate policy package content is unavailable`
            );
          lines.push(...packagePolicyLines(repository, path, contents, modern));
        } else {
          lines.push(`file\t${path}\t${entry.sha}\n`);
        }
      }
      if (modern)
        lines.push(`runtime-pin\tnode\t${JSON.stringify('22.17.1')}\n`);
      const bytes = Buffer.from(bytewiseSort(lines).join(''), 'utf8');
      if (bytes.length > MAX_PR_CI_GATE_POLICY_CANONICAL_BYTES)
        throw new Error(
          `${repository} PR CI gate policy canonical bundle is too large`
        );
      return {
        bytes,
        digest: sha256(bytes),
        lineCount: lines.length
      };
    };
    const base = buildBundle(basePaths, baseTree, baseModern);
    const merge = buildBundle(mergePaths, mergeTree, mergeModern);
    if (
      !trustedGatePolicyBundleTransition(repository, base.digest, merge.digest)
    )
      throw new Error(
        `${repository} PR CI gate policy bundle changed without an exact preauthorized transition`
      );
    const transitionPaths = new Set([...basePaths, ...mergePaths]);
    for (const path of Array.from(transitionPaths)) {
      if (packagePaths.includes(path)) continue;
      const from = baseTree.get(path)?.sha ?? null;
      const to = mergeTree.get(path)?.sha ?? null;
      if (
        path === workflow.path
          ? !(from && to && trustedWorkflowTransition(repository, from, to))
          : !trustedGatePolicyPathTransition(repository, path, from, to)
      )
        throw new Error(
          `${repository} PR CI gate policy ${path} changed without an exact preauthorized blob transition`
        );
    }
    return { base, merge };
  }

  private async getBoundedPolicyTree(
    repository: ReleaseBusV2Repository,
    commitSha: string
  ): Promise<
    ReadonlyMap<string, { readonly sha: string; readonly size: number }>
  > {
    const commitResponse = await this.request(
      repository,
      `/git/commits/${commitSha}`
    );
    await this.assertOk(
      commitResponse,
      `read ${repository} PR CI gate policy commit`
    );
    const treeSha = ((await commitResponse.json()) as GitHubGitCommit).tree
      ?.sha;
    if (!treeSha || !/^[a-f0-9]{40}$/i.test(treeSha))
      throw new Error(
        `${repository} PR CI gate policy commit has no exact tree`
      );
    const treeResponse = await this.request(
      repository,
      `/git/trees/${treeSha}?recursive=1`
    );
    await this.assertOk(
      treeResponse,
      `read ${repository} PR CI gate policy tree`
    );
    const payload = (await treeResponse.json()) as GitHubGitTree;
    if (payload.truncated !== false || !Array.isArray(payload.tree))
      throw new Error(
        `${repository} PR CI gate policy tree is truncated or malformed`
      );
    const result = new Map<
      string,
      { readonly sha: string; readonly size: number }
    >();
    for (const entry of payload.tree) {
      if (entry.type !== 'blob') continue;
      if (
        !entry.path ||
        !entry.sha ||
        !/^[a-f0-9]{40}$/i.test(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0
      )
        throw new Error(
          `${repository} PR CI gate policy tree has malformed blob identity`
        );
      assertSafePolicyPath(entry.path);
      if (result.has(entry.path))
        throw new Error(
          `${repository} PR CI gate policy tree has duplicate path ${entry.path}`
        );
      result.set(entry.path, {
        sha: entry.sha.toLowerCase(),
        size: Number(entry.size)
      });
    }
    return result;
  }

  private async getBoundedGitBlob(
    repository: ReleaseBusV2Repository,
    blobSha: string
  ): Promise<Buffer> {
    const response = await this.request(repository, `/git/blobs/${blobSha}`);
    await this.assertOk(response, `read ${repository} PR CI package policy`);
    const blob = (await response.json()) as GitHubGitBlob;
    if (
      blob.sha?.toLowerCase() !== blobSha ||
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string' ||
      !Number.isSafeInteger(blob.size) ||
      Number(blob.size) < 1 ||
      Number(blob.size) > MAX_PR_CI_GATE_POLICY_PACKAGE_BYTES
    )
      throw new Error(
        `${repository} PR CI package policy has no bounded exact blob`
      );
    const encoded = blob.content.replace(/\s+/g, '');
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new Error(
        `${repository} PR CI package policy blob encoding is invalid`
      );
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.length !== blob.size ||
      bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
    )
      throw new Error(
        `${repository} PR CI package policy blob content is invalid`
      );
    return bytes;
  }

  private async validatePullRequestCiEvidenceArtifact(
    repository: ReleaseBusV2Repository,
    artifact: GitHubArtifact,
    expected: {
      readonly headSha: string;
      readonly mergeSha: string;
      readonly workflow: string;
      readonly gates: readonly string[];
      readonly policyBundle: {
        readonly bytes: Buffer;
        readonly digest: string;
        readonly lineCount: number;
      };
    }
  ): Promise<void> {
    if (!artifact.id)
      throw new Error('Pull request CI evidence artifact has no exact id');
    const response = await this.request(
      repository,
      `/actions/artifacts/${artifact.id}/zip`
    );
    await this.assertOk(response, `download ${repository} PR CI evidence`);
    const archive = new AdmZip(
      await boundedResponseBuffer(response, MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES)
    );
    const entries = archive.getEntries();
    if (
      entries.length !== 3 ||
      entries.some(({ isDirectory }) => isDirectory) ||
      !exactStringList(
        entries
          .map(({ entryName }) => entryName)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        ['SHA256SUMS', 'manifest.json', 'policy-bundle.txt']
      )
    )
      throw new Error('Pull request CI evidence archive has unexpected files');
    if (
      entries.some(
        ({ header }) =>
          !Number.isSafeInteger(header.size) ||
          header.size <= 0 ||
          header.size > MAX_PR_CI_EVIDENCE_ENTRY_BYTES ||
          !Number.isSafeInteger(header.compressedSize) ||
          header.compressedSize <= 0 ||
          header.compressedSize > MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES
      ) ||
      entries.reduce((sum, { header }) => sum + header.size, 0) >
        MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES ||
      entries.reduce((sum, { header }) => sum + header.compressedSize, 0) >
        MAX_PR_CI_EVIDENCE_ARCHIVE_BYTES
    )
      throw new Error(
        'Pull request CI evidence archive expands beyond the size limit'
      );
    const extractedEntries = new Map(
      entries.map((entry) => {
        const bytes = entry.getData();
        if (bytes.length !== entry.header.size)
          throw new Error(
            'Pull request CI evidence archive entry size is invalid'
          );
        return [entry.entryName, bytes] as const;
      })
    );
    const manifestBytes = extractedEntries.get('manifest.json');
    const sumsBytes = extractedEntries.get('SHA256SUMS');
    const policyBundleBytes = extractedEntries.get('policy-bundle.txt');
    if (!manifestBytes || !policyBundleBytes || !sumsBytes)
      throw new Error('Pull request CI evidence archive is incomplete');
    const expectedSums = `${sha256(manifestBytes)}  ./manifest.json\n${sha256(policyBundleBytes)}  ./policy-bundle.txt\n`;
    if (sumsBytes.toString('utf8') !== expectedSums)
      throw new Error('Pull request CI evidence checksum is invalid');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new Error('Pull request CI evidence manifest is invalid JSON');
    }
    if (
      manifest.schema_version !== 1 ||
      manifest.evidence_contract !== 'exact-merge-tree-pr-ci-v1' ||
      manifest.repository !== repository ||
      manifest.head_sha !== expected.headSha ||
      manifest.merge_sha !== expected.mergeSha ||
      manifest.workflow !== expected.workflow ||
      manifest.policy_bundle_contract !== PR_CI_POLICY_BUNDLE_CONTRACT ||
      manifest.policy_bundle_digest !== expected.policyBundle.digest ||
      manifest.policy_bundle_line_count !== expected.policyBundle.lineCount ||
      !exactStringList(manifest.required_gates, expected.gates)
    )
      throw new Error(
        'Pull request CI evidence manifest does not bind the exact head, merge tree, workflow, and gates'
      );
    if (!policyBundleBytes.equals(expected.policyBundle.bytes))
      throw new Error(
        'Pull request CI evidence policy bundle does not match the independently verified merge tree'
      );
  }

  private async getPullRequestContributorGithubLogins(
    repository: ReleaseBusV2Repository,
    pullNumber: number,
    pull: GitHubPullRequestDetails
  ): Promise<readonly string[]> {
    const logins: string[] = [];
    const addUser = (
      value:
        { readonly login?: string; readonly type?: string } | null | undefined
    ) => {
      const login = value?.login?.trim();
      const type = value?.type?.trim().toLowerCase();
      if (
        !login ||
        type !== 'user' ||
        !isHumanGithubContributorLogin(login) ||
        isReleaseBusGitHubAppActor(login)
      )
        return;
      if (
        logins.some(
          (candidate) => candidate.toLowerCase() === login.toLowerCase()
        )
      )
        return;
      logins.push(login);
    };
    addUser(pull.user);
    try {
      for (let page = 1; page <= MAX_PULL_REQUEST_COMMIT_PAGES; page += 1) {
        const response = await this.request(
          repository,
          `/pulls/${pullNumber}/commits?per_page=${GITHUB_PAGE_SIZE}&page=${page}`
        );
        await this.assertOk(
          response,
          `read ${repository} pull request ${pullNumber} commits`
        );
        const commits = (await response.json()) as GitHubPullRequestCommit[];
        if (!Array.isArray(commits))
          throw new Error(
            `Invalid ${repository} pull request ${pullNumber} commits response`
          );
        for (const commit of commits) {
          addUser(commit.author);
          addUser(commit.committer);
        }
        if (commits.length < GITHUB_PAGE_SIZE) break;
        if (page === MAX_PULL_REQUEST_COMMIT_PAGES) {
          this.logger.warn(
            `Contributor scan for ${repository} pull request ${pullNumber} reached ${MAX_PULL_REQUEST_COMMIT_PAGES * GITHUB_PAGE_SIZE} commits; using the contributors collected so far`
          );
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Contributor scan for ${repository} pull request ${pullNumber} failed; using the contributors collected so far: ${reason}`
      );
    }
    return logins;
  }

  public async resolveRefIfExists(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<string | null> {
    const response = await this.request(
      repository,
      `/git/ref/heads/${encodeURIComponent(ref)}`
    );
    if (response.status === 404) return null;
    await this.assertOk(response, `resolve ${repository} ref ${ref}`);
    const sha = ((await response.json()) as GitHubRef).object?.sha;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha))
      throw new Error(`Invalid SHA returned for ${repository}:${ref}`);
    return sha.toLowerCase();
  }

  public async createRef(
    repository: ReleaseBusV2Repository,
    ref: string,
    sha: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    const response = await this.request(repository, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${ref}`, sha })
    });
    if (
      response.status === 422 &&
      (await this.resolveRef(repository, ref)) === sha
    )
      return;
    await this.assertOk(response, `create ${repository} ref ${ref}`);
  }

  public async updateRef(
    repository: ReleaseBusV2Repository,
    ref: string,
    expectedOldSha: string,
    newSha: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    const current = await this.resolveRef(repository, ref);
    if (current === newSha) return;
    if (current !== expectedOldSha)
      throw new Error(
        `${repository}:${ref} moved from expected ${expectedOldSha} to ${current}`
      );
    const response = await this.request(
      repository,
      `/git/refs/heads/${encodeURIComponent(ref)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: newSha, force: false })
      }
    );
    await this.assertOk(response, `fast-forward ${repository}:${ref}`);
  }

  public async listReleaseBusV2Refs(
    repository: ReleaseBusV2Repository
  ): Promise<Array<{ ref: string; sha: string }>> {
    const response = await this.request(
      repository,
      '/git/matching-refs/heads/release-bus-v2/'
    );
    await this.assertOk(response, `list ${repository} release-bus-v2 refs`);
    return ((await response.json()) as GitHubMatchingRef[])
      .map((item) => ({
        ref: item.ref.replace(/^refs\/heads\//, ''),
        sha: item.object?.sha ?? ''
      }))
      .filter((item) => item.sha.length > 0);
  }

  public async commitTimestamp(
    repository: ReleaseBusV2Repository,
    sha: string
  ): Promise<number> {
    const response = await this.request(repository, `/commits/${sha}`);
    await this.assertOk(response, `read ${repository} commit ${sha}`);
    const payload = (await response.json()) as {
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    };
    const value =
      payload.commit?.committer?.date ?? payload.commit?.author?.date ?? '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
      throw new Error(`GitHub commit ${sha} has no valid timestamp`);
    return timestamp;
  }

  public async deleteReleaseBusV2Ref(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    if (!ref.startsWith('release-bus-v2/'))
      throw new Error(`Ref ${ref} is not a temporary release-bus-v2 branch`);
    const response = await this.request(
      repository,
      `/git/refs/heads/${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    );
    if (response.status === 404) return;
    await this.assertOk(response, `delete ${repository} ref ${ref}`);
  }

  public async dispatchWorkflow(
    repository: ReleaseBusV2Repository,
    workflow: string,
    ref: string,
    inputs: Readonly<Record<string, string>>
  ): Promise<void> {
    const response = await this.request(
      repository,
      `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({ ref, inputs })
      }
    );
    await this.assertOk(
      response,
      `dispatch ${repository} workflow ${workflow}`
    );
  }

  public async findWorkflowRun(
    repository: ReleaseBusV2Repository,
    workflow: string,
    operationKey: string,
    externalId?: string | null
  ): Promise<GitHubRun | null> {
    if (externalId) {
      if (!/^[0-9]+$/.test(externalId))
        throw new Error('Invalid GitHub workflow run id');
      const response = await this.request(
        repository,
        `/actions/runs/${externalId}`
      );
      if (response.status === 404) return null;
      await this.assertOk(response, `read ${repository} workflow run`);
      const run = (await response.json()) as GitHubRun;
      if (!workflowRunMatchesOperation(run.display_title, operationKey))
        throw new Error(
          `GitHub workflow run ${externalId} does not match operation ${operationKey}`
        );
      return this.withWorkflowJobs(repository, run);
    }
    const response = await this.request(
      repository,
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`
    );
    await this.assertOk(response, `list ${repository} workflow runs`);
    const runs =
      ((await response.json()) as { workflow_runs?: GitHubRun[] })
        .workflow_runs ?? [];
    const run =
      runs.find((candidate) =>
        workflowRunMatchesOperation(candidate.display_title, operationKey)
      ) ?? null;
    return run ? this.withWorkflowJobs(repository, run) : null;
  }

  private async withWorkflowJobs(
    repository: ReleaseBusV2Repository,
    run: GitHubRun
  ): Promise<GitHubRun> {
    const response = await this.request(
      repository,
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    await this.assertOk(response, `read ${repository} workflow jobs`);
    const jobs =
      ((await response.json()) as { jobs?: GitHubWorkflowJob[] }).jobs ?? [];
    return { ...run, jobs: sanitizeGitHubWorkflowJobs(jobs) };
  }

  public async getWorkflowRunIdentity(
    repository: ReleaseBusV2Repository,
    workflowRunId: string
  ): Promise<ReleaseBusWorkflowRunIdentity> {
    if (!/^\d+$/.test(workflowRunId))
      throw new Error('Invalid GitHub workflow run id');
    const response = await this.request(
      repository,
      `/actions/runs/${workflowRunId}`
    );
    await this.assertOk(response, `read ${repository} workflow run`);
    const run = (await response.json()) as GitHubRun;
    const actor = run.actor?.login ?? '';
    if (!isValidGitHubWorkflowActor(actor))
      throw new Error('GitHub workflow run has no valid actor');
    if (!/^[a-f0-9]{40}$/i.test(run.head_sha))
      throw new Error('GitHub workflow run has no valid head SHA');
    if (
      typeof run.head_branch !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(run.head_branch)
    )
      throw new Error('GitHub workflow run has no valid head branch');
    if (!Number.isInteger(run.run_attempt) || Number(run.run_attempt) < 1)
      throw new Error('GitHub workflow run has no valid attempt');
    return {
      actor,
      attempt: Number(run.run_attempt),
      conclusion: run.conclusion,
      event: run.event ?? '',
      headBranch: run.head_branch,
      headSha: run.head_sha.toLowerCase(),
      name: run.name,
      path: run.path ?? '',
      displayTitle: run.display_title,
      status: run.status
    };
  }

  public async getWorkflowBlobIdentity(
    repository: ReleaseBusV2Repository,
    workflow: string,
    ref: string
  ): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]*\.yml$/.test(workflow))
      throw new Error('Invalid GitHub workflow filename');
    if (!/^[a-f0-9]{40}$/.test(ref))
      throw new Error('Invalid GitHub workflow ref');
    return (
      await this.getContentIdentity(
        repository,
        `.github/workflows/${workflow}`,
        ref
      )
    ).sha;
  }

  public async hasActiveStagingMutationOrE2ERun(
    repository: ReleaseBusV2Repository,
    ignoredRunIds: readonly string[] = []
  ): Promise<boolean> {
    return this.hasActiveWorkflowRun(
      repository,
      'staging mutation or E2E',
      (run) => this.isStagingMutationOrE2ERun(repository, run),
      ignoredRunIds
    );
  }

  public async hasStagingMutationOrE2ERunSince(
    repository: ReleaseBusV2Repository,
    since: number,
    ignoredRunIds: readonly string[] = []
  ): Promise<boolean> {
    if (!Number.isInteger(since) || since < 1)
      throw new Error('Invalid staging workflow fence timestamp');
    if (ignoredRunIds.some((runId) => !/^\d+$/.test(runId)))
      throw new Error('Invalid staging workflow fence run id');
    const ignored = new Set(ignoredRunIds);
    const created = encodeURIComponent(`>=${new Date(since).toISOString()}`);
    for (let page = 1; page <= MAX_STAGING_FENCE_PAGES; page += 1) {
      const response = await this.request(
        repository,
        `/actions/runs?created=${created}&per_page=100&page=${page}`
      );
      await this.assertOk(
        response,
        `list ${repository} staging workflow runs since the beta handshake`
      );
      const runs =
        ((await response.json()) as { workflow_runs?: GitHubRun[] })
          .workflow_runs ?? [];
      if (
        runs.some(
          (run) =>
            !ignored.has(String(run.id)) &&
            typeof run.created_at === 'string' &&
            Date.parse(run.created_at) >= since &&
            this.isStagingMutationOrE2ERun(repository, run)
        )
      )
        return true;
      if (runs.length < 100) return false;
    }
    // A bounded beta cannot safely prove the environment idle when more than
    // 1,000 workflow runs fit inside its fence window. Fail closed rather than
    // silently ignoring an older mutation.
    return true;
  }

  private isStagingMutationOrE2ERun(
    repository: ReleaseBusV2Repository,
    run: GitHubRun
  ): boolean {
    if (repository === 'backend') {
      return this.isBackendDeploymentRun(run, 'staging');
    }
    const paths = [
      '.github/workflows/deploy-staging.yml',
      '.github/workflows/release-bus-deploy-staging.yml',
      '.github/workflows/staging-e2e.yml'
    ];
    const legacyNames = [
      'Web Deploy - STAGING',
      'Release Bus - Deploy Frontend Staging',
      'Staging E2E'
    ];
    return paths.includes(run.path ?? '') || legacyNames.includes(run.name);
  }

  public async hasActiveProductionMutationOrE2ERun(
    repository: ReleaseBusV2Repository,
    ignoredRunIds: readonly string[] = []
  ): Promise<boolean> {
    return this.hasActiveWorkflowRun(
      repository,
      'production mutation or E2E',
      (run) => {
        if (repository === 'backend') {
          return this.isBackendDeploymentRun(run, 'prod');
        }
        const paths = [
          '.github/workflows/build-upload-deploy-prod.yml',
          '.github/workflows/release-bus-deploy-production.yml',
          '.github/workflows/production-e2e.yml'
        ];
        const legacyNames = [
          'Web Deploy - PROD',
          'Release Bus - Deploy Frontend Production',
          'Production E2E'
        ];
        return paths.includes(run.path ?? '') || legacyNames.includes(run.name);
      },
      ignoredRunIds
    );
  }

  private isBackendDeploymentRun(
    run: GitHubRun,
    environment: 'staging' | 'prod'
  ): boolean {
    return (
      (run.path === '.github/workflows/deploy.yml' ||
        run.name === 'Deploy a service') &&
      new RegExp(` to ${environment}(?:\\s|$)`).test(run.display_title)
    );
  }

  private async hasActiveWorkflowRun(
    repository: ReleaseBusV2Repository,
    description: string,
    matches: (run: GitHubRun) => boolean,
    ignoredRunIds: readonly string[] = []
  ): Promise<boolean> {
    if (ignoredRunIds.some((runId) => !/^[1-9]\d{0,19}$/.test(runId)))
      throw new Error(`Invalid ${description} ignored workflow run id`);
    const ignored = new Set(ignoredRunIds);
    for (const status of ['queued', 'in_progress']) {
      for (let page = 1; page <= MAX_STAGING_FENCE_PAGES; page += 1) {
        const response = await this.request(
          repository,
          `/actions/runs?status=${status}&per_page=100&page=${page}`
        );
        await this.assertOk(
          response,
          `list active ${repository} ${description} workflow runs`
        );
        const runs =
          ((await response.json()) as { workflow_runs?: GitHubRun[] })
            .workflow_runs ?? [];
        if (runs.some((run) => !ignored.has(String(run.id)) && matches(run)))
          return true;
        if (runs.length < 100) break;
        if (page === MAX_STAGING_FENCE_PAGES) return true;
      }
    }
    return false;
  }

  public async ensureCommitStatus(
    repository: ReleaseBusV2Repository,
    sha: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string,
    context = 'Release Bus'
  ): Promise<void> {
    const normalizedDescription = description.slice(0, 140);
    const existing = await this.request(
      repository,
      `/commits/${sha}/statuses?per_page=100`
    );
    await this.assertOk(existing, `read ${repository} commit statuses`);
    const latest = ((await existing.json()) as GitHubCommitStatus[]).find(
      (status) => status.context === context
    );
    if (latest?.state === state && latest.description === normalizedDescription)
      return;
    const response = await this.request(repository, `/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context,
        description: normalizedDescription,
        target_url: process.env.RELEASE_BUS_UI_URL
      })
    });
    await this.assertOk(response, `update ${repository} Release Bus status`);
  }

  public async refContainsCommit(
    repository: ReleaseBusV2Repository,
    ref: string,
    commitSha: string
  ): Promise<boolean> {
    const response = await this.request(
      repository,
      `/compare/${encodeURIComponent(commitSha)}...${encodeURIComponent(ref)}`
    );
    if (response.status === 404) return false;
    await this.assertOk(
      response,
      `compare ${repository} ${commitSha} with ${ref}`
    );
    const status = ((await response.json()) as { status?: string }).status;
    return status === 'ahead' || status === 'identical';
  }

  public async isOrganizationOperator(
    login: string,
    teamSlug: string
  ): Promise<boolean> {
    const teamMembership = await this.organizationRequest(
      `/orgs/${encodeURIComponent(this.owner)}/teams/${encodeURIComponent(
        teamSlug
      )}/memberships/${encodeURIComponent(login)}`
    );
    if (teamMembership.ok) {
      const membership = (await teamMembership.json()) as GitHubMembership;
      if (membership.state === 'active') return true;
    } else if (teamMembership.status !== 404) {
      await this.assertOk(teamMembership, 'verify release-bus operator team');
    }

    const organizationMembership = await this.organizationRequest(
      `/orgs/${encodeURIComponent(this.owner)}/memberships/${encodeURIComponent(
        login
      )}`
    );
    if (organizationMembership.status === 404) return false;
    await this.assertOk(
      organizationMembership,
      'verify release-bus organization owner'
    );
    const membership =
      (await organizationMembership.json()) as GitHubMembership;
    return membership.state === 'active' && membership.role === 'admin';
  }
}

export const releaseBusGitHubApp = new ReleaseBusGitHubApp();

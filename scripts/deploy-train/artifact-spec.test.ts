import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const artifact = require('./artifact');
const catalogLib = require('./catalog');

const repoRoot = path.resolve(__dirname, '../..');
const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/config/deploy-services.json'), 'utf8')
);
const deployWorkflow = parse(
  readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')
);

function packageJsonOf(service: string) {
  return JSON.parse(
    readFileSync(
      path.join(repoRoot, catalogLib.serviceDirectory(service), 'package.json'),
      'utf8'
    )
  );
}

function specOf(service: string) {
  return artifact.parseBuildSpec(packageJsonOf(service), service);
}

describe('service build specs', () => {
  it('parses the build of every catalog service', () => {
    for (const service of catalog.services) {
      const spec = specOf(service.name);
      if (service.deploy_adapter === 'resources-only') {
        expect(spec.bundle.kind).toBe('none');
      } else {
        expect(['esbuild-cli', 'esbuild-config']).toContain(spec.bundle.kind);
      }
    }
  });

  it('reads esbuild CLI flags, including quoted externals', () => {
    const spec = specOf('mediaResizerLoop');
    expect(spec.bundle).toEqual({
      kind: 'esbuild-cli',
      options: {
        entryPoints: ['index.ts'],
        bundle: true,
        platform: 'node',
        target: ['es2020'],
        external: ['sharp', 'libheif-js/*']
      }
    });
    expect(specOf('marketDepthStreamLoop').bundle.options.target).toEqual([
      'es2022'
    ]);
  });

  it('uses the API esbuild config and tracks the files the build copies', () => {
    const spec = specOf('api');
    expect(spec.bundle).toEqual({
      kind: 'esbuild-config',
      configFile: 'esbuild.config.mjs'
    });
    expect(spec.copies).toEqual([
      { kind: 'file', path: 'src/api-serverless/openapi.yaml' },
      { kind: 'file', path: 'src/api-serverless/openapi.oracle.yaml' },
      { kind: 'package', key: 'node_modules/swagger-ui-dist' }
    ]);
  });

  it('tracks migrations and database.json for dbMigrationsLoop and CSVs for teamLoop', () => {
    expect(specOf('dbMigrationsLoop').copies).toEqual([
      { kind: 'file', path: 'database.json' },
      { kind: 'file', path: 'migrations' },
      { kind: 'service-node-modules' }
    ]);
    expect(specOf('teamLoop').copies).toEqual([
      { kind: 'file', path: 'src/teamLoop/team.csv' }
    ]);
  });

  it('rejects esbuild flags it does not understand', () => {
    expect(() =>
      artifact.esbuildOptionsFromArgs(['index.ts', '--splitting'])
    ).toThrow('Unsupported esbuild flag --splitting');
    expect(() => artifact.esbuildOptionsFromArgs(['--bundle'])).toThrow(
      'no entry point'
    );
    expect(
      artifact.esbuildOptionsFromArgs([
        'index.ts',
        '--loader:.node=file',
        '--define:DEBUG=false',
        '--outfile=dist/index.js',
        '--sourcemap',
        '--metafile=dist/meta.json'
      ])
    ).toEqual({
      entryPoints: ['index.ts'],
      loader: { '.node': 'file' },
      define: { DEBUG: 'false' }
    });
  });

  it('splits npm scripts on && and honours quotes', () => {
    expect(
      artifact.splitCommands(
        'node a.cjs && esbuild \'x y.ts\' "--external:a b" && cd dist && zip -r index.zip *'
      )
    ).toEqual([
      ['node', 'a.cjs'],
      ['esbuild', 'x y.ts', '--external:a b'],
      ['cd', 'dist'],
      ['zip', '-r', 'index.zip', '*']
    ]);
    expect(() => artifact.splitCommands("esbuild 'open")).toThrow(
      'Unterminated quote'
    );
  });

  it.each([
    ['typeorm/index.js', 'node_modules/typeorm'],
    ['@aws-sdk/client-s3/dist-cjs/index.js', 'node_modules/@aws-sdk/client-s3'],
    [
      'typeorm/node_modules/reflect-metadata/Reflect.js',
      'node_modules/typeorm/node_modules/reflect-metadata'
    ],
    [
      '@scope/a/node_modules/@scope/b/lib/x.js',
      'node_modules/@scope/a/node_modules/@scope/b'
    ]
  ])('maps %s to lockfile key %s', (file, key) => {
    expect(artifact.packageKeyFromNodeModulesPath(file)).toBe(key);
  });
});

describe('artifact components', () => {
  function side(overrides: Record<string, unknown> = {}) {
    const files: Record<string, string> = {
      'src/teamLoop/package.json': 'p1',
      'src/teamLoop/package-lock.json': 'l1',
      'src/teamLoop/serverless.yaml': 'y1',
      'src/teamLoop/team.csv': 'c1',
      'serverless-config/prod': 't1'
    };
    const locks: Record<string, unknown> = {
      'package-lock.json': {
        packages: {
          'node_modules/esbuild': { version: '0.28.1' },
          'node_modules/serverless': { version: '3.40.0' }
        }
      },
      'src/teamLoop/package-lock.json': { packages: {} }
    };
    return {
      tree: {
        children: () => [
          { type: 'blob', name: 'package.json' },
          { type: 'blob', name: 'package-lock.json' },
          { type: 'blob', name: 'serverless.yaml' },
          { type: 'blob', name: 'team.csv' },
          { type: 'blob', name: 'index.ts' },
          { type: 'blob', name: 'README.md' }
        ],
        oid: (file: string) => files[file] ?? null
      },
      readText: (file: string) =>
        file.endsWith('serverless.yaml')
          ? 'vpc: ${file(../../serverless-config/${opt:stage}/vpc.js)}'
          : null,
      readJson: (file: string) => locks[file] ?? null,
      workflow: deployWorkflow,
      catalogService: catalog.services.find(
        (entry: { name: string }) => entry.name === 'teamLoop'
      ),
      ...overrides
    };
  }

  it('is unchanged for identical inputs', () => {
    const spec = specOf('teamLoop');
    const components = artifact.collectComponents(
      'teamLoop',
      'prod',
      spec,
      side()
    );
    const byText = (left: string, right: string) => left.localeCompare(right);
    expect(
      components
        .map((component: { name: string }) => component.name)
        .sort(byText)
    ).toEqual(
      [
        'copied src/teamLoop/team.csv',
        'deploy adapter',
        'esbuild version',
        'file src/teamLoop/package-lock.json',
        'file src/teamLoop/package.json',
        'file src/teamLoop/serverless.yaml',
        'file src/teamLoop/team.csv',
        'serverless version',
        'serverless-config/prod'
      ].sort(byText)
    );
    expect(artifact.compareComponents(components, components)).toEqual({
      reasons: [],
      paths: []
    });
  });

  it('reports serverless.yaml, toolchain and deploy-step changes', () => {
    const spec = specOf('teamLoop');
    const before = artifact.collectComponents('teamLoop', 'prod', spec, side());
    const changedWorkflow = JSON.parse(JSON.stringify(deployWorkflow));
    const step = changedWorkflow.jobs['build-and-deploy'].steps.find(
      (candidate: { name: string }) => candidate.name === 'Deploy service'
    );
    step.run = `${step.run}\necho changed`;
    const after = artifact.collectComponents(
      'teamLoop',
      'prod',
      spec,
      side({
        workflow: changedWorkflow,
        readJson: (file: string) =>
          file === 'package-lock.json'
            ? {
                packages: {
                  'node_modules/esbuild': { version: '0.29.0' },
                  'node_modules/serverless': { version: '3.40.0' }
                }
              }
            : { packages: {} }
      })
    );
    expect(artifact.compareComponents(before, after).reasons).toEqual([
      'deploy adapter changed',
      'esbuild version 0.28.1 -> 0.29.0'
    ]);
  });

  it('ignores blackout edits but not adapter edits in the catalog', () => {
    const service = catalog.services.find(
      (entry: { name: string }) => entry.name === 'royaltiesLoop'
    );
    const baseline = artifact.adapterFingerprint(
      service,
      'prod',
      deployWorkflow,
      false
    );
    expect(
      artifact.adapterFingerprint(
        {
          ...service,
          deploy_blackouts: [],
          deploy_train: { mode: 'manual', reason: 'x' }
        },
        'prod',
        deployWorkflow,
        false
      )
    ).toBe(baseline);
    expect(
      artifact.adapterFingerprint(
        { ...service, aws_region: { staging: 'eu-west-1', prod: 'eu-west-1' } },
        'prod',
        deployWorkflow,
        false
      )
    ).not.toBe(baseline);
  });

  it('includes the environment step only for services reading workflow env', () => {
    expect(
      artifact.serverlessUsesWorkflowEnv('x: ${env:VERSION_DESCRIPTION}')
    ).toBe(false);
    expect(artifact.serverlessUsesWorkflowEnv('x: ${env:SENTRY_DSN}')).toBe(
      false
    );
    expect(
      artifact.serverlessUsesWorkflowEnv('x: ${env:API_GATEWAY_WS_ENDPOINT}')
    ).toBe(true);
    expect(
      artifact.adapterStepNames(
        { name: 'releaseDigestLoop', deploy_adapter: 'serverless' },
        true
      )
    ).toEqual(['Select environment-specific config', 'Deploy service']);
    expect(
      artifact.adapterStepNames(
        { name: 'mediaResizerLoop', deploy_adapter: 'direct-lambda-zip' },
        false
      )
    ).toEqual(['Deploy mediaResizerLoop']);
  });

  it('finds every adapter step in the generated deploy workflow', () => {
    const names = deployWorkflow.jobs['build-and-deploy'].steps.map(
      (step: { name: string }) => step.name
    );
    for (const service of catalog.services) {
      for (const step of artifact.adapterStepNames(service, true)) {
        expect(names).toContain(step);
      }
    }
  });
});

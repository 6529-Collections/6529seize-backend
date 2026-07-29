import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_BUS_BACKEND_INSTALL_STRATEGIES,
  validateReleaseBusBackendLayers,
  validateReleaseBusBackendInstallStrategyCoverage
} from './release-bus-backend-package-strategies.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const deployConfigPath = path.join(
  repoRoot,
  'src',
  'config',
  'deploy-services.json'
);
const V3_CONTRACT = 'environment-bound-v3';
const LEGACY_CONTRACT = 'legacy-v2';
const MAX_PARALLEL_UNIT_TASKS = 3;
const INFRASTRUCTURE_FAILURE_MARKER = path.join(
  repoRoot,
  '.release-bus-package-failure-class'
);
const TRANSPORT_ERROR_CODES = Object.freeze([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
]);
const RETRYABLE_HTTP_STATUS_CODES = new Set([
  '408',
  '429',
  '500',
  '502',
  '503',
  '504'
]);

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined)
      throw new Error('Arguments must be provided as --name value pairs');
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(argumentsByName, name) {
  const value = argumentsByName.get(name)?.trim();
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function packageDirectory(unit) {
  return path.join(repoRoot, 'src', unit === 'api' ? 'api-serverless' : unit);
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options
  });
}

export function hasUnmistakableTransportFailure(output) {
  if (TRANSPORT_ERROR_CODES.some((code) => output.includes(code))) return true;
  return output.split(/\r?\n/u).some((line) => {
    if (!/^npm (?:error|ERR!)/iu.test(line)) return false;
    return line
      .split(/[^0-9]+/u)
      .some((token) => RETRYABLE_HTTP_STATUS_CODES.has(token));
  });
}

export async function clearInfrastructureFailureMarker(
  marker = INFRASTRUCTURE_FAILURE_MARKER
) {
  await fs.rm(marker, { force: true });
}

export async function markInfrastructureFailure(
  marker = INFRASTRUCTURE_FAILURE_MARKER
) {
  try {
    await fs.writeFile(marker, 'INFRASTRUCTURE\n', {
      flag: 'wx'
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function runAsync(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let output = '';
    const observe = (chunk, destination) => {
      destination.write(chunk);
      output = `${output}${String(chunk)}`.slice(-512 * 1024);
    };
    child.stdout.on('data', (chunk) => observe(chunk, process.stdout));
    child.stderr.on('data', (chunk) => observe(chunk, process.stderr));
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      if (code === 0) resolve();
      else {
        if (hasUnmistakableTransportFailure(output)) {
          try {
            await markInfrastructureFailure();
          } catch (error) {
            reject(error);
            return;
          }
        }
        const outcome = signal ?? `exit ${code}`;
        reject(
          new Error(`${command} ${args.join(' ')} failed with ${outcome}`)
        );
      }
    });
  });
}

async function mapBounded(values, concurrency, task) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(values[index]);
      }
    }
  );
  await Promise.all(workers);
}

async function installUnitDependencies(unit) {
  const strategy = RELEASE_BUS_BACKEND_INSTALL_STRATEGIES[unit];
  if (strategy === 'root-bundled' || strategy === 'self-install-native') return;
  if (strategy !== 'local-frozen')
    throw new Error(`${unit} has no explicit dependency strategy`);
  const directory = packageDirectory(unit);
  if (!(await pathExists(path.join(directory, 'package-lock.json'))))
    throw new Error(`${unit} has no frozen local dependency strategy`);
  await runAsync('npm', ['ci', '--ignore-scripts'], directory);
}

async function buildUnit(unit) {
  await runAsync('npm', ['run', 'build'], packageDirectory(unit));
}

async function sha256(file) {
  const contents = await fs.readFile(file);
  return createHash('sha256').update(contents).digest('hex');
}

function validateIdentity({
  contractVersion,
  environment,
  sourceSha,
  trainId
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha))
    throw new Error('source-sha must be an exact lowercase Git SHA');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(trainId))
    throw new Error('train-id is invalid');
  if (![LEGACY_CONTRACT, V3_CONTRACT].includes(contractVersion))
    throw new Error('artifact contract version is unsupported');
  if (contractVersion === V3_CONTRACT) {
    if (!['staging', 'production'].includes(environment))
      throw new Error('v3 artifacts require staging or production');
  } else if (
    environment &&
    !['portable', 'staging', 'production'].includes(environment)
  ) {
    throw new Error('legacy artifact environment is invalid');
  }
}

async function main() {
  await clearInfrastructureFailureMarker();
  const argumentsByName = parseArguments(process.argv.slice(2));
  const contractVersion = required(argumentsByName, 'contract-version');
  const candidateEvidenceMode = required(
    argumentsByName,
    'candidate-evidence-mode'
  );
  const aggregateCandidateEvidenceDigest =
    argumentsByName.get('aggregate-candidate-evidence-digest')?.trim() ?? '';
  const reuseArtifactRunId =
    argumentsByName.get('reuse-artifact-run-id')?.trim() ?? '';
  const reuseArtifactName =
    argumentsByName.get('reuse-artifact-name')?.trim() ?? '';
  const reuseArtifactDigest =
    argumentsByName.get('reuse-artifact-digest')?.trim() ?? '';
  const environment = argumentsByName.get('environment')?.trim() ?? '';
  const sourceSha = required(argumentsByName, 'source-sha');
  const trainId = required(argumentsByName, 'train-id');
  const outputDirectory = path.resolve(
    repoRoot,
    required(argumentsByName, 'output')
  );
  const units = JSON.parse(required(argumentsByName, 'units-json'));
  const layers = JSON.parse(required(argumentsByName, 'layers-json'));
  validateIdentity({ contractVersion, environment, sourceSha, trainId });
  if (candidateEvidenceMode === 'strict-single') {
    if (
      contractVersion !== V3_CONTRACT ||
      aggregateCandidateEvidenceDigest ||
      !/^[1-9][0-9]{0,19}$/.test(reuseArtifactRunId) ||
      reuseArtifactName !== `release-bus-v2-pr-${sourceSha}` ||
      !/^[a-f0-9]{64}$/.test(reuseArtifactDigest)
    )
      throw new Error('strict-single candidate evidence is incomplete');
  } else if (candidateEvidenceMode === 'strict-aggregate') {
    if (
      contractVersion !== V3_CONTRACT ||
      !/^[a-f0-9]{64}$/.test(aggregateCandidateEvidenceDigest) ||
      reuseArtifactRunId ||
      reuseArtifactName ||
      reuseArtifactDigest
    )
      throw new Error('strict-aggregate candidate evidence is incomplete');
  } else if (candidateEvidenceMode === 'legacy-whole-train') {
    const reuseFields = [
      reuseArtifactRunId,
      reuseArtifactName,
      reuseArtifactDigest
    ];
    if (
      contractVersion !== 'legacy-v2' ||
      aggregateCandidateEvidenceDigest ||
      !(
        reuseFields.every((value) => value === '') ||
        (/^[1-9][0-9]{0,19}$/.test(reuseArtifactRunId) &&
          /^release-bus-v2-pr-[a-f0-9]{40}$/.test(reuseArtifactName) &&
          /^[a-f0-9]{64}$/.test(reuseArtifactDigest))
      )
    )
      throw new Error('legacy-whole-train candidate evidence is incomplete');
  } else throw new Error('Unsupported candidate evidence mode');
  if (
    !Array.isArray(units) ||
    units.length === 0 ||
    new Set(units).size !== units.length ||
    units.some((unit) => typeof unit !== 'string')
  )
    throw new Error('units-json must contain unique service names');
  validateReleaseBusBackendLayers(units, layers);

  const config = JSON.parse(await fs.readFile(deployConfigPath, 'utf8'));
  const services = new Map(
    config.services.map((service) => [service.name, service])
  );
  validateReleaseBusBackendInstallStrategyCoverage(services.keys());
  const deployEnvironment = environment === 'production' ? 'prod' : environment;
  for (const unit of units) {
    const service = services.get(unit);
    if (!service) throw new Error(`Unknown deploy unit ${unit}`);
    if (
      deployEnvironment &&
      !service.allowed_environments.includes(deployEnvironment)
    )
      throw new Error(`${unit} cannot be deployed to ${environment}`);
    if (!(await pathExists(path.join(packageDirectory(unit), 'package.json'))))
      throw new Error(`${unit} has no package contract`);
  }

  const actualSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();
  if (actualSha !== sourceSha)
    throw new Error(`Checked out ${actualSha}, expected ${sourceSha}`);

  for (const layer of layers) {
    await mapBounded(layer, MAX_PARALLEL_UNIT_TASKS, installUnitDependencies);
    // API generation rewrites its generated source tree. Within its exact DAG
    // frontier, build it first so no concurrent reader can observe a partial
    // generated tree. Dependent frontiers always wait for this one.
    if (layer.includes('api')) await buildUnit('api');
    await mapBounded(
      layer.filter((unit) => unit !== 'api'),
      MAX_PARALLEL_UNIT_TASKS,
      buildUnit
    );
  }

  await fs.rm(outputDirectory, { force: true, recursive: true });
  const packageDigests = {};
  for (const unit of units) {
    const source = path.join(packageDirectory(unit), 'dist', 'index.zip');
    const destination = path.join(
      outputDirectory,
      'packages',
      unit,
      'index.zip'
    );
    if (!(await pathExists(source)))
      throw new Error(`${unit} build did not create dist/index.zip`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    packageDigests[unit] = await sha256(destination);
  }

  const manifest =
    contractVersion === V3_CONTRACT
      ? {
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_contract_version: V3_CONTRACT,
          repository: 'backend',
          train_id: trainId,
          source_sha: sourceSha,
          environment,
          units,
          layers,
          packages: Object.fromEntries(
            units.map((unit) => [
              unit,
              {
                path: `packages/${unit}/index.zip`,
                sha256: packageDigests[unit]
              }
            ])
          ),
          ci_evidence: {
            mode: candidateEvidenceMode,
            artifact_run_id: reuseArtifactRunId || null,
            artifact_name: reuseArtifactName || null,
            artifact_digest: reuseArtifactDigest || null,
            aggregate_candidate_evidence_digest:
              aggregateCandidateEvidenceDigest || null
          },
          source_evidence_reused: true,
          artifact_bytes_reused: false
        }
      : {
          schema_version: 2,
          repository: 'backend',
          train_id: trainId,
          source_sha: sourceSha,
          environment: 'portable',
          units,
          layers,
          packages: Object.fromEntries(
            units.map((unit) => [
              unit,
              {
                path: `packages/${unit}/index.zip`,
                sha256: packageDigests[unit]
              }
            ])
          ),
          ci_evidence: {
            mode: candidateEvidenceMode,
            artifact_run_id: reuseArtifactRunId || null,
            artifact_name: reuseArtifactName || null,
            artifact_digest: reuseArtifactDigest || null,
            aggregate_candidate_evidence_digest: null
          },
          reused_exact_pr_artifact: false
        };
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumLines = [];
  for (const unit of units)
    checksumLines.push(`${packageDigests[unit]}  packages/${unit}/index.zip`);
  checksumLines.push(`${await sha256(manifestPath)}  manifest.json`);
  await fs.writeFile(
    path.join(outputDirectory, 'SHA256SUMS'),
    `${checksumLines.join('\n')}\n`
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

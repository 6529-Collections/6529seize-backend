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
const TRANSIENT_TRANSPORT_PATTERN =
  /EAI_AGAIN|ECONN(?:REFUSED|RESET|ABORTED)?|ENET(?:UNREACH|DOWN)|ENOTFOUND|ETIMEDOUT|HTTP (?:408|429|5\d\d)|status(?:code)? (?:408|429|5\d\d)/i;

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
    child.once('exit', async (code, signal) => {
      if (code === 0) resolve();
      else {
        if (TRANSIENT_TRANSPORT_PATTERN.test(output))
          await fs
            .writeFile(INFRASTRUCTURE_FAILURE_MARKER, 'INFRASTRUCTURE\n')
            .catch(() => undefined);
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`
          )
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
  } else if (environment && !['staging', 'production'].includes(environment)) {
    throw new Error('legacy artifact environment is invalid');
  }
}

async function main() {
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

  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], {
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

await main();

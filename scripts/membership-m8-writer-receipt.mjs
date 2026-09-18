import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  LambdaClient,
  GetFunctionConfigurationCommand
} from '@aws-sdk/client-lambda';

const repository = '6529-Collections/6529seize-backend';
const account = '987989283142';
const region = 'eu-west-1';
export const units = Object.freeze({
  api: 'seizeAPI',
  helpBotReplyLoop: 'helpBotReplyLoop',
  xTdhLoop: 'xTdhLoop',
  tdhLoop: 'tdhLoop',
  delegationsLoop: 'delegationsLoop',
  overRatesRevocationLoop: 'overRatesRevocationLoop',
  xTdhGrantsReviewerLoop: 'xTdhGrantsReviewerLoop',
  nftOwnersLoop: 'nftOwnersLoop',
  externalCollectionSnapshottingLoop: 'externalCollectionSnapshottingLoop',
  externalCollectionLiveTailingLoop: 'externalCollectionLiveTailingLoop'
});

export function argumentsForReceipt(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--expected-sha' ||
    argv[2] !== '--deploy-runs'
  )
    throw new Error(
      'Usage: membership:m8:writer-receipt --expected-sha <40-hex staging SHA> --deploy-runs <absolute JSON path>'
    );
  const sha = argv[1];
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error('Expected staging SHA must be 40 lowercase hex characters');
  if (!argv[3].startsWith('/'))
    throw new Error('Deploy run map path must be absolute');
  const runs = JSON.parse(readFileSync(argv[3], 'utf8'));
  if (
    !runs ||
    typeof runs !== 'object' ||
    Array.isArray(runs) ||
    JSON.stringify(Object.keys(runs).sort((a, b) => a.localeCompare(b))) !==
      JSON.stringify(Object.keys(units).sort((a, b) => a.localeCompare(b)))
  )
    throw new Error('Deploy run map must contain the exact ten writer units');
  for (const [unit, id] of Object.entries(runs))
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error(`Invalid deploy run ID for ${unit}`);
  return { sha, runs };
}

export function validateGithubRun(run, id, sha, unit) {
  const expectedTitle = `Deploy ${unit} to staging`;
  if (
    String(run.id) !== String(id) ||
    run.head_sha !== sha ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/deploy.yml' ||
    run.head_branch !== '1a-staging' ||
    (run.display_title !== expectedTitle &&
      run.display_title !== `${expectedTitle} [manual]`)
  )
    throw new Error(
      `Deploy run ${id} is not a successful staging run at the expected SHA`
    );
}

async function githubRun(id, sha, unit) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token)
    throw new Error(
      'GH_TOKEN or GITHUB_TOKEN is required to verify deploy runs'
    );
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs/${id}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'membership-m8-writer-receipt',
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!response.ok)
    throw new Error(`Unable to read deploy run ${id}: HTTP ${response.status}`);
  validateGithubRun(await response.json(), id, sha, unit);
}

export function writerEvidence(configuration, functionName, sha, runId) {
  const env = configuration.Environment?.Variables ?? {};
  const lastModified = Date.parse(configuration.LastModified ?? '');
  const deployedAbbreviation = configuration.Description?.split(' - ', 1)[0];
  const deployedSourceSha =
    functionName === 'seizeAPI'
      ? env.GIT_COMMIT
      : env.MEMBERSHIP_DEPLOY_SOURCE_SHA;
  if (
    configuration.FunctionArn !==
      `arn:aws:lambda:${region}:${account}:function:${functionName}` ||
    configuration.State !== 'Active' ||
    configuration.LastUpdateStatus !== 'Successful' ||
    configuration.Runtime !== 'nodejs22.x' ||
    configuration.Version !== '$LATEST' ||
    !deployedAbbreviation ||
    deployedAbbreviation.length < 7 ||
    !sha.startsWith(deployedAbbreviation) ||
    deployedSourceSha !== sha ||
    env.MEMBERSHIP_SOURCE_TRACKING_MODE !== 'tracking-v1' ||
    env.MEMBERSHIP_SOURCE_TRACKING_STAGE !== 'staging' ||
    !Number.isSafeInteger(lastModified) ||
    !Number.isInteger(configuration.Timeout) ||
    configuration.Timeout < 1 ||
    configuration.Timeout > 900 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(configuration.CodeSha256 ?? '')
  )
    throw new Error(
      `${functionName} does not have reviewed tracked-writer configuration`
    );
  return {
    source_sha: sha,
    function_version: configuration.Version,
    code_sha256: configuration.CodeSha256,
    last_modified_millis: String(lastModified),
    timeout_seconds: configuration.Timeout,
    deploy_run_id: String(runId),
    mode: 'tracking-v1',
    stage: 'staging'
  };
}

export function requireDrainWindow(evidence, now) {
  const earliestDrain = Math.max(
    ...Object.values(evidence).map(
      (item) =>
        Number(item.last_modified_millis) + item.timeout_seconds * 1000 + 60000
    )
  );
  if (now < earliestDrain)
    throw new Error(
      `Old writer invocation drain window has ${Math.ceil((earliestDrain - now) / 1000)} seconds remaining`
    );
}

async function main() {
  const { sha, runs } = argumentsForReceipt(process.argv.slice(2));
  const client = new LambdaClient({ region });
  try {
    const evidence = {};
    for (const [unit, functionName] of Object.entries(units)) {
      await githubRun(runs[unit], sha, unit);
      const response = await client.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName })
      );
      evidence[unit] = writerEvidence(response, functionName, sha, runs[unit]);
    }
    // helpBotReplyLoop's companion is part of its deploy unit and must also be current.
    const companion = await client.send(
      new GetFunctionConfigurationCommand({
        FunctionName: 'helpBotDailyActivityCreditLoop'
      })
    );
    evidence.helpBotDailyActivityCreditLoop = writerEvidence(
      companion,
      'helpBotDailyActivityCreditLoop',
      sha,
      runs.helpBotReplyLoop
    );
    const now = Date.now();
    requireDrainWindow(evidence, now);
    process.stdout.write(
      JSON.stringify({
        operator_action: 'membership_bootstrap_record_writers_v1',
        tracked_writer_receipt: {
          expected_staging_sha: sha,
          verified_at_millis: String(now),
          old_invocations_drained_at_millis: String(now),
          units: evidence
        }
      }) + '\n'
    );
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Unknown writer receipt error'}\n`
    );
    process.exitCode = 1;
  });

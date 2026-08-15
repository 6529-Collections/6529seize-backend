#!/usr/bin/env node
/* global AbortController, Buffer, clearTimeout, fetch, setTimeout */
import crypto from 'node:crypto';
import console from 'node:console';
import process from 'node:process';

const {
  CI_PIPELINES_ALERT_URL,
  CI_PIPELINES_ALERT_SECRET,
  CI_PIPELINES_ALERT_API_AUTH,
  CI_PIPELINES_ALERT_TYPE,
  CI_PIPELINES_TARGET_ENV,
  CI_PIPELINES_STATUS,
  CI_PIPELINES_TITLE,
  CI_PIPELINES_DESCRIPTION,
  CI_PIPELINES_ENVIRONMENT,
  CI_PIPELINES_SERVICE,
  CI_PIPELINES_WORKFLOW,
  CI_RELEASE_NOTES_PROMPT_PATH,
  CI_RELEASE_GROUP_ID,
  CI_RELEASE_GROUP_SERVICES,
  CI_RELEASE_PULL_REQUEST,
  CI_RELEASE_NOTE_PUBLISH,
  CI_RELEASE_NOTE_GROUPS,
  CI_RELEASE_NOTE_OPT_OUT,
  CI_RELEASE_TRAIN_ID,
  CI_RELEASE_CONTRIBUTORS,
  CI_RELEASE_OPERATION_KEY,
  CI_PIPELINES_SHA,
  GITHUB_REPOSITORY,
  GITHUB_WORKFLOW,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_RUN_ATTEMPT,
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_SHA,
  GITHUB_REF_NAME,
  GITHUB_TRIGGERING_ACTOR,
  GITHUB_ACTOR,
  GITHUB_TOKEN,
  GITHUB_API_URL = 'https://api.github.com',
  CI_GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS,
  CI_PIPELINES_ALERT_TIMEOUT_MS
} = process.env;

function requireValue(name, value) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function normalizeTargetEnvironment(value) {
  const targetEnv = (value || '').trim().toLowerCase();
  if (!targetEnv) {
    return null;
  }
  if (targetEnv === 'staging') {
    return 'staging';
  }
  if (targetEnv === 'prod' || targetEnv === 'production') {
    return 'prod';
  }
  return `unsupported:${targetEnv}`;
}

function getFetchFailureMessage(error) {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'request timed out' : error.message;
  }
  return 'unknown request error';
}

function boundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS = boundedDuration(
  CI_GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS,
  3_000,
  25,
  10_000
);
const PIPELINES_ALERT_TIMEOUT_MS = boundedDuration(
  CI_PIPELINES_ALERT_TIMEOUT_MS,
  10_000,
  25,
  30_000
);

function validateOptionalBoolean(name, value) {
  if (value && value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
}

function canonicalServices(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((service) => typeof service === 'string')
        .map((service) => service.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseReleaseNoteGroup(group, deployedService) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error('CI_RELEASE_NOTE_GROUPS entries must be objects');
  }
  const services = canonicalServices(group.release_group_services);
  if (
    typeof group.release_group_id !== 'string' ||
    !group.release_group_id.trim() ||
    !Number.isSafeInteger(group.pull_request_number) ||
    group.pull_request_number <= 0 ||
    typeof group.publish_release_note !== 'boolean' ||
    !services.length ||
    !deployedService ||
    !services.includes(deployedService)
  ) {
    throw new Error('CI_RELEASE_NOTE_GROUPS contains an invalid group');
  }
  return {
    release_group_id: group.release_group_id.trim(),
    release_group_services: services,
    pull_request_number: group.pull_request_number,
    publish_release_note: group.publish_release_note
  };
}

function parseReleaseNoteGroups(value, deployedService) {
  if (!value) return null;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('CI_RELEASE_NOTE_GROUPS must be an array');
  }
  const groups = parsed.map((group) =>
    parseReleaseNoteGroup(group, deployedService)
  );
  const pullRequests = new Set(
    groups.map((group) => group.pull_request_number)
  );
  const groupIds = new Set(groups.map((group) => group.release_group_id));
  if (pullRequests.size !== groups.length || groupIds.size !== groups.length) {
    throw new Error('CI_RELEASE_NOTE_GROUPS contains duplicate groups');
  }
  return groups;
}

function releaseNoteMetadataErrorMessage(error) {
  if (error instanceof SyntaxError) {
    return 'CI_RELEASE_NOTE_GROUPS is not valid JSON';
  }
  if (error instanceof Error) return error.message;
  return 'Release-note metadata is invalid';
}

function isContributorGithubLogin(value) {
  return (
    value.length <= 39 &&
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?:\[bot\])?$/.test(
      value
    )
  );
}

const NON_HUMAN_GITHUB_LOGINS = new Set([
  'dependabot',
  'github-actions',
  'renovate',
  'web-flow'
]);

function isHumanGithubUser(user) {
  const login = user?.login?.trim();
  const type = user?.type?.trim().toLowerCase();
  return Boolean(
    login &&
    type === 'user' &&
    !login.toLowerCase().endsWith('[bot]') &&
    !NON_HUMAN_GITHUB_LOGINS.has(login.toLowerCase())
  );
}

function parseReleaseContributors(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error(
      'CI_RELEASE_CONTRIBUTORS must be an array with at most 100 entries'
    );
  }
  const contributors = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !isContributorGithubLogin(entry.trim())) {
      throw new Error(
        'CI_RELEASE_CONTRIBUTORS contains an invalid GitHub login'
      );
    }
    const login = entry.trim();
    const key = login.toLowerCase();
    if (
      seen.has(key) ||
      key.endsWith('[bot]') ||
      NON_HUMAN_GITHUB_LOGINS.has(key)
    )
      continue;
    seen.add(key);
    contributors.push(login);
  }
  return contributors;
}

async function githubApi(repository, path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS
  );
  try {
    const response = await fetch(
      `${GITHUB_API_URL.replace(/\/$/, '')}/repos/${repository}${path}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
          'User-Agent': '6529-ci-contributor-attribution',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub contributor evidence request failed: ${response.status} ${response.statusText}`
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `GitHub contributor evidence request timed out after ${GITHUB_EVIDENCE_REQUEST_TIMEOUT_MS}ms: ${path}`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function validatePullRequestDeploymentEvidence({
  pull,
  pullRequestNumber,
  deployedSha,
  branch
}) {
  if (Number(pull.number) !== pullRequestNumber) {
    throw new Error(`PR #${pullRequestNumber} identity did not match`);
  }
  const merged = pull.merged === true || Boolean(pull.merged_at);
  const evidenceSha = (
    merged ? pull.merge_commit_sha : pull.head?.sha
  )?.toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(evidenceSha)) {
    throw new Error(`PR #${pullRequestNumber} has no immutable SHA evidence`);
  }
  // Manual operators select the PR input. For an open PR, bind that selection
  // to its exact immutable head and branch before using it for attribution.
  if (!merged && (evidenceSha !== deployedSha || pull.head?.ref !== branch)) {
    throw new Error(
      `Open PR #${pullRequestNumber} does not exactly match deployed branch ${branch}`
    );
  }
  if (merged && evidenceSha !== deployedSha) {
    throw new Error(
      `Merged PR #${pullRequestNumber} does not exactly match deployed SHA ${deployedSha}`
    );
  }
}

async function fetchCompletePullRequestPages({
  repository,
  pullRequestNumber,
  resource
}) {
  const entries = [];
  for (let page = 1; page <= 3; page += 1) {
    const pageEntries = await githubApi(
      repository,
      `/pulls/${pullRequestNumber}/${resource}?per_page=100&page=${page}`
    );
    if (!Array.isArray(pageEntries)) {
      throw new TypeError(
        `PR #${pullRequestNumber} ${resource} evidence is malformed`
      );
    }
    entries.push(...pageEntries);
    if (pageEntries.length < 100) return entries;
  }
  throw new Error(
    `PR #${pullRequestNumber} ${resource} evidence is incomplete`
  );
}

function assertManualServicePlan({
  releaseGroupServices,
  pullRequestNumber,
  service
}) {
  if (!releaseGroupServices.includes(service)) {
    throw new Error(
      `PR #${pullRequestNumber} manual service plan does not include ${service}`
    );
  }
}

async function deriveManualPullRequestContributors({
  repository,
  pullRequestNumber,
  deployedSha,
  service,
  branch,
  releaseGroupServices
}) {
  const pull = await githubApi(repository, `/pulls/${pullRequestNumber}`);
  await validatePullRequestDeploymentEvidence({
    pull,
    pullRequestNumber,
    deployedSha,
    branch
  });
  assertManualServicePlan({
    releaseGroupServices,
    pullRequestNumber,
    service
  });
  const commits = await fetchCompletePullRequestPages({
    repository,
    pullRequestNumber,
    resource: 'commits'
  });
  const users = [pull.user];
  for (const commit of commits) {
    users.push(commit.author, commit.committer);
  }
  return parseReleaseContributors(
    JSON.stringify(users.filter(isHumanGithubUser).map((user) => user.login))
  );
}

function releaseContributorMetadataErrorMessage(error) {
  if (error instanceof SyntaxError) {
    return 'CI_RELEASE_CONTRIBUTORS is not valid JSON';
  }
  if (error instanceof Error) return error.message;
  return 'Release contributor metadata is invalid';
}

const targetEnvironment = normalizeTargetEnvironment(
  CI_PIPELINES_TARGET_ENV || CI_PIPELINES_ENVIRONMENT
);

if (targetEnvironment?.startsWith('unsupported:')) {
  console.error(
    `Unsupported CI pipeline alert target environment: ${targetEnvironment.slice(12)}`
  );
  process.exit(1);
}

if (!CI_PIPELINES_ALERT_URL || !CI_PIPELINES_ALERT_SECRET) {
  console.log('CI pipeline alert receiver is not configured; skipping.');
  process.exit(0);
}

const repository = requireValue('GITHUB_REPOSITORY', GITHUB_REPOSITORY);
const runId = requireValue('GITHUB_RUN_ID', GITHUB_RUN_ID);
const status = requireValue('CI_PIPELINES_STATUS', CI_PIPELINES_STATUS);
const title = requireValue('CI_PIPELINES_TITLE', CI_PIPELINES_TITLE);
const alertType = CI_PIPELINES_ALERT_TYPE || 'workflow';
if (!['workflow', 'deploy', 'web_e2e'].includes(alertType)) {
  console.error('CI_PIPELINES_ALERT_TYPE is invalid');
  process.exit(1);
}
const runAttempt = GITHUB_RUN_ATTEMPT ? Number(GITHUB_RUN_ATTEMPT) : 1;
if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
  console.error('GITHUB_RUN_ATTEMPT must be a positive integer');
  process.exit(1);
}
const triggeredByGithubLogin = GITHUB_TRIGGERING_ACTOR || GITHUB_ACTOR || null;
const isReleaseNotesEligible =
  status === 'success' &&
  targetEnvironment === 'prod' &&
  Boolean(CI_RELEASE_NOTES_PROMPT_PATH) &&
  CI_RELEASE_NOTE_OPT_OUT !== 'true';
const releaseGroupServices = (
  CI_RELEASE_GROUP_SERVICES ||
  CI_PIPELINES_SERVICE ||
  ''
)
  .split(',')
  .map((service) => service.trim())
  .filter(Boolean);
const pullRequestNumber = CI_RELEASE_PULL_REQUEST
  ? Number(CI_RELEASE_PULL_REQUEST)
  : null;
if (
  CI_RELEASE_PULL_REQUEST &&
  (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0)
) {
  console.error('CI_RELEASE_PULL_REQUEST must be a positive integer');
  process.exit(1);
}
let releaseNoteGroups = null;
let releaseContributors = [];
try {
  validateOptionalBoolean('CI_RELEASE_NOTE_PUBLISH', CI_RELEASE_NOTE_PUBLISH);
  validateOptionalBoolean('CI_RELEASE_NOTE_OPT_OUT', CI_RELEASE_NOTE_OPT_OUT);
  releaseNoteGroups = parseReleaseNoteGroups(
    CI_RELEASE_NOTE_GROUPS,
    CI_PIPELINES_SERVICE
  );
} catch (error) {
  console.error(releaseNoteMetadataErrorMessage(error));
  process.exit(1);
}
try {
  releaseContributors = parseReleaseContributors(CI_RELEASE_CONTRIBUTORS);
} catch (error) {
  console.error(releaseContributorMetadataErrorMessage(error));
  process.exit(1);
}
const suppliedReleaseContributorCount = CI_RELEASE_CONTRIBUTORS
  ? JSON.parse(CI_RELEASE_CONTRIBUTORS).length
  : 0;
if (
  CI_RELEASE_TRAIN_ID &&
  !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    CI_RELEASE_TRAIN_ID
  )
) {
  console.error('CI_RELEASE_TRAIN_ID is invalid');
  process.exit(1);
}
if (
  (CI_RELEASE_TRAIN_ID && !CI_RELEASE_OPERATION_KEY) ||
  (!CI_RELEASE_TRAIN_ID && CI_RELEASE_OPERATION_KEY)
) {
  console.error(
    'CI_RELEASE_TRAIN_ID and CI_RELEASE_OPERATION_KEY must be supplied together'
  );
  process.exit(1);
}
if (
  CI_RELEASE_OPERATION_KEY &&
  (!/^rb2:[A-Za-z0-9:._-]{1,220}:a[1-9]\d{0,8}$/.test(
    CI_RELEASE_OPERATION_KEY
  ) ||
    !CI_RELEASE_OPERATION_KEY.startsWith(`rb2:${CI_RELEASE_TRAIN_ID}:`))
) {
  console.error('CI_RELEASE_OPERATION_KEY is invalid for CI_RELEASE_TRAIN_ID');
  process.exit(1);
}
if (CI_PIPELINES_SHA && !/^[a-f0-9]{40}$/.test(CI_PIPELINES_SHA)) {
  console.error('CI_PIPELINES_SHA must be a 40-character lowercase Git SHA');
  process.exit(1);
}
const isReleaseBusOperation = Boolean(
  CI_RELEASE_TRAIN_ID && CI_RELEASE_OPERATION_KEY
);
if (
  CI_RELEASE_NOTE_OPT_OUT === 'true' &&
  isReleaseBusOperation &&
  ((releaseNoteGroups?.length ?? 0) > 0 || CI_RELEASE_NOTE_PUBLISH === 'true')
) {
  console.error(
    'Release Bus release-note opt-out cannot include release-note groups or a publish request'
  );
  process.exit(1);
}
if (
  CI_RELEASE_NOTE_OPT_OUT === 'true' &&
  !isReleaseBusOperation &&
  (pullRequestNumber ||
    CI_RELEASE_GROUP_SERVICES ||
    CI_RELEASE_NOTE_GROUPS ||
    suppliedReleaseContributorCount > 0 ||
    CI_RELEASE_NOTE_PUBLISH === 'true')
) {
  console.error(
    'Manual no-PR opt-out cannot include a PR, contributors, release-note metadata, or a publish request'
  );
  process.exit(1);
}
if (!isReleaseBusOperation) {
  if (suppliedReleaseContributorCount > 0) {
    console.error(
      'Manual deployments cannot supply contributors; exact PR evidence is required'
    );
    process.exit(1);
  }
  if (CI_RELEASE_NOTE_GROUPS) {
    console.error(
      'CI_RELEASE_NOTE_GROUPS is reserved for verified Release Bus operations'
    );
    process.exit(1);
  }
  if (CI_RELEASE_NOTE_OPT_OUT !== 'true' && !pullRequestNumber) {
    console.error(
      'Manual deployments require CI_RELEASE_PULL_REQUEST or explicit CI_RELEASE_NOTE_OPT_OUT=true'
    );
    process.exit(1);
  }
}
if (
  isReleaseNotesEligible &&
  CI_RELEASE_NOTE_GROUPS &&
  releaseNoteGroups?.length === 0
) {
  console.error('CI_RELEASE_NOTE_GROUPS must not be empty without opt-out');
  process.exit(1);
}
const releaseNotesFields = isReleaseNotesEligible
  ? releaseNoteGroups?.length
    ? {
        release_notes_prompt_path: CI_RELEASE_NOTES_PROMPT_PATH,
        release_note_groups: releaseNoteGroups,
        deployed_at: new Date().toISOString()
      }
    : {
        release_notes_prompt_path: CI_RELEASE_NOTES_PROMPT_PATH,
        release_group_id:
          CI_RELEASE_GROUP_ID ||
          (pullRequestNumber
            ? `pr-${pullRequestNumber}`
            : `${repository}:${runId}`),
        release_group_services: releaseGroupServices,
        pull_request_number: pullRequestNumber,
        publish_release_note: CI_RELEASE_NOTE_PUBLISH === 'true',
        deployed_at: new Date().toISOString()
      }
  : {};
let contributorEvidence = null;
if (isReleaseBusOperation) {
  contributorEvidence = 'release-bus-operation';
}
const deployedSha = CI_PIPELINES_SHA || GITHUB_SHA || null;
if (
  status === 'success' &&
  !CI_RELEASE_TRAIN_ID &&
  GITHUB_TOKEN &&
  pullRequestNumber &&
  deployedSha &&
  CI_PIPELINES_SERVICE
) {
  try {
    releaseContributors = await deriveManualPullRequestContributors({
      repository,
      pullRequestNumber,
      deployedSha,
      service: CI_PIPELINES_SERVICE,
      branch: GITHUB_REF_NAME,
      releaseGroupServices
    });
    contributorEvidence = releaseContributors.length ? 'manual-pr' : null;
  } catch (error) {
    console.warn(
      `Contributors row omitted because exact manual deployment scope could not be established: ${getFetchFailureMessage(error)}`
    );
  }
}
const releaseIdentityFields =
  CI_RELEASE_TRAIN_ID && CI_RELEASE_OPERATION_KEY
    ? {
        release_train_id: CI_RELEASE_TRAIN_ID,
        release_operation_key: CI_RELEASE_OPERATION_KEY
      }
    : {};
const contributorFields =
  contributorEvidence && releaseContributors.length
    ? {
        contributor_github_logins: releaseContributors,
        contributor_evidence: contributorEvidence
      }
    : {};

const payload = {
  alert_type: alertType,
  repo: repository.split('/').pop() ?? repository,
  workflow: CI_PIPELINES_WORKFLOW || GITHUB_WORKFLOW || 'GitHub Actions',
  status,
  title,
  description: CI_PIPELINES_DESCRIPTION || null,
  triggered_by_github_login: triggeredByGithubLogin,
  run_id: runId,
  run_number: GITHUB_RUN_NUMBER || null,
  run_attempt: runAttempt,
  run_url: `${GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`,
  sha: deployedSha,
  branch: GITHUB_REF_NAME || null,
  environment: targetEnvironment || null,
  service: CI_PIPELINES_SERVICE || null,
  ...releaseIdentityFields,
  ...contributorFields,
  ...releaseNotesFields
};

const body = Buffer.from(JSON.stringify(payload));
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = crypto
  .createHmac('sha256', CI_PIPELINES_ALERT_SECRET)
  .update(`${timestamp}.`)
  .update(body)
  .digest('hex');

const headers = {
  'content-type': 'application/json',
  'x-6529-ci-timestamp': timestamp,
  'x-6529-ci-signature': `sha256=${signature}`
};

if (CI_PIPELINES_ALERT_API_AUTH) {
  headers['x-6529-auth'] = CI_PIPELINES_ALERT_API_AUTH;
}

const controller = new AbortController();
const timeoutId = setTimeout(
  () => controller.abort(),
  PIPELINES_ALERT_TIMEOUT_MS
);

let response;
let outcome = null;
try {
  response = await fetch(CI_PIPELINES_ALERT_URL, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal
  });
  if (!response.ok) {
    console.error(
      `CI pipeline wave notification failed: ${response.status} ${response.statusText}`
    );
    process.exit(1);
  }
  try {
    outcome = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    // Older receivers returned an empty response. Preserve rollout compatibility.
  }
} catch (error) {
  console.error(
    `CI pipeline wave notification request failed: ${getFetchFailureMessage(error)}`
  );
  process.exit(1);
} finally {
  clearTimeout(timeoutId);
}
if (outcome?.ci_drop === 'accepted') {
  console.log('CI drop accepted.');
} else if (outcome?.ci_drop === 'duplicate') {
  console.log('CI drop already accepted; duplicate notification skipped.');
} else if (outcome?.ci_drop === 'failed') {
  console.error('CI drop processing failed after receiver acceptance.');
} else {
  console.log('CI pipeline wave notification accepted by receiver.');
}
if (outcome?.release_note === 'enqueued') {
  console.log('Release-note request eligible and enqueued.');
} else if (outcome?.release_note === 'queue-failed') {
  console.error(
    `Release-note queue failure: ${outcome.release_note_reason || 'unknown'}`
  );
} else if (
  outcome?.release_note === 'skipped' ||
  outcome?.release_note === 'ineligible'
) {
  console.log(
    `Release-note request ${outcome.release_note}: ${outcome.release_note_reason || 'unspecified'}`
  );
}

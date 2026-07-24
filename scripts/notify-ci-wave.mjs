#!/usr/bin/env node
import crypto from 'node:crypto';

const {
  CI_PIPELINES_ALERT_URL,
  CI_PIPELINES_ALERT_SECRET,
  CI_PIPELINES_ALERT_API_AUTH,
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
  CI_PIPELINES_SHA,
  GITHUB_REPOSITORY,
  GITHUB_WORKFLOW,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_SHA,
  GITHUB_REF_NAME,
  GITHUB_TRIGGERING_ACTOR,
  GITHUB_ACTOR
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
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?:\[bot\])?$/.test(
    value
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
    if (seen.has(key)) continue;
    seen.add(key);
    contributors.push(login);
  }
  return contributors;
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
if (
  CI_RELEASE_TRAIN_ID &&
  !/^[A-Za-z0-9._-]{1,100}$/.test(CI_RELEASE_TRAIN_ID)
) {
  console.error('CI_RELEASE_TRAIN_ID is invalid');
  process.exit(1);
}
if (releaseContributors.length > 0 && !CI_RELEASE_TRAIN_ID) {
  console.error('CI_RELEASE_TRAIN_ID is required with CI_RELEASE_CONTRIBUTORS');
  process.exit(1);
}
if (
  CI_RELEASE_NOTE_OPT_OUT === 'true' &&
  ((releaseNoteGroups?.length ?? 0) > 0 || CI_RELEASE_NOTE_PUBLISH === 'true')
) {
  console.error(
    'Release-note opt-out cannot include release-note groups or a publish request'
  );
  process.exit(1);
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
// Keep the two new fields atomic. During the ordered rollout, the old
// dispatcher supplies an empty array and the old receiver rejects unknown
// fields; the train id has no downstream use unless contributor credits exist.
const releaseTrainFields =
  CI_RELEASE_TRAIN_ID && releaseContributors.length > 0
    ? {
        release_train_id: CI_RELEASE_TRAIN_ID,
        contributor_github_logins: releaseContributors
      }
    : {};

const payload = {
  repo: repository.split('/').pop() ?? repository,
  workflow: CI_PIPELINES_WORKFLOW || GITHUB_WORKFLOW || 'GitHub Actions',
  status,
  title,
  description: CI_PIPELINES_DESCRIPTION || null,
  triggered_by_github_login: triggeredByGithubLogin,
  run_id: runId,
  run_number: GITHUB_RUN_NUMBER || null,
  run_url: `${GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`,
  sha: CI_PIPELINES_SHA || GITHUB_SHA || null,
  branch: GITHUB_REF_NAME || null,
  environment: targetEnvironment || null,
  service: CI_PIPELINES_SERVICE || null,
  ...releaseTrainFields,
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
const timeoutId = setTimeout(() => controller.abort(), 10_000);

let response;
try {
  response = await fetch(CI_PIPELINES_ALERT_URL, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal
  });
} catch (error) {
  console.error(
    `CI pipeline wave notification request failed: ${getFetchFailureMessage(error)}`
  );
  process.exit(1);
} finally {
  clearTimeout(timeoutId);
}

if (!response.ok) {
  console.error(
    `CI pipeline wave notification failed: ${response.status} ${response.statusText}`
  );
  process.exit(1);
}

console.log('CI pipeline wave notification sent.');

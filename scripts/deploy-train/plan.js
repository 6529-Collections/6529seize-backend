'use strict';

const catalogLib = require('./catalog');
const {
  evaluateBlackout,
  holdFor,
  DEFAULT_LOOKAHEAD_MINUTES
} = require('./blackouts');

const MODES = ['off', 'report', 'prod'];
// The CI alert receiver accepts at most 100 release-note groups per deploy.
const MAX_GROUPS_PER_DEPLOY = 100;
// workflow_dispatch inputs share a 65,535-character budget.
const MAX_GROUP_INPUT_CHARS = 60000;

/**
 * The effective train mode. DEPLOY_TRAIN_MODE decides; anything other than
 * report or prod is off. A manual dispatch may ask for a report-only run
 * but can never raise the mode above the variable.
 */
function resolveMode({ variable, requested, eventName }) {
  const raw = typeof variable === 'string' ? variable.trim() : '';
  const configured = MODES.includes(raw) ? raw : 'off';
  const notes = [];
  if (raw && !MODES.includes(raw)) {
    notes.push(
      `DEPLOY_TRAIN_MODE "${raw}" is not off, report or prod; treated as off`
    );
  }
  if (eventName === 'workflow_dispatch' && requested === 'report') {
    if (configured === 'prod')
      notes.push('dispatch requested a report-only run');
    return { mode: 'report', configured, notes };
  }
  return { mode: configured, configured, notes };
}

/**
 * One release-note group per pull request. Each deploy carries only the
 * groups that include its service; a group publishes on the last service
 * of the train that ships its pull request.
 */
function releaseNoteGroups(records) {
  const servicesByPull = new Map();
  const lastByPull = new Map();
  for (const record of records) {
    for (const pull of record.prs) {
      if (!servicesByPull.has(pull)) servicesByPull.set(pull, []);
      servicesByPull.get(pull).push(record.service);
      lastByPull.set(pull, record.service);
    }
  }
  return new Map(
    records.map((record) => [
      record.service,
      record.prs.map((pull) => ({
        release_group_id: `pr-${pull}`,
        release_group_services: servicesByPull
          .get(pull)
          .slice()
          .sort(catalogLib.compareText),
        pull_request_number: pull,
        publish_release_note: lastByPull.get(pull) === record.service
      }))
    ])
  );
}

function deferral(record, reason, kind) {
  return {
    service: record.service,
    kind,
    reason,
    behind_since: record.behind_since,
    prs: record.prs
  };
}

/** Candidates whose dependencies are behind but not shipping must wait. */
function deferDependents(catalog, candidates, heldBack, deferred) {
  const closure = catalogLib.transitiveDependencies(catalog);
  let changed = true;
  let remaining = candidates;
  while (changed) {
    changed = false;
    const next = [];
    for (const record of remaining) {
      const blocker = Array.from(closure.get(record.service)).find((name) =>
        heldBack.has(name)
      );
      if (blocker) {
        deferred.push(
          deferral(record, `waits for dependency ${blocker}`, 'dependency')
        );
        heldBack.add(record.service);
        changed = true;
      } else {
        next.push(record);
      }
    }
    remaining = next;
  }
  return remaining;
}

/** Why a behind service must wait, or null when it can ship now. */
function holdReason(record, service, blackoutOptions) {
  if (record.train.mode === 'manual') {
    return { kind: 'manual', reason: `manual service: ${record.train.reason}` };
  }
  if (record.prs.length === 0) {
    return {
      kind: 'release-notes',
      reason:
        'no merged pull request explains the change; deploy it by hand with release-note metadata'
    };
  }
  if (record.prs.length > MAX_GROUPS_PER_DEPLOY) {
    return {
      kind: 'release-notes',
      reason: `${record.prs.length} pull requests exceed the ${MAX_GROUPS_PER_DEPLOY} release-note groups one deploy can carry; catch up by hand`
    };
  }
  const held = holdFor(service, blackoutOptions.holds || []);
  if (held) return { kind: 'hold', reason: held };
  const blackout = evaluateBlackout(service, blackoutOptions);
  if (!blackout.blocked) return null;
  return {
    kind: 'blackout',
    reason: `quiet window from ${blackout.from}: ${blackout.reasons.join('; ')}`
  };
}

/** Splits drift records into ship candidates and deferrals. */
function triage(catalog, drift, blackoutOptions) {
  const deferred = [];
  const heldBack = new Set();
  const candidates = [];
  for (const record of drift.services) {
    if (record.status === 'error') {
      deferred.push(
        deferral(record, `not assessed: ${record.reasons[0]}`, 'error')
      );
      heldBack.add(record.service);
    } else if (record.status === 'behind') {
      const service = catalogLib.getService(catalog, record.service);
      const hold = holdReason(record, service, blackoutOptions);
      if (hold) {
        deferred.push(deferral(record, hold.reason, hold.kind));
        heldBack.add(record.service);
      } else {
        candidates.push(record);
      }
    }
  }
  return { deferred, heldBack, candidates };
}

/**
 * Defers services whose release-note groups would not fit in one dispatch,
 * with their dependents, until every remaining service fits.
 */
function dropOversized(catalog, shipping, heldBack, deferred) {
  let remaining = shipping;
  for (;;) {
    const groups = releaseNoteGroups(remaining);
    const oversized = remaining.filter(
      (record) =>
        JSON.stringify(groups.get(record.service)).length >
        MAX_GROUP_INPUT_CHARS
    );
    if (oversized.length === 0) return remaining;
    for (const record of oversized) {
      deferred.push(
        deferral(
          record,
          'release-note groups exceed the workflow input size; catch up by hand',
          'release-notes'
        )
      );
      heldBack.add(record.service);
    }
    remaining = deferDependents(
      catalog,
      remaining.filter((record) => !heldBack.has(record.service)),
      heldBack,
      deferred
    );
  }
}

function shipItem(catalog, environment, record, shipping, groups) {
  const service = catalogLib.getService(catalog, record.service);
  return {
    service: record.service,
    deployed_sha: record.deployed.sha,
    deployed_at: record.deployed.completed_at,
    behind_since: record.behind_since,
    prs: record.prs,
    reasons: record.reasons,
    expects_db_auth: record.expects_db_auth,
    region: service.aws_region[environment],
    verification_targets: service.verification_targets,
    validation_profile: service.validation_profile,
    dependencies: Array.from(
      catalogLib.transitiveDependencies(catalog).get(record.service)
    ).filter((dependency) => shipping.has(dependency)),
    release_note_groups: groups.get(record.service)
  };
}

function servicesWithStatus(drift, status) {
  return drift.services
    .filter((record) => record.status === status)
    .map((record) => record.service);
}

/**
 * Turns a drift report into the train's work list: what ships now, in
 * dependency order with release-note groups, and what is deferred and why.
 */
function buildTrainPlan({
  catalog,
  drift,
  mode,
  now = Date.now(),
  teamWindows = [],
  holds = [],
  lookaheadMinutes = DEFAULT_LOOKAHEAD_MINUTES,
  halt = null,
  notes = []
}) {
  const { deferred, heldBack, candidates } = triage(catalog, drift, {
    now,
    teamWindows,
    holds,
    lookaheadMinutes
  });
  const shipping = dropOversized(
    catalog,
    deferDependents(catalog, candidates, heldBack, deferred),
    heldBack,
    deferred
  );
  const byName = new Map(shipping.map((record) => [record.service, record]));
  const ordered = catalogLib
    .dependencyOrder(
      catalog,
      shipping.map((record) => record.service),
      (name) => [Date.parse(byName.get(name).behind_since) || 0]
    )
    .map((name) => byName.get(name));
  const groups = releaseNoteGroups(ordered);
  return {
    mode,
    environment: drift.environment,
    target_sha: drift.target_sha,
    generated_at: new Date(now).toISOString(),
    halt,
    notes,
    lookahead_minutes: lookaheadMinutes,
    ship: ordered.map((record) =>
      shipItem(catalog, drift.environment, record, byName, groups)
    ),
    deferred,
    never_deployed: servicesWithStatus(drift, 'never-deployed'),
    ahead: servicesWithStatus(drift, 'ahead'),
    current_count: servicesWithStatus(drift, 'current').length
  };
}

module.exports = {
  MODES,
  MAX_GROUPS_PER_DEPLOY,
  MAX_GROUP_INPUT_CHARS,
  resolveMode,
  releaseNoteGroups,
  buildTrainPlan
};

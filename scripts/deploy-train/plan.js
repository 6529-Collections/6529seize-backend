'use strict';

const catalogLib = require('./catalog');
const { evaluateBlackout, DEFAULT_LOOKAHEAD_MINUTES } = require('./blackouts');

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
  lookaheadMinutes = DEFAULT_LOOKAHEAD_MINUTES,
  halt = null,
  notes = []
}) {
  const deferred = [];
  const heldBack = new Set();
  const candidates = [];
  for (const record of drift.services) {
    if (record.status === 'error') {
      deferred.push(
        deferral(record, `not assessed: ${record.reasons[0]}`, 'error')
      );
      heldBack.add(record.service);
      continue;
    }
    if (record.status !== 'behind') continue;
    const service = catalogLib.getService(catalog, record.service);
    let reason = null;
    let kind = null;
    if (record.train.mode === 'manual') {
      reason = `manual service: ${record.train.reason}`;
      kind = 'manual';
    } else if (record.prs.length === 0) {
      reason =
        'no merged pull request explains the change; deploy it by hand with release-note metadata';
      kind = 'release-notes';
    } else if (record.prs.length > MAX_GROUPS_PER_DEPLOY) {
      reason = `${record.prs.length} pull requests exceed the ${MAX_GROUPS_PER_DEPLOY} release-note groups one deploy can carry; catch up by hand`;
      kind = 'release-notes';
    } else {
      const blackout = evaluateBlackout(service, {
        now,
        teamWindows,
        lookaheadMinutes
      });
      if (blackout.blocked) {
        reason = `quiet window from ${blackout.from}: ${blackout.reasons.join('; ')}`;
        kind = 'blackout';
      }
    }
    if (reason) {
      deferred.push(deferral(record, reason, kind));
      heldBack.add(record.service);
    } else {
      candidates.push(record);
    }
  }
  let shipping = deferDependents(catalog, candidates, heldBack, deferred);
  let groups = releaseNoteGroups(shipping);
  for (;;) {
    const oversized = shipping.filter(
      (record) =>
        JSON.stringify(groups.get(record.service)).length >
        MAX_GROUP_INPUT_CHARS
    );
    if (oversized.length === 0) break;
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
    shipping = deferDependents(
      catalog,
      shipping.filter((record) => !heldBack.has(record.service)),
      heldBack,
      deferred
    );
    groups = releaseNoteGroups(shipping);
  }
  const byName = new Map(shipping.map((record) => [record.service, record]));
  const order = catalogLib.dependencyOrder(
    catalog,
    shipping.map((record) => record.service),
    (name) => [Date.parse(byName.get(name).behind_since) || 0]
  );
  groups = releaseNoteGroups(order.map((name) => byName.get(name)));
  const ship = order.map((name) => {
    const record = byName.get(name);
    const service = catalogLib.getService(catalog, name);
    return {
      service: name,
      deployed_sha: record.deployed.sha,
      deployed_at: record.deployed.completed_at,
      behind_since: record.behind_since,
      prs: record.prs,
      reasons: record.reasons,
      expects_db_auth: record.expects_db_auth,
      region: service.aws_region[drift.environment],
      verification_targets: service.verification_targets,
      validation_profile: service.validation_profile,
      dependencies: Array.from(
        catalogLib.transitiveDependencies(catalog).get(name)
      ).filter((dependency) => byName.has(dependency)),
      release_note_groups: groups.get(name)
    };
  });
  return {
    mode,
    environment: drift.environment,
    target_sha: drift.target_sha,
    generated_at: new Date(now).toISOString(),
    halt,
    notes,
    lookahead_minutes: lookaheadMinutes,
    ship,
    deferred,
    never_deployed: drift.services
      .filter((record) => record.status === 'never-deployed')
      .map((record) => record.service),
    ahead: drift.services
      .filter((record) => record.status === 'ahead')
      .map((record) => record.service),
    current_count: drift.services.filter(
      (record) => record.status === 'current'
    ).length
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

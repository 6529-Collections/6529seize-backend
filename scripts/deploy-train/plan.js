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

// The release-note receiver remembers a group's services for seven days.
const LEDGER_DAYS = 7;

/** Ledger groups still worth reusing: recent and with a member still behind. */
function activeLedger(ledgerGroups, behindByPull, now) {
  const active = {};
  for (const [pull, entry] of Object.entries(ledgerGroups || {})) {
    const fresh = now - Date.parse(entry.opened_at) < LEDGER_DAYS * 86_400_000;
    const open = (behindByPull.get(Number(pull)) || []).some((service) =>
      entry.services.includes(service)
    );
    if (fresh && open) active[pull] = entry;
  }
  return active;
}

/** Behind services by the pull request numbers they list. */
function behindServicesByPull(records) {
  const byPull = new Map();
  for (const record of records) {
    if (record.status !== 'behind') continue;
    for (const pull of record.prs) {
      if (!byPull.has(pull)) byPull.set(pull, []);
      byPull.get(pull).push(record.service);
    }
  }
  return byPull;
}

/**
 * Release-note groups, one per pull request, with a service set that stays
 * the same across trains. The receiver keeps the first set it sees for a
 * group and publishes only once every member has reported, so a group's
 * members are fixed when it first ships: every service then behind with
 * that pull request, shipping or not (held, deferred, in a quiet window).
 * The ledger keeps that set for later trains. A group asks to publish only
 * on the deploy that completes it: the last shipping member, when no other
 * member is still behind.
 *
 * Returns, per shipping service, its groups and, per pull request, the
 * members still outstanding (behind) when the plan was made.
 */
function releaseNoteGroups(shipping, behindRecords, ledgerGroups = {}) {
  const behindByPull = behindServicesByPull(behindRecords);
  const members = (pull) =>
    ledgerGroups[pull]?.services ||
    (behindByPull.get(pull) || []).slice().sort(catalogLib.compareText);
  const shippingNames = new Set(shipping.map((record) => record.service));
  const lastShipping = new Map();
  for (const record of shipping) {
    for (const pull of record.prs) lastShipping.set(pull, record.service);
  }
  const outstanding = (pull) =>
    (behindByPull.get(pull) || []).filter((service) =>
      members(pull).includes(service)
    );
  const groups = new Map();
  const outstandingByService = new Map();
  for (const record of shipping) {
    const pulls = record.prs.filter((pull) =>
      members(pull).includes(record.service)
    );
    groups.set(
      record.service,
      pulls.map((pull) => ({
        release_group_id: `pr-${pull}`,
        release_group_services: members(pull),
        pull_request_number: pull,
        publish_release_note:
          lastShipping.get(pull) === record.service &&
          outstanding(pull).every((service) => shippingNames.has(service))
      }))
    );
    outstandingByService.set(
      record.service,
      Object.fromEntries(pulls.map((pull) => [pull, outstanding(pull)]))
    );
  }
  return { groups, outstanding: outstandingByService };
}

/** Services whose pull requests all belong to groups fixed without them. */
function outsideTheirGroups(shipping, behindRecords, ledgerGroups) {
  const { groups } = releaseNoteGroups(shipping, behindRecords, ledgerGroups);
  return shipping.filter(
    (record) => record.prs.length > 0 && groups.get(record.service).length === 0
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
  const unattributed = record.unattributed_commits || [];
  if (unattributed.length > 0) {
    // Shipping would deploy changes the release notes cannot describe.
    const commits = unattributed.map((sha) => sha.slice(0, 10)).join(', ');
    return {
      kind: 'release-notes',
      reason: `commits without a merged pull request also change it (${commits}); deploy it by hand with release-note metadata`
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
  // A hold also protects the services that depend on the held one, whether
  // or not the held service is behind: after a scoped hand-run deploy it can
  // look current while its operator step (a backfill, say) is still running.
  const heldBack = new Set(
    catalog.services
      .filter((service) => holdFor(service, blackoutOptions.holds || []))
      .map((service) => service.name)
  );
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
function dropOversized(catalog, shipping, context, heldBack, deferred) {
  let remaining = shipping;
  for (;;) {
    const { groups } = releaseNoteGroups(
      remaining,
      context.behindRecords,
      context.ledgerGroups
    );
    const oversized = remaining.filter(
      (record) =>
        JSON.stringify(groups.get(record.service)).length >
        MAX_GROUP_INPUT_CHARS
    );
    const outside = outsideTheirGroups(
      remaining,
      context.behindRecords,
      context.ledgerGroups
    );
    if (oversized.length === 0 && outside.length === 0) return remaining;
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
    for (const record of outside) {
      deferred.push(
        deferral(
          record,
          'its pull requests already have release-note groups fixed without it; deploy it by hand',
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

function shipItem(catalog, environment, record, shipping, release) {
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
    // Every catalog dependency, shipping or not, so the train can re-check
    // holds on them right before dispatch.
    catalog_dependencies: Array.from(
      catalogLib.transitiveDependencies(catalog).get(record.service)
    ).sort(catalogLib.compareText),
    release_note_groups: release.groups.get(record.service),
    // Group members still behind at planning time, by pull request, so the
    // train can tell at run time which deploy completes each group.
    release_note_outstanding: release.outstanding.get(record.service)
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
  notes = [],
  ledger = {}
}) {
  const context = {
    behindRecords: drift.services,
    ledgerGroups: activeLedger(
      ledger,
      behindServicesByPull(drift.services),
      now
    )
  };
  const { deferred, heldBack, candidates } = triage(catalog, drift, {
    now,
    teamWindows,
    holds,
    lookaheadMinutes
  });
  const shipping = dropOversized(
    catalog,
    deferDependents(catalog, candidates, heldBack, deferred),
    context,
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
  const release = releaseNoteGroups(
    ordered,
    context.behindRecords,
    context.ledgerGroups
  );
  return {
    mode,
    environment: drift.environment,
    target_sha: drift.target_sha,
    generated_at: new Date(now).toISOString(),
    halt,
    notes,
    lookahead_minutes: lookaheadMinutes,
    ship: ordered.map((record) =>
      shipItem(catalog, drift.environment, record, byName, release)
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
  LEDGER_DAYS,
  resolveMode,
  releaseNoteGroups,
  activeLedger,
  buildTrainPlan
};

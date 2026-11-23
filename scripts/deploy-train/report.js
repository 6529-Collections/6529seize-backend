'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ALERT_DESCRIPTION = 4800;
const ESCAPED_PIPE = String.raw`\|`;

function shortSha(sha) {
  return sha ? sha.slice(0, 10) : 'none';
}

function plural(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function formatAge(since, now) {
  if (!since) return 'unknown';
  const elapsed = Math.max(0, now - Date.parse(since));
  if (elapsed < HOUR_MS) return `${Math.round(elapsed / 60000)} min`;
  if (elapsed < 2 * DAY_MS) return `${Math.round(elapsed / HOUR_MS)} h`;
  return `${Math.round(elapsed / DAY_MS)} days`;
}

function escapeCell(text) {
  return String(text).replace(/\r?\n|\|/g, (match) =>
    match === '|' ? ESCAPED_PIPE : ' '
  );
}

function summarizeReasons(reasons, limit = 3) {
  const shown = reasons.slice(0, limit).join('; ');
  return reasons.length > limit
    ? `${shown}; +${reasons.length - limit} more`
    : shown;
}

function formatPulls(prs, limit = 8) {
  if (prs.length === 0) return '-';
  const shown = prs
    .slice(-limit)
    .map((pr) => `#${pr}`)
    .join(' ');
  return prs.length > limit ? `${prs.length} PRs (latest ${shown})` : shown;
}

function serviceNames(records) {
  return records.map((record) => record.service).join(', ');
}

function groupByStatus(drift) {
  const groups = {
    behind: [],
    error: [],
    'never-deployed': [],
    ahead: [],
    current: []
  };
  for (const record of drift.services) {
    (groups[record.status] || groups.error).push(record);
  }
  return groups;
}

function behindRow(record, now) {
  const manual = record.train.mode === 'manual' ? ' (manual)' : '';
  const deployed = `${shortSha(record.deployed?.sha)} ${record.deployed?.completed_at || ''}`;
  const pulls = escapeCell(formatPulls(record.prs));
  const reasons = escapeCell(summarizeReasons(record.reasons));
  return `| ${record.service}${manual} | ${deployed} | ${formatAge(record.behind_since, now)} | ${pulls} | ${reasons} |`;
}

/** Markdown for the job summary of a drift run. */
function renderDriftMarkdown(drift, now = Date.parse(drift.generated_at)) {
  const groups = groupByStatus(drift);
  const { stats } = drift;
  const lines = [
    `## ${drift.environment} drift against ${shortSha(drift.target_sha)}`,
    '',
    `Target committed ${drift.target_committed_at}; ${stats.services} services checked in ${stats.seconds}s ` +
      `(${stats.builds} builds, ${stats.cache_hits} cached, ${stats.reused_target_bundle} unchanged inputs).`,
    ''
  ];
  if (groups.behind.length === 0 && groups.error.length === 0) {
    lines.push(
      'Nothing is behind: every deployed artifact matches the target.'
    );
  } else {
    lines.push(
      `### Behind (${groups.behind.length}), in deploy order`,
      '',
      '| Service | Deployed | Behind for | PRs | Why |',
      '| --- | --- | --- | --- | --- |',
      ...groups.behind.map((record) => behindRow(record, now))
    );
  }
  if (groups.error.length > 0) {
    lines.push(
      '',
      `### Could not assess (${groups.error.length})`,
      '',
      ...groups.error.map(
        (record) =>
          `- ${record.service}: ${escapeCell(record.reasons.join('; '))}`
      )
    );
  }
  if (groups['never-deployed'].length > 0) {
    lines.push(
      '',
      `Never deployed to ${drift.environment}: ${serviceNames(groups['never-deployed'])}. A first deploy creates new infrastructure and stays manual.`
    );
  }
  if (groups.ahead.length > 0) {
    lines.push(
      '',
      `Deployed ahead of the target: ${serviceNames(groups.ahead)}.`
    );
  }
  lines.push('', `Current: ${groups.current.length} services.`);
  return `${lines.join('\n')}\n`;
}

function truncate(text, limit = MAX_ALERT_DESCRIPTION) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function branchLabel(environment) {
  return environment === 'prod' ? 'main' : '1a-staging';
}

function behindLine(record, now) {
  const since = shortSha(record.deployed?.sha);
  const pulls = formatPulls(record.prs, 4);
  return `${record.service}: behind ${formatAge(record.behind_since, now)} since ${since}, ${pulls}; ${summarizeReasons(record.reasons, 2)}`;
}

/** Wave alert fields for the daily drift report. */
function driftAlert(drift, now = Date.parse(drift.generated_at)) {
  const groups = groupByStatus(drift);
  const behind = groups.behind.length;
  const errors = groups.error.length;
  const branch = `${branchLabel(drift.environment)} ${shortSha(drift.target_sha)}`;
  const neverDeployed = serviceNames(groups['never-deployed']);
  if (behind === 0 && errors === 0) {
    const notes = neverDeployed ? ` Never deployed: ${neverDeployed}.` : '';
    return {
      status: 'success',
      title: `Backend drift check: every ${drift.environment} service matches ${branch}`,
      description: `${groups.current.length} services current.${notes}`
    };
  }
  const lines = groups.behind.map((record) => behindLine(record, now));
  for (const record of groups.error) {
    lines.push(`${record.service}: could not assess (${record.reasons[0]})`);
  }
  if (neverDeployed) lines.push(`Never deployed: ${neverDeployed}`);
  const parts = [];
  const noun = `${drift.environment} service`;
  if (behind) parts.push(`${plural(behind, noun)} behind`);
  if (errors) parts.push(`${errors} not assessed`);
  return {
    status: 'failure',
    title: `Backend drift: ${parts.join(', ')} ${branch}`,
    description: truncate(lines.join('\n'))
  };
}

function publishedPulls(item) {
  return item.release_note_groups
    .filter((group) => group.publish_release_note)
    .map((group) => `#${group.pull_request_number}`);
}

function deferredLines(deferred) {
  return deferred.map((entry) => `- ${entry.service}: ${entry.reason}`);
}

function planRow(item, index, now) {
  const pulls = escapeCell(formatPulls(item.prs));
  const published = publishedPulls(item).join(' ') || '-';
  const reasons = escapeCell(summarizeReasons(item.reasons, 2));
  return `| ${index + 1} | ${item.service} | ${formatAge(item.behind_since, now)} | ${pulls} | ${published} | ${reasons} |`;
}

/** Job summary for a train plan, in report or prod mode. */
function renderPlanMarkdown(plan, now = Date.parse(plan.generated_at)) {
  const verb = plan.mode === 'prod' ? 'Shipping' : 'Would ship';
  const lines = [
    `## Deploy train (${plan.mode}) at ${shortSha(plan.target_sha)}`,
    ''
  ];
  for (const note of plan.notes) lines.push(`> ${note}`, '');
  if (plan.halt) {
    lines.push(
      `**Halted** by [${plan.halt.label}](${plan.halt.url}) after a failed deploy or health check. ` +
        'Nothing ships until someone fixes the cause and dispatches Deploy train with resume=true.',
      ''
    );
  }
  if (plan.ship.length === 0) {
    lines.push('Nothing to ship: every automatic service matches the target.');
  } else {
    lines.push(
      `### ${verb} (${plan.ship.length}), in order`,
      '',
      '| # | Service | Behind for | PRs | Publishes notes for | Why |',
      '| --- | --- | --- | --- | --- | --- |',
      ...plan.ship.map((item, index) => planRow(item, index, now))
    );
  }
  if (plan.deferred.length > 0) {
    lines.push(
      '',
      `### Deferred (${plan.deferred.length})`,
      '',
      ...deferredLines(plan.deferred)
    );
  }
  if (plan.never_deployed.length > 0) {
    lines.push(
      '',
      `Never deployed (manual first deploy): ${plan.never_deployed.join(', ')}.`
    );
  }
  if (plan.ahead.length > 0) {
    lines.push('', `Deployed ahead of the target: ${plan.ahead.join(', ')}.`);
  }
  lines.push('', `Current: ${plan.current_count} services.`);
  return `${lines.join('\n')}\n`;
}

/** Wave alert for a report-mode plan; null when there is nothing to say. */
function planAlert(plan) {
  if (plan.ship.length === 0) return null;
  const lines = plan.ship.map(
    (item, index) =>
      `${index + 1}. ${item.service} (${formatPulls(item.prs, 4)})`
  );
  if (plan.deferred.length > 0) {
    const deferred = plan.deferred
      .map((entry) => `${entry.service} (${entry.kind})`)
      .join(', ');
    lines.push(`Deferred: ${deferred}`);
  }
  return {
    status: 'success',
    title: `Deploy train (report only): would ship ${plural(plan.ship.length, 'service')} at ${shortSha(plan.target_sha)}`,
    description: truncate(lines.join('\n'))
  };
}

const STOP_LABELS = {
  'main-moved': 'main moved',
  busy: 'another deploy kept running',
  'time-budget': 'time budget used',
  'deploy-cancelled': 'deploy cancelled',
  'deploy-failed': 'deploy failed',
  'deploy-unknown': 'deploy run not found',
  unhealthy: 'health check failed'
};

function stopLabel(stop) {
  return STOP_LABELS[stop.reason] || stop.reason;
}

function stopLines(stop) {
  if (!stop) return [];
  const lines = [
    `${stop.halt ? '**Halted**' : 'Stopped'}: ${stopLabel(stop)}. ${stop.detail}`,
    ''
  ];
  if (stop.halt) {
    lines.push(
      'Rollback is manual: revert or fix forward on main, or redeploy a known-good commit through Deploy a service. ' +
        'Then dispatch Deploy train with resume=true.',
      ''
    );
  }
  return lines;
}

const HEALTH_LABELS = {
  healthy: 'healthy',
  unhealthy: 'unhealthy',
  unverified: 'not yet verified',
  pending: 'not yet verified',
  skipped: 'checked by the deploy workflow'
};

function healthLabel(status) {
  return HEALTH_LABELS[status] || status;
}

function shippedRow(item) {
  const run = item.run_url
    ? `[${item.run_id}](${item.run_url})`
    : String(item.run_id);
  const note = item.note ? ` (${escapeCell(item.note)})` : '';
  return `| ${item.service} | ${run} | ${healthLabel(item.health)}${note} |`;
}

/** Job summary for a finished train run. */
function renderTrainMarkdown(plan, result) {
  const lines = [
    `## Deploy train result at ${shortSha(plan.target_sha)}`,
    '',
    ...stopLines(result.stop)
  ];
  if (result.shipped.length > 0) {
    lines.push(
      '| Service | Deploy run | Health |',
      '| --- | --- | --- |',
      ...result.shipped.map(shippedRow)
    );
  } else {
    lines.push('No service was deployed.');
  }
  if (result.deferred.length > 0) {
    lines.push(
      '',
      'Deferred while running:',
      ...deferredLines(result.deferred)
    );
  }
  if (result.not_started.length > 0) {
    lines.push('', `Not started: ${result.not_started.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

function shippedLine(item) {
  const note = item.note ? ` (${item.note})` : '';
  return `${item.service}: ${healthLabel(item.health)}${note}`;
}

function haltAlert(plan, result) {
  const lines = [
    `${stopLabel(result.stop)}: ${result.stop.detail}`,
    'The train is halted. Revert or fix forward on main, check the service, then dispatch Deploy train with resume=true.'
  ];
  if (result.shipped.length > 0) {
    lines.push(
      `Shipped before the halt: ${result.shipped.map(shippedLine).join('; ')}`
    );
  }
  if (result.not_started.length > 0) {
    lines.push(`Not started: ${result.not_started.join(', ')}`);
  }
  return {
    status: 'failure',
    title: `Deploy train halted at ${result.stop.service || 'start'} (${shortSha(plan.target_sha)})`,
    description: truncate(lines.join('\n'))
  };
}

/** Wave alert for a prod train run; null when it did nothing worth a post. */
function trainAlert(plan, result) {
  if (result.stop?.halt) return haltAlert(plan, result);
  if (result.shipped.length === 0) return null;
  const lines = result.shipped.map(shippedLine);
  const unverified = result.shipped.filter(
    (item) => item.health === 'unverified'
  );
  if (unverified.length > 0) {
    lines.push(
      `Not yet verified (the new build was not invoked during the train): ${serviceNames(unverified)}`
    );
  }
  if (result.stop) {
    lines.push(`Stopped: ${stopLabel(result.stop)}. ${result.stop.detail}`);
  }
  const deferred = result.deferred.concat(plan.deferred);
  if (deferred.length > 0) lines.push(`Deferred: ${serviceNames(deferred)}`);
  return {
    status: 'success',
    title: `Deploy train shipped ${plural(result.shipped.length, 'service')} at ${shortSha(plan.target_sha)}`,
    description: truncate(lines.join('\n'))
  };
}

/** Title and body of the issue that keeps a halted train halted. */
function haltIssue(plan, result, runUrl) {
  const stop = result?.stop;
  const service = stop?.service || 'start';
  const lines = stop
    ? [`**${stopLabel(stop)}**: ${stop.detail}`]
    : ['The ship job failed before it could record a result.'];
  lines.push(
    '',
    `Train run: ${runUrl}`,
    `Commit: ${plan?.target_sha || 'unknown'}`
  );
  if (result?.shipped?.length > 0) {
    lines.push(
      `Shipped before the halt: ${result.shipped.map(shippedLine).join('; ')}`
    );
  }
  if (result?.not_started?.length > 0) {
    lines.push(`Not started: ${result.not_started.join(', ')}`);
  }
  lines.push(
    '',
    'The deploy train ships nothing while this issue is uncleared.',
    'Fix forward or revert on main, check the service, then dispatch **Deploy train** with `resume=true`.',
    'Closing this issue by hand does not resume the train.'
  );
  return {
    title: `Deploy train halted at ${service} (${shortSha(plan?.target_sha)})`,
    body: lines.join('\n')
  };
}

module.exports = {
  haltIssue,
  shortSha,
  formatAge,
  formatPulls,
  renderDriftMarkdown,
  driftAlert,
  renderPlanMarkdown,
  planAlert,
  renderTrainMarkdown,
  trainAlert,
  truncate
};

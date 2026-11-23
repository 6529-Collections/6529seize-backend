'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ALERT_DESCRIPTION = 4800;

function shortSha(sha) {
  return sha ? sha.slice(0, 10) : 'none';
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
    match === '|' ? '\\|' : ' '
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
  const shown = prs.slice(-limit).map((pr) => `#${pr}`);
  return prs.length > limit
    ? `${prs.length} PRs (latest ${shown.join(' ')})`
    : shown.join(' ');
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

/** Markdown for the job summary of a drift run. */
function renderDriftMarkdown(drift, now = Date.parse(drift.generated_at)) {
  const groups = groupByStatus(drift);
  const lines = [
    `## ${drift.environment} drift against ${shortSha(drift.target_sha)}`,
    '',
    `Target committed ${drift.target_committed_at}; ${drift.stats.services} services checked in ${drift.stats.seconds}s ` +
      `(${drift.stats.builds} builds, ${drift.stats.cache_hits} cached, ${drift.stats.reused_target_bundle} unchanged inputs).`,
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
      '| --- | --- | --- | --- | --- |'
    );
    for (const record of groups.behind) {
      const manual = record.train.mode === 'manual' ? ' (manual)' : '';
      lines.push(
        `| ${record.service}${manual} | ${shortSha(record.deployed && record.deployed.sha)} ${(record.deployed && record.deployed.completed_at) || ''} | ${formatAge(record.behind_since, now)} | ${escapeCell(formatPulls(record.prs))} | ${escapeCell(summarizeReasons(record.reasons))} |`
      );
    }
  }
  if (groups.error.length > 0) {
    lines.push('', `### Could not assess (${groups.error.length})`, '');
    for (const record of groups.error) {
      lines.push(
        `- ${record.service}: ${escapeCell(record.reasons.join('; '))}`
      );
    }
  }
  if (groups['never-deployed'].length > 0) {
    lines.push(
      '',
      `Never deployed to ${drift.environment}: ${groups['never-deployed'].map((record) => record.service).join(', ')}. A first deploy creates new infrastructure and stays manual.`
    );
  }
  if (groups.ahead.length > 0) {
    lines.push(
      '',
      `Deployed ahead of the target: ${groups.ahead.map((record) => record.service).join(', ')}.`
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

/** Wave alert fields for the daily drift report. */
function driftAlert(drift, now = Date.parse(drift.generated_at)) {
  const groups = groupByStatus(drift);
  const behind = groups.behind.length;
  const errors = groups.error.length;
  const environmentLabel = drift.environment;
  const branch = `${branchLabel(drift.environment)} ${shortSha(drift.target_sha)}`;
  if (behind === 0 && errors === 0) {
    const notes = groups['never-deployed'].length
      ? ` Never deployed: ${groups['never-deployed'].map((record) => record.service).join(', ')}.`
      : '';
    return {
      status: 'success',
      title: `Backend drift check: every ${environmentLabel} service matches ${branch}`,
      description: `${groups.current.length} services current.${notes}`
    };
  }
  const lines = groups.behind.map(
    (record) =>
      `${record.service}: behind ${formatAge(record.behind_since, now)} since ${shortSha(record.deployed && record.deployed.sha)}, ${formatPulls(record.prs, 4)}; ${summarizeReasons(record.reasons, 2)}`
  );
  for (const record of groups.error) {
    lines.push(`${record.service}: could not assess (${record.reasons[0]})`);
  }
  if (groups['never-deployed'].length) {
    lines.push(
      `Never deployed: ${groups['never-deployed'].map((record) => record.service).join(', ')}`
    );
  }
  const parts = [];
  if (behind) {
    parts.push(
      `${behind} ${environmentLabel} service${behind === 1 ? '' : 's'} behind`
    );
  }
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
      `**Halted** by [run ${plan.halt.run_id}](${plan.halt.run_url}) after a failed deploy or health check. ` +
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
      '| --- | --- | --- | --- | --- | --- |'
    );
    plan.ship.forEach((item, index) => {
      lines.push(
        `| ${index + 1} | ${item.service} | ${formatAge(item.behind_since, now)} | ${escapeCell(formatPulls(item.prs))} | ${publishedPulls(item).join(' ') || '-'} | ${escapeCell(summarizeReasons(item.reasons, 2))} |`
      );
    });
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
    lines.push(
      `Deferred: ${plan.deferred.map((entry) => `${entry.service} (${entry.kind})`).join(', ')}`
    );
  }
  const count = plan.ship.length;
  return {
    status: 'success',
    title: `Deploy train (report only): would ship ${count} service${count === 1 ? '' : 's'} at ${shortSha(plan.target_sha)}`,
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

/** Job summary for a finished train run. */
function renderTrainMarkdown(plan, result) {
  const lines = [`## Deploy train result at ${shortSha(plan.target_sha)}`, ''];
  if (result.stop) {
    lines.push(
      `${result.stop.halt ? '**Halted**' : 'Stopped'}: ${stopLabel(result.stop)}. ${result.stop.detail}`,
      ''
    );
    if (result.stop.halt) {
      lines.push(
        'Rollback is manual: revert or fix forward on main, or redeploy a known-good commit through Deploy a service. ' +
          'Then dispatch Deploy train with resume=true.',
        ''
      );
    }
  }
  if (result.shipped.length > 0) {
    lines.push('| Service | Deploy run | Health |', '| --- | --- | --- |');
    for (const item of result.shipped) {
      const run = item.run_url
        ? `[${item.run_id}](${item.run_url})`
        : String(item.run_id);
      const note = item.note ? ` (${escapeCell(item.note)})` : '';
      lines.push(`| ${item.service} | ${run} | ${item.health}${note} |`);
    }
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

/** Wave alert for a prod train run; null when it did nothing worth a post. */
function trainAlert(plan, result) {
  const shipped = result.shipped.map(
    (item) =>
      `${item.service}: ${item.health}${item.note ? ` (${item.note})` : ''}`
  );
  if (result.stop && result.stop.halt) {
    const lines = [
      `${stopLabel(result.stop)}: ${result.stop.detail}`,
      'The train is halted. Revert or fix forward on main, check the service, then dispatch Deploy train with resume=true.'
    ];
    if (shipped.length > 0) {
      lines.push(`Shipped before the halt: ${shipped.join('; ')}`);
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
  if (result.shipped.length === 0) return null;
  const lines = [...shipped];
  if (result.stop) {
    lines.push(`Stopped: ${stopLabel(result.stop)}. ${result.stop.detail}`);
  }
  const deferred = result.deferred.concat(plan.deferred);
  if (deferred.length > 0) {
    lines.push(
      `Deferred: ${deferred.map((entry) => entry.service).join(', ')}`
    );
  }
  const count = result.shipped.length;
  return {
    status: 'success',
    title: `Deploy train shipped ${count} service${count === 1 ? '' : 's'} at ${shortSha(plan.target_sha)}`,
    description: truncate(lines.join('\n'))
  };
}

module.exports = {
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

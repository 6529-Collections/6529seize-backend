'use strict';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT_WEEKDAYS = {
  Sun: 'sun',
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat'
};
const MINUTE_MS = 60_000;
const MAX_TEAM_WINDOW_DAYS = 31;
const DEFAULT_LOOKAHEAD_MINUTES = 15;
const formatters = new Map();

function parseClock(value) {
  if (value === '24:00') return 24 * 60;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid HH:MM time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function zonedParts(date, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    formatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    weekday: SHORT_WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function previousWeekday(weekday) {
  return WEEKDAYS[(WEEKDAYS.indexOf(weekday) + 6) % 7];
}

/**
 * Whether a catalog `window` rule covers `date`. `days` names the day on
 * which a window starts, so an overnight window that starts on Monday also
 * covers the early hours of Tuesday.
 */
function isWindowRuleActive(rule, date) {
  const { weekday, minutes } = zonedParts(date, rule.timezone || 'UTC');
  const start = parseClock(rule.start);
  const end = parseClock(rule.end);
  const startsOn = (day) => !rule.days || rule.days.includes(day);
  if (start < end) {
    return minutes >= start && minutes < end && startsOn(weekday);
  }
  if (minutes >= start) return startsOn(weekday);
  if (minutes < end) return startsOn(previousWeekday(weekday));
  return false;
}

function describeRule(rule) {
  const days = rule.days ? ` ${rule.days.join('/')}` : '';
  return `${rule.reason} (${rule.start}-${rule.end}${days} ${rule.timezone || 'UTC'})`;
}

function parseInstant(value, label) {
  const time =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (Number.isNaN(time)) {
    throw new TypeError(
      `${label} must be a UTC timestamp like 2026-11-25T14:00Z`
    );
  }
  return time;
}

function validateTeamWindow(window, label) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(window)) {
    if (!['start', 'end', 'services', 'reason', 'owner'].includes(key)) {
      throw new Error(`${label} has unsupported field ${key}`);
    }
  }
  const start = parseInstant(window.start, `${label}.start`);
  const end = parseInstant(window.end, `${label}.end`);
  if (end <= start) throw new Error(`${label}.end must be after start`);
  if (end - start > MAX_TEAM_WINDOW_DAYS * 24 * 60 * MINUTE_MS) {
    throw new Error(
      `${label} is longer than ${MAX_TEAM_WINDOW_DAYS} days; set DEPLOY_TRAIN_MODE=off instead`
    );
  }
  if (
    !Array.isArray(window.services) ||
    window.services.length === 0 ||
    window.services.some(
      (service) => typeof service !== 'string' || service.trim() === ''
    )
  ) {
    throw new Error(`${label}.services must list services or "*"`);
  }
  if (typeof window.reason !== 'string' || window.reason.trim() === '') {
    throw new Error(`${label}.reason is required`);
  }
  return {
    start,
    end,
    services: window.services.map((service) => service.trim()),
    reason: window.reason.trim(),
    owner: typeof window.owner === 'string' ? window.owner.trim() : null
  };
}

/**
 * Parses announced team windows from the committed file and the repository
 * variable. Any malformed source throws: the train must not ignore a freeze
 * that someone tried to announce.
 */
function parseTeamWindows(sources, knownServices) {
  const windows = [];
  for (const { name, text } of sources) {
    if (typeof text !== 'string' || text.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${name} is not valid JSON`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.windows;
    if (!Array.isArray(list)) {
      throw new TypeError(`${name} must be a list or an object with "windows"`);
    }
    list.forEach((entry, index) => {
      const window = validateTeamWindow(entry, `${name}[${index}]`);
      for (const service of window.services) {
        if (service !== '*' && knownServices && !knownServices.has(service)) {
          throw new Error(`${name}[${index}] names unknown service ${service}`);
        }
      }
      windows.push({ ...window, source: name });
    });
  }
  return windows;
}

function isoMinute(time) {
  return `${new Date(time).toISOString().slice(0, 16)}Z`;
}

function blackoutReasonsAt(service, time, teamWindows) {
  const reasons = [];
  const date = new Date(time);
  const activeTeamWindows = teamWindows.filter(
    (window) => window.start <= time && time < window.end
  );
  for (const rule of service.deploy_blackouts || []) {
    if (rule.type === 'window' && isWindowRuleActive(rule, date)) {
      reasons.push(describeRule(rule));
    }
    if (rule.type === 'team-freeze' && activeTeamWindows.length > 0) {
      reasons.push(
        `${rule.reason} (team window: ${activeTeamWindows[0].reason})`
      );
    }
  }
  for (const window of activeTeamWindows) {
    if (
      window.services.includes('*') ||
      window.services.includes(service.name)
    ) {
      reasons.push(
        `team window until ${isoMinute(window.end)}: ${window.reason}`
      );
    }
  }
  return reasons;
}

/**
 * A service is blocked when any of its blackouts, or an announced team
 * window, is active at any minute from `now` to `now + lookaheadMinutes`.
 * The look-ahead keeps a deploy from starting just before a quiet window.
 */
function evaluateBlackout(
  service,
  { now, teamWindows = [], lookaheadMinutes = DEFAULT_LOOKAHEAD_MINUTES }
) {
  for (let minute = 0; minute <= lookaheadMinutes; minute++) {
    const time = now + minute * MINUTE_MS;
    const reasons = blackoutReasonsAt(service, time, teamWindows);
    if (reasons.length > 0) {
      return { blocked: true, reasons, from: isoMinute(time) };
    }
  }
  return { blocked: false, reasons: [], from: null };
}

module.exports = {
  DEFAULT_LOOKAHEAD_MINUTES,
  MAX_TEAM_WINDOW_DAYS,
  parseClock,
  zonedParts,
  isWindowRuleActive,
  parseTeamWindows,
  evaluateBlackout
};

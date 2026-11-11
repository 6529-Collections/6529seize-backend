import { Logger } from '@/logging';

/**
 * Operator controls for the websocket fan-out (waves 1.2). Both are read on
 * use, so a Lambda configuration change takes effect without a redeploy, and
 * a deploy that sets nothing gets the code defaults.
 */

/**
 * Concurrent gateway sends per fan-out when `WS_FANOUT_CONCURRENCY` is unset.
 * 64 was tried in prod (#2384) and made fan-outs slower: one container
 * already delivers at its ceiling (~300 sends/s) at 16, so a wider pool only
 * queued sends (per-send p50 38 -> 153 ms). `fanout_cpu_ms` and
 * `fanout_claim_ms` on WAVE_FANOUT measure that ceiling.
 */
export const WS_FANOUT_CONCURRENCY_DEFAULT = 16;
export const WS_FANOUT_CONCURRENCY_MIN = 1;
export const WS_FANOUT_CONCURRENCY_MAX = 128;

const logger = Logger.get('WS_FANOUT_SETTINGS');
const warned = new Set<string>();

function warnOnce(name: string, value: string, applied: string) {
  const key = `${name}=${value}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(
    `Invalid ${name}=${JSON.stringify(value)}; using ${applied} instead`
  );
}

/**
 * `WS_FANOUT_CONCURRENCY`: how many gateway sends one fan-out keeps in
 * flight. Unset or blank uses the default; whole numbers are clamped to
 * 1–128; anything else uses the default. Both corrections log a warning.
 */
export function wsFanoutConcurrency(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.WS_FANOUT_CONCURRENCY?.trim();
  if (!raw) return WS_FANOUT_CONCURRENCY_DEFAULT;
  if (!/^[+-]?\d+$/.test(raw)) {
    warnOnce(
      'WS_FANOUT_CONCURRENCY',
      raw,
      String(WS_FANOUT_CONCURRENCY_DEFAULT)
    );
    return WS_FANOUT_CONCURRENCY_DEFAULT;
  }
  const requested = Number(raw);
  const applied = Math.min(
    WS_FANOUT_CONCURRENCY_MAX,
    Math.max(WS_FANOUT_CONCURRENCY_MIN, requested)
  );
  if (applied !== requested) {
    warnOnce('WS_FANOUT_CONCURRENCY', raw, String(applied));
  }
  return applied;
}

/** The SDK's own keep-alive agent size; raised only to fit a wider fan-out. */
export const WS_GATEWAY_AGENT_MIN_SOCKETS = 50;

/**
 * Sockets for the gateway client's keep-alive agent: the SDK's 50, raised to
 * the fan-out width, so the fan-out pool and not the agent bounds concurrent
 * sends. Read once when the client is built; a Lambda configuration change
 * starts new environments, so it follows `WS_FANOUT_CONCURRENCY`.
 */
export function wsGatewayAgentMaxSockets(
  env: NodeJS.ProcessEnv = process.env
): number {
  return Math.max(WS_GATEWAY_AGENT_MIN_SOCKETS, wsFanoutConcurrency(env));
}

/**
 * `WS_KNOWN_EXPIRY_FENCE`: on (the default) lets a fan-out send trust the
 * JWT expiry its recipient query returned. `off` makes every send re-read
 * the connection row first, as before waves 1.2. Accepts on/off, true/false
 * and 1/0 in any case; anything else keeps it on and logs a warning.
 */
export function isKnownExpiryFenceEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.WS_KNOWN_EXPIRY_FENCE?.trim().toLowerCase();
  if (!raw || raw === 'on' || raw === 'true' || raw === '1') return true;
  if (raw === 'off' || raw === 'false' || raw === '0') return false;
  warnOnce('WS_KNOWN_EXPIRY_FENCE', raw, 'on');
  return true;
}

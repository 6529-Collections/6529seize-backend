import { createHash, createHmac } from 'node:crypto';
import { AreaManifest, Probe } from '@/rebuild/manifest.types';
import { canonicalAnswer } from '@/rebuild/probes/canonical';

/** One request of a probe after its placeholders are filled in. */
export interface ProbeCall {
  readonly id: string;
  readonly area: string;
  readonly probe: Probe;
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export interface ProbeAnswer {
  readonly id: string;
  readonly status: number;
  /** Parsed JSON, or the SHA-256 of a non-JSON body. */
  readonly body: unknown;
  /** False when the body was empty or not JSON. */
  readonly json?: boolean;
  readonly error?: string;
}

export interface ProbeDifference {
  readonly id: string;
  readonly area: string;
  /**
   * `failure`: the first pass failed (no answer, 5xx, or not the status the
   * probe expects) or the passes differ. `unproven`: the first pass answered
   * 4xx or carried no data, so the probe proved nothing; a final run fails it.
   */
  readonly kind: 'failure' | 'unproven';
  readonly reason: string;
  readonly before: string;
  readonly after: string;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Fills a probe's placeholders with every combination of its values. */
export function expandProbe(area: string, probe: Probe): ProbeCall[] {
  const names = Array.from(
    new Set(Array.from(probe.path.matchAll(PLACEHOLDER)).map((m) => m[1]))
  );
  let combos: Record<string, string>[] = [{}];
  for (const name of names) {
    const values = probe.each?.[name] ?? [];
    combos = combos.flatMap((combo) =>
      values.map((value) => ({ ...combo, [name]: value }))
    );
  }
  return combos.map((combo) => ({
    id: names.length
      ? `${probe.id}[${names.map((n) => `${n}=${combo[n]}`).join(',')}]`
      : probe.id,
    area,
    probe,
    method: probe.method ?? 'GET',
    path: probe.path.replace(PLACEHOLDER, (_, name: string) =>
      encodeURIComponent(combo[name])
    )
  }));
}

export function expandAll(manifests: readonly AreaManifest[]): ProbeCall[] {
  return manifests.flatMap((manifest) =>
    manifest.probes.flatMap((probe) => expandProbe(manifest.area, probe))
  );
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * An access token for a fixture wallet, signed with the run's secret: the
 * claims the API's JWT strategy accepts (`sub`, `exp`), with an id derived
 * from the wallet so both passes send the same token.
 */
export function accessToken(
  wallet: string,
  secret: string,
  nowSeconds: number
): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const hash = createHash('sha256').update(wallet.toLowerCase()).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const payload = base64Url(
    JSON.stringify({
      id,
      sub: wallet.toLowerCase(),
      iat: nowSeconds,
      exp: nowSeconds + 24 * 3600
    })
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function callOne(
  baseUrl: string,
  call: ProbeCall,
  token: string | null
): Promise<ProbeAnswer> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (call.probe.body !== undefined)
    headers['content-type'] = 'application/json';
  try {
    const response = await fetch(`${baseUrl}${call.path}`, {
      method: call.method,
      headers,
      body:
        call.probe.body === undefined
          ? undefined
          : JSON.stringify(call.probe.body)
    });
    const text = await response.text();
    let body: unknown;
    let json = true;
    try {
      body = JSON.parse(text);
    } catch {
      json = false;
      body = { sha256: createHash('sha256').update(text).digest('hex') };
    }
    return { id: call.id, status: response.status, body, json };
  } catch (error) {
    return { id: call.id, status: 0, body: null, error: String(error) };
  }
}

/** Calls every probe in order, one at a time. */
export async function runProbes(
  baseUrl: string,
  calls: readonly ProbeCall[],
  jwtSecret: string
): Promise<Record<string, ProbeAnswer>> {
  const now = Math.floor(Date.now() / 1000);
  const answers: Record<string, ProbeAnswer> = {};
  for (const call of calls) {
    const caller = call.probe.as ?? 'anonymous';
    const token =
      caller === 'anonymous'
        ? null
        : accessToken(caller.wallet, jwtSecret, now);
    answers[call.id] = await callOne(baseUrl, call, token);
  }
  return answers;
}

function statusOk(probe: Probe, status: number): boolean {
  return probe.expectStatus === undefined
    ? status >= 200 && status < 300
    : status === probe.expectStatus;
}

/** The values a request names: its path segments and query values. */
function askedValues(requestPath: string): string[] {
  return requestPath
    .split(/[/?&=]/)
    .filter((part) => part.length > 0)
    .map((part) => {
      try {
        return decodeURIComponent(part).toLowerCase();
      } catch {
        return part.toLowerCase();
      }
    });
}

function hasValue(value: unknown, asked: ReadonlySet<string>): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      hasValue(v, asked)
    );
  }
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > 0 && !asked.has(value.toLowerCase());
  }
  return true;
}

/**
 * An answer with no data in it: nothing, an empty list, a page whose lists
 * are all empty (`{ data: [], page: 1, next: false }`), or an object whose
 * values are all zero, false, empty or what the request asked about (the
 * default an API returns for an unknown key).
 */
export function carriesNoData(body: unknown, requestPath = ''): boolean {
  if (body === null || body === undefined) return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body !== 'object') return false;
  const values = Object.values(body as Record<string, unknown>);
  const lists = values.filter((v) => Array.isArray(v)) as unknown[][];
  if (lists.length) {
    return (
      lists.every((list) => list.length === 0) &&
      values.every(
        (v) =>
          Array.isArray(v) ||
          v === null ||
          typeof v === 'number' ||
          typeof v === 'boolean'
      )
    );
  }
  return !hasValue(body, new Set(askedValues(requestPath)));
}

/**
 * Compares the two passes. A probe whose first pass fails, or whose answers
 * differ, is a failure. One whose answers match but whose first answer is a
 * 4xx, or a 2xx that is empty, not JSON or carries no data, proves nothing
 * and is unproven.
 */
export function diffAnswers(
  calls: readonly ProbeCall[],
  before: Readonly<Record<string, ProbeAnswer>>,
  after: Readonly<Record<string, ProbeAnswer>>
): ProbeDifference[] {
  const differences: ProbeDifference[] = [];
  for (const call of calls) {
    const a = before[call.id];
    const b = after[call.id];
    const ignore = (call.probe.ignore ?? []).map((p) => p.path);
    const unordered = (call.probe.unordered ?? []).map((p) => p.path);
    const form = (answer: ProbeAnswer | undefined) =>
      answer
        ? `${answer.status} ${canonicalAnswer(answer.body, ignore, unordered)}`
        : 'no answer';
    const difference = (kind: ProbeDifference['kind'], reason: string) =>
      differences.push({
        id: call.id,
        area: call.area,
        kind,
        reason,
        before: form(a),
        after: form(b)
      });
    const expected = call.probe.expectStatus;
    const success = !!a && a.status >= 200 && a.status < 300;
    if (!a || a.status === 0 || a.status >= 500) {
      difference('failure', 'the first pass failed');
    } else if (expected !== undefined && a.status !== expected) {
      difference(
        'failure',
        `the first pass answered ${a.status}, not ${expected}`
      );
    } else if (form(a) !== form(b)) {
      // Compared whatever the first answer was: an unproven probe that
      // answers differently after the rebuild still fails.
      difference('failure', 'the answers differ');
    } else if (!statusOk(call.probe, a.status)) {
      difference('unproven', `the first pass answered ${a.status}`);
    } else if (success && a.json === false) {
      difference('unproven', 'the first pass answered without JSON');
    } else if (success && carriesNoData(a.body, call.path)) {
      difference('unproven', 'the first pass answered with no data');
    }
  }
  return differences;
}

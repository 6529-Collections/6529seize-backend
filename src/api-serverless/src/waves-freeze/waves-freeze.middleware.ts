import { NextFunction, Request, Response } from 'express';
import {
  isMainStageKeptDuringWavesFreeze,
  isWavesFrozen,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import {
  WavesScopeService,
  wavesScopeService
} from '@/waves-scope/waves-scope.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What a request writes, as far as the waves freeze is concerned:
 * - WAVE: a wave, a wave's REP, a poll or a new decision; frozen with a
 *   wave that moves to the 6529 chain.
 * - DECISION: an existing decision's entries, votes, edits or actions;
 *   frozen with its wave, except the Main Stage when the freeze keeps it
 *   running. Which decision is the Main Stage is the services' call (they
 *   read the decision), so here a DECISION write is refused only when the
 *   freeze keeps nothing running.
 * Writes to a wave that stays on 6529.io are never refused.
 */
export type WavesWriteKind = 'WAVE' | 'DECISION';

/**
 * The wave a write is for: named in the path or in a new drop's body, or
 * the wave of a drop named in the path. A new wave has none yet: the wave
 * service decides it from the groups it is to use.
 */
export type WavesWriteTarget =
  | { readonly waveId: string }
  | { readonly dropId: string }
  | { readonly newWave: true };

interface PathRule {
  readonly method: string;
  readonly path: RegExp;
  readonly kind: WavesWriteKind;
  /** The write's wave, from the path. */
  readonly target: (match: RegExpExecArray) => WavesWriteTarget;
}

const SEGMENT = '[^/]+';
const CAPTURED = '([^/]+)';
const END = '/?$';
const NEW_WAVE = (): WavesWriteTarget => ({ newWave: true });
const WAVE_ID = (match: RegExpExecArray): WavesWriteTarget => ({
  waveId: decodePathSegment(match[1])
});
const DROP_ID = (match: RegExpExecArray): WavesWriteTarget => ({
  dropId: decodePathSegment(match[1])
});

/**
 * Routes whose every write the freeze covers. Paths are relative to the API
 * router (after /api). Wave edits and deletes are left to the wave service,
 * which knows a direct message (chat, not frozen) from a wave; legacy votes
 * (POST /drops/:id/ratings) to the vote service, since a rating on a chat
 * drop is a reaction; new drops are decided by their body below.
 */
const PATH_RULES: readonly PathRule[] = [
  // Wave create (direct messages use /waves/direct-message/new).
  {
    method: 'POST',
    path: new RegExp(`^/waves${END}`, 'i'),
    kind: 'WAVE',
    target: NEW_WAVE
  },
  {
    method: 'POST',
    path: new RegExp(`^/v3/waves${END}`, 'i'),
    kind: 'WAVE',
    target: NEW_WAVE
  },
  // Wave metadata.
  {
    method: 'POST',
    path: new RegExp(`^/v2/waves/${CAPTURED}/metadata${END}`, 'i'),
    kind: 'WAVE',
    target: WAVE_ID
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/v2/waves/${CAPTURED}/metadata/${SEGMENT}${END}`, 'i'),
    kind: 'WAVE',
    target: WAVE_ID
  },
  // Wave REP.
  {
    method: 'POST',
    path: new RegExp(`^/waves/${CAPTURED}/rep/rating${END}`, 'i'),
    kind: 'WAVE',
    target: WAVE_ID
  },
  // Poll votes.
  {
    method: 'POST',
    path: new RegExp(`^/v2/drops/${CAPTURED}/poll/vote${END}`, 'i'),
    kind: 'WAVE',
    target: DROP_ID
  },
  // Decision create.
  {
    method: 'POST',
    path: new RegExp(`^/v3/waves/${CAPTURED}/competitions${END}`, 'i'),
    kind: 'WAVE',
    target: WAVE_ID
  },
  // Decision edits, actions, entries and votes.
  {
    method: 'PATCH',
    path: new RegExp(
      `^/v3/waves/${CAPTURED}/competitions/${SEGMENT}${END}`,
      'i'
    ),
    kind: 'DECISION',
    target: WAVE_ID
  },
  {
    method: 'POST',
    path: new RegExp(
      `^/v3/waves/${CAPTURED}/competitions/${SEGMENT}/actions/${SEGMENT}${END}`,
      'i'
    ),
    kind: 'DECISION',
    target: WAVE_ID
  },
  {
    method: 'POST',
    path: new RegExp(
      `^/v3/waves/${CAPTURED}/competitions/${SEGMENT}/entries${END}`,
      'i'
    ),
    kind: 'DECISION',
    target: WAVE_ID
  },
  {
    method: 'PUT',
    path: new RegExp(
      `^/v3/waves/${CAPTURED}/competitions/${SEGMENT}/entries/${SEGMENT}/votes/me${END}`,
      'i'
    ),
    kind: 'DECISION',
    target: WAVE_ID
  }
];

const DROP_CREATE = new RegExp(`^/drops${END}`, 'i');

export interface WavesWriteCandidate {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function field(body: unknown, name: string): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return (body as Record<string, unknown>)[name];
  }
  return undefined;
}

/**
 * A new drop is a waves write when it carries a poll (polls are frozen) or
 * is a legacy entry (a participatory drop, a decision write).
 */
function dropCreateWrite(body: unknown): WavesWriteKind | null {
  const poll = field(body, 'poll');
  if (poll !== undefined && poll !== null) {
    return 'WAVE';
  }
  const dropType = field(body, 'drop_type');
  if (
    typeof dropType === 'string' &&
    dropType.toUpperCase() === 'PARTICIPATORY'
  ) {
    return 'DECISION';
  }
  return null;
}

/** A path segment as the router reads it; an undecodable one stays as is. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface WavesWrite {
  readonly kind: WavesWriteKind;
  /** Null when the request names no wave: the service then decides. */
  readonly target: WavesWriteTarget | null;
}

/**
 * Whether a request writes what the waves freeze covers, what, and for
 * which wave. Reads never do. Chat (chat drops, their edits, deletes,
 * reactions and ratings), direct messages, subscriptions, pins, mutes and
 * curations never do.
 */
export function findWavesWrite({
  method,
  path,
  body
}: WavesWriteCandidate): WavesWrite | null {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) {
    return null;
  }
  for (const rule of PATH_RULES) {
    if (rule.method !== verb) continue;
    const match = rule.path.exec(path);
    if (match) {
      return {
        kind: rule.kind,
        target: rule.target(match)
      };
    }
  }
  if (verb === 'POST' && DROP_CREATE.test(path)) {
    const kind = dropCreateWrite(body);
    if (!kind) return null;
    const waveId = field(body, 'wave_id');
    return {
      kind,
      target: typeof waveId === 'string' && waveId ? { waveId } : null
    };
  }
  return null;
}

/** What a request writes, as far as the waves freeze is concerned. */
export function classifyWavesWrite(
  candidate: WavesWriteCandidate
): WavesWriteKind | null {
  return findWavesWrite(candidate)?.kind ?? null;
}

/**
 * Whether the freeze can refuse this kind of write here, before any service
 * work, when its wave moves.
 */
export function isRefusedByWavesFreeze(kind: WavesWriteKind | null): boolean {
  if (!kind || !isWavesFrozen()) {
    return false;
  }
  return kind === 'WAVE' || !isMainStageKeptDuringWavesFreeze();
}

type WaveLookup = Pick<WavesScopeService, 'waveStays' | 'dropWaveId'>;

/**
 * Whether the write's wave moves to the 6529 chain. A new wave, a write
 * that names no wave, and a drop that does not exist are left to the
 * service, which checks every write again.
 */
async function targetWaveMoves(
  target: WavesWriteTarget | null,
  scope: WaveLookup
): Promise<boolean> {
  if (!target || 'newWave' in target) return false;
  const waveId =
    'waveId' in target
      ? target.waveId
      : await scope.dropWaveId(target.dropId, {});
  if (!waveId) return false;
  return !(await scope.waveStays(waveId, {}));
}

/**
 * Refuses wave, decision, entry, vote, wave REP and poll writes to a wave
 * that moves to the 6529 chain with 423 and code WAVES_FROZEN while the
 * waves freeze is on; writes to a wave that stays on 6529.io pass. Mount it
 * on the API router before the routers it covers. The services check every
 * write again, including new waves, those no route shows and the Main
 * Stage's: wave edits and deletes, replacing a group a wave uses, legacy
 * votes, legacy entry edits and withdrawals (src/waves-freeze).
 */
export function wavesFreezeMiddleware(scope: WaveLookup = wavesScopeService) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const write = findWavesWrite({
      method: req.method,
      path: req.path,
      body: req.body
    });
    if (!write || !isRefusedByWavesFreeze(write.kind)) {
      next();
      return;
    }
    targetWaveMoves(write.target, scope).then(
      (moves) => next(moves ? new WavesFrozenException() : undefined),
      next
    );
  };
}

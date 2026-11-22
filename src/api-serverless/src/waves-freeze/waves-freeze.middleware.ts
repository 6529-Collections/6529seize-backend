import { NextFunction, Request, Response } from 'express';
import {
  isDecisionFrozen,
  isMainStageKeptDuringWavesFreeze,
  isWavesFrozen,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What a request writes, as far as the waves freeze is concerned:
 * - WAVE: a wave, a wave's REP or a poll; frozen with the waves.
 * - DECISION: a decision's entries, votes, pauses, edits or actions; frozen
 *   with the waves, except the Main Stage when the freeze keeps it running.
 *   `waveId` is the decision's wave when the path names it, else null.
 */
export type WavesWrite =
  | { readonly kind: 'WAVE' }
  | { readonly kind: 'DECISION'; readonly waveId: string | null };

interface PathRule {
  readonly method: string;
  readonly path: RegExp;
  readonly kind: WavesWrite['kind'];
}

const SEGMENT = '([^/]+)';
const END = '/?$';

/**
 * Routes whose every write the freeze covers. Paths are relative to the API
 * router (after /api). Wave edits and deletes are left to the wave service,
 * which knows a direct message (chat, not frozen) from a wave; drops are
 * decided by their body below.
 */
const PATH_RULES: readonly PathRule[] = [
  // Wave create (direct messages use /waves/direct-message/new).
  { method: 'POST', path: new RegExp(`^/waves${END}`, 'i'), kind: 'WAVE' },
  { method: 'POST', path: new RegExp(`^/v3/waves${END}`, 'i'), kind: 'WAVE' },
  // Wave metadata.
  {
    method: 'POST',
    path: new RegExp(`^/v2/waves/${SEGMENT}/metadata${END}`, 'i'),
    kind: 'WAVE'
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/v2/waves/${SEGMENT}/metadata/${SEGMENT}${END}`, 'i'),
    kind: 'WAVE'
  },
  // Wave REP.
  {
    method: 'POST',
    path: new RegExp(`^/waves/${SEGMENT}/rep/rating${END}`, 'i'),
    kind: 'WAVE'
  },
  // Poll votes.
  {
    method: 'POST',
    path: new RegExp(`^/v2/drops/${SEGMENT}/poll/vote${END}`, 'i'),
    kind: 'WAVE'
  },
  // Decision create.
  {
    method: 'POST',
    path: new RegExp(`^/v3/waves/${SEGMENT}/competitions${END}`, 'i'),
    kind: 'WAVE'
  },
  // Decision edits, actions, entries and votes (the wave is the first id).
  {
    method: 'PATCH',
    path: new RegExp(
      `^/v3/waves/${SEGMENT}/competitions/${SEGMENT}${END}`,
      'i'
    ),
    kind: 'DECISION'
  },
  {
    method: 'POST',
    path: new RegExp(
      `^/v3/waves/${SEGMENT}/competitions/${SEGMENT}/actions/${SEGMENT}${END}`,
      'i'
    ),
    kind: 'DECISION'
  },
  {
    method: 'POST',
    path: new RegExp(
      `^/v3/waves/${SEGMENT}/competitions/${SEGMENT}/entries${END}`,
      'i'
    ),
    kind: 'DECISION'
  },
  {
    method: 'PUT',
    path: new RegExp(
      `^/v3/waves/${SEGMENT}/competitions/${SEGMENT}/entries/${SEGMENT}/votes/me${END}`,
      'i'
    ),
    kind: 'DECISION'
  },
  // Decision pauses (legacy routes, by wave).
  {
    method: 'POST',
    path: new RegExp(`^/waves/${SEGMENT}/pauses${END}`, 'i'),
    kind: 'DECISION'
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/waves/${SEGMENT}/pauses/${SEGMENT}${END}`, 'i'),
    kind: 'DECISION'
  }
];

/** Legacy votes name the drop, not the wave: the vote service decides. */
const DROP_VOTE = new RegExp(`^/drops/${SEGMENT}/ratings${END}`, 'i');

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

function decodedSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A new drop is a waves write when it carries a poll (polls are frozen) or
 * is a legacy entry (a participatory drop, a decision write).
 */
function dropCreateWrite(body: unknown): WavesWrite | null {
  const poll = field(body, 'poll');
  if (poll !== undefined && poll !== null) {
    return { kind: 'WAVE' };
  }
  const dropType = field(body, 'drop_type');
  if (
    typeof dropType === 'string' &&
    dropType.toUpperCase() === 'PARTICIPATORY'
  ) {
    const waveId = field(body, 'wave_id');
    return {
      kind: 'DECISION',
      waveId: typeof waveId === 'string' ? waveId : null
    };
  }
  return null;
}

/**
 * Whether a request writes what the waves freeze covers, and what. Reads
 * never do. Chat (chat drops, their edits, deletes and reactions), direct
 * messages, subscriptions, pins, mutes and curations never do.
 */
export function classifyWavesWrite({
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
    if (!match) continue;
    return rule.kind === 'WAVE'
      ? { kind: 'WAVE' }
      : { kind: 'DECISION', waveId: decodedSegment(match[1]) };
  }
  if (verb === 'POST' && DROP_VOTE.test(path)) {
    return { kind: 'DECISION', waveId: null };
  }
  if (verb === 'POST' && DROP_CREATE.test(path)) {
    return dropCreateWrite(body);
  }
  return null;
}

/** Whether the freeze refuses this write now. */
export function isRefusedByWavesFreeze(write: WavesWrite | null): boolean {
  if (!write || !isWavesFrozen()) {
    return false;
  }
  if (write.kind === 'WAVE') {
    return true;
  }
  if (write.waveId === null) {
    // The decision is unknown here: refuse unless the Main Stage keeps
    // running, then the vote service decides by the decision itself.
    return !isMainStageKeptDuringWavesFreeze();
  }
  return isDecisionFrozen({ wave_id: write.waveId });
}

/**
 * Refuses wave, decision, entry, vote, wave REP and poll writes with 423 and
 * code WAVES_FROZEN while the waves freeze is on. Mount it on the API router
 * before the routers it covers. The services check every write again,
 * including those no route shows: wave edits and deletes, replacing a group
 * a wave uses, legacy entry edits and withdrawals (src/waves-freeze).
 */
export function wavesFreezeMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (
      isRefusedByWavesFreeze(
        classifyWavesWrite({
          method: req.method,
          path: req.path,
          body: req.body
        })
      )
    ) {
      next(new WavesFrozenException());
      return;
    }
    next();
  };
}

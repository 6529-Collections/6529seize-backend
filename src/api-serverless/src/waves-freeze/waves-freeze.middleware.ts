import { NextFunction, Request, Response } from 'express';
import {
  isMainStageKeptDuringWavesFreeze,
  isWavesFrozen,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What a request writes, as far as the waves freeze is concerned:
 * - WAVE: a wave, a wave's REP, a poll or a new decision; frozen with the
 *   waves.
 * - DECISION: an existing decision's entries, votes, edits or actions;
 *   frozen with the waves, except the Main Stage when the freeze keeps it
 *   running. Which decision is the Main Stage is the services' call (they
 *   read the decision), so here a DECISION write is refused only when the
 *   freeze keeps nothing running.
 */
export type WavesWriteKind = 'WAVE' | 'DECISION';

interface PathRule {
  readonly method: string;
  readonly path: RegExp;
  readonly kind: WavesWriteKind;
}

const SEGMENT = '[^/]+';
const END = '/?$';

/**
 * Routes whose every write the freeze covers. Paths are relative to the API
 * router (after /api). Wave edits and deletes are left to the wave service,
 * which knows a direct message (chat, not frozen) from a wave; legacy votes
 * (POST /drops/:id/ratings) to the vote service, since a rating on a chat
 * drop is a reaction; new drops are decided by their body below.
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
  // Decision edits, actions, entries and votes.
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

/**
 * Whether a request writes what the waves freeze covers, and what. Reads
 * never do. Chat (chat drops, their edits, deletes, reactions and ratings),
 * direct messages, subscriptions, pins, mutes and curations never do.
 */
export function classifyWavesWrite({
  method,
  path,
  body
}: WavesWriteCandidate): WavesWriteKind | null {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) {
    return null;
  }
  const rule = PATH_RULES.find(
    (candidate) => candidate.method === verb && candidate.path.test(path)
  );
  if (rule) {
    return rule.kind;
  }
  if (verb === 'POST' && DROP_CREATE.test(path)) {
    return dropCreateWrite(body);
  }
  return null;
}

/** Whether the freeze refuses this write here, before any service work. */
export function isRefusedByWavesFreeze(kind: WavesWriteKind | null): boolean {
  if (!kind || !isWavesFrozen()) {
    return false;
  }
  return kind === 'WAVE' || !isMainStageKeptDuringWavesFreeze();
}

/**
 * Refuses wave, decision, entry, vote, wave REP and poll writes with 423 and
 * code WAVES_FROZEN while the waves freeze is on. Mount it on the API router
 * before the routers it covers. The services check every write again,
 * including those no route shows and the Main Stage's: wave edits and
 * deletes, replacing a group a wave uses, legacy votes, legacy entry edits
 * and withdrawals (src/waves-freeze).
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

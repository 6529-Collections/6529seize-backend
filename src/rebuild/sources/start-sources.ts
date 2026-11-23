import * as fs from 'node:fs';
import * as path from 'node:path';
import { startAnvil } from '@/rebuild/sources/anvil';
import {
  startCrpRelay,
  startCrpRelayReplay
} from '@/rebuild/sources/crp-relay';
import { startCrpRelayRecord } from '@/rebuild/sources/crp-relay-record';
import { startFileServer } from '@/rebuild/sources/file-server';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import {
  inProcessVerifier,
  RecordingVerifier
} from '@/rebuild/sources/relay-checks';
import { redactUrl, RunningSource } from '@/rebuild/sources/running-source';
import {
  SourceSpec,
  SourceSpecs,
  URL_SOURCES,
  UrlSource
} from '@/rebuild/sources/source-spec';

/**
 * A live URL: its answers aren't recorded, so a later run can't replay
 * them, and the proof can't count it.
 */
function live(name: UrlSource, url: string): RunningSource {
  return {
    name,
    url,
    info: {
      url: redactUrl(url),
      mode: 'live',
      provenance: 'a live URL, not a recording',
      provisional: true
    },
    problems: () => [],
    stop: () => Promise.resolve()
  };
}

export interface SourceOptions {
  /** Checks a replayed relay recording's events (the run: in a guarded child). */
  readonly verifyRelays?: RecordingVerifier;
}

/**
 * Relays recorded into `dir`: from a fresh harness relay (`@relay`), so a
 * run can make its own recording on loopback, or from a relay's URL. What
 * the recording names never holds the URL.
 */
async function recordRelays(
  dir: string,
  upstream: string,
  runDir: string
): Promise<RunningSource> {
  if (upstream !== 'relay') {
    return startCrpRelayRecord({
      dir,
      upstream,
      upstreamLabel: 'a CRP relay'
    });
  }
  const relayDir = path.join(runDir, 'sources', 'relays-recorded');
  fs.mkdirSync(relayDir, { recursive: true });
  const relay = await startCrpRelay(relayDir);
  const recorder = await startCrpRelayRecord({
    dir,
    upstream: relay.url,
    upstreamLabel: 'the harness relay'
  });
  return {
    ...recorder,
    problems: () => [...recorder.problems(), ...relay.problems()],
    stop: async () => {
      await recorder.stop();
      await relay.stop();
    }
  };
}

async function startOne(
  name: UrlSource,
  spec: SourceSpec,
  runDir: string,
  options: SourceOptions
): Promise<RunningSource> {
  switch (spec.kind) {
    case 'live':
      return live(name, spec.url);
    case 'replay':
      if (name === 'relays') {
        return startCrpRelayReplay(
          [spec.dir, ...(spec.also ?? [])],
          options.verifyRelays ?? inProcessVerifier([]),
          path.join(runDir, 'sources', 'relays-replayed')
        );
      }
      if (!fs.existsSync(spec.dir)) {
        throw new Error(`${name}: no recording at ${spec.dir}`);
      }
      return startHttpRecording({ name, dir: spec.dir });
    case 'record':
      if (name === 'relays') {
        return recordRelays(spec.dir, spec.upstream, runDir);
      }
      return startHttpRecording({
        name,
        dir: spec.dir,
        upstream: spec.upstream
      });
    case 'files': {
      // Files the run's seeds write (ctx.seedFilesDir) are served too.
      const seedDir = seedFilesDir(runDir);
      fs.mkdirSync(seedDir, { recursive: true });
      return startFileServer(spec.dir, seedDir);
    }
    case 'anvil':
      return startAnvil({
        state: spec.state,
        logFile: path.join(runDir, 'logs', 'anvil.log')
      });
    case 'relay': {
      // A copy per run, so a run's publishes never reach the recorded events.
      const dir = path.join(runDir, 'sources', 'relays');
      fs.mkdirSync(dir, { recursive: true });
      if (spec.dir) fs.cpSync(spec.dir, dir, { recursive: true });
      return startCrpRelay(dir);
    }
  }
}

/** Where a run's seeds write files for its files source to serve. */
export function seedFilesDir(runDir: string): string {
  return path.join(runDir, 'seed-files');
}

/** Starts every configured source; on a failure stops the ones started. */
export async function startSources(
  specs: SourceSpecs,
  runDir: string,
  options: SourceOptions = {}
): Promise<RunningSource[]> {
  const running: RunningSource[] = [];
  try {
    for (const name of URL_SOURCES) {
      const spec = specs[name];
      if (spec) running.push(await startOne(name, spec, runDir, options));
    }
  } catch (error) {
    await stopSources(running);
    throw error;
  }
  return running;
}

export async function stopSources(
  running: readonly RunningSource[]
): Promise<void> {
  for (const source of running) await source.stop().catch(() => undefined);
}

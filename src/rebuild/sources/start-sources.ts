import * as fs from 'node:fs';
import * as path from 'node:path';
import { startAnvil } from '@/rebuild/sources/anvil';
import { startCrpRelay } from '@/rebuild/sources/crp-relay';
import { importAnswerFileHashes } from '@/rebuild/sources/drop-archives';
import { startFileServer } from '@/rebuild/sources/file-server';
import {
  recordedExchanges,
  startHttpRecording
} from '@/rebuild/sources/http-recording';
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

/**
 * The Waves v1 file hashes the gateway's recording gives in its import
 * answers: what the files source checks a Waves v1 file's name against.
 * None for a live gateway, or none at all. In record mode a fresh
 * recording holds no import answer yet, so the import files wait.
 */
function wavesFileHashes(specs: SourceSpecs): string[] {
  const gateway = specs.gateway;
  if (!gateway || (gateway.kind !== 'replay' && gateway.kind !== 'record')) {
    return [];
  }
  return fs.existsSync(gateway.dir)
    ? importAnswerFileHashes(recordedExchanges(gateway.dir))
    : [];
}

async function startOne(
  name: UrlSource,
  spec: SourceSpec,
  runDir: string,
  specs: SourceSpecs,
  running: readonly RunningSource[]
): Promise<RunningSource> {
  switch (spec.kind) {
    case 'live':
      return live(name, spec.url);
    case 'replay':
      if (!fs.existsSync(spec.dir)) {
        throw new Error(`${name}: no recording at ${spec.dir}`);
      }
      return startHttpRecording({ name, dir: spec.dir });
    case 'record':
      return startHttpRecording({
        name,
        dir: spec.dir,
        upstream: spec.upstream
      });
    case 'files': {
      // Files the run's seeds write (ctx.seedFilesDir) are served too.
      const seedDir = seedFilesDir(runDir);
      fs.mkdirSync(seedDir, { recursive: true });
      // The gateway starts first: whether it is verified decides whether
      // the names its answers give count yet.
      const gateway = running.find((source) => source.name === 'gateway');
      return startFileServer(spec.dir, seedDir, {
        wavesFileHashes: wavesFileHashes(specs),
        gatewayVerified: gateway ? !gateway.info.provisional : false
      });
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
  runDir: string
): Promise<RunningSource[]> {
  const running: RunningSource[] = [];
  try {
    for (const name of URL_SOURCES) {
      const spec = specs[name];
      if (spec) {
        running.push(await startOne(name, spec, runDir, specs, running));
      }
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

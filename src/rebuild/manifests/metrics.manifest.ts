import {
  AreaManifest,
  RebuildStep,
  RebuildSource
} from '@/rebuild/manifest.types';
import { artdocManifest } from '@/rebuild/manifests/artdoc.manifest';
import { dmManifest } from '@/rebuild/manifests/dm.manifest';
import { harnessManifest } from '@/rebuild/manifests/harness.manifest';
import { holdingsManifest } from '@/rebuild/manifests/holdings.manifest';
import { identityManifest } from '@/rebuild/manifests/identity.manifest';
import { mintManifest } from '@/rebuild/manifests/mint.manifest';
import { notifyManifest } from '@/rebuild/manifests/notify.manifest';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import { publishManifest } from '@/rebuild/manifests/publish.manifest';
import { subsManifest } from '@/rebuild/manifests/subs.manifest';
import { tdhManifest } from '@/rebuild/manifests/tdh.manifest';
import { wavesManifest } from '@/rebuild/manifests/waves.manifest';
import { METRICS_RECOUNT_READS } from '@/metrics/metrics-rebuild.tables';

/**
 * Community metrics: metric_rollup_hour, the hourly counters and daily
 * samples the community metrics routes read.
 *
 * Live rows take the hour they were written; a rebuild recounts them from
 * the tables the events left (src/metrics/metrics-rebuild.ts), by the hour
 * each event happened. So the seed replaces the seeded world's live rows
 * with the same recount, and the check compares a recount with a recount:
 * it proves the recount comes back the same from the rebuilt tables. A DB
 * test (metrics-rebuild-live.db.test.ts) drives events through the live
 * write paths within one hour and checks the recount gives the same rows.
 */

/** Every other area: the recount runs after their steps. */
const OTHER_AREAS: readonly AreaManifest[] = [
  identityManifest,
  wavesManifest,
  tdhManifest,
  holdingsManifest,
  subsManifest,
  mintManifest,
  publishManifest,
  personalManifest,
  dmManifest,
  notifyManifest,
  artdocManifest,
  harnessManifest
];

/** The tables the recount reads (src/metrics/metrics-rebuild.tables.ts). */
const RECOUNT_READS = [...METRICS_RECOUNT_READS];

const RECOUNT_MODULE = 'src/metrics/metrics-rebuild';

const SOURCES: RebuildSource[] = ['repo'];

/**
 * The recount seed runs after every other area's seeds: they put the
 * events in place, and some write live rows the recount replaces.
 */
const seedsBefore = OTHER_AREAS.flatMap((area) =>
  area.seeds.map((step) => step.id)
);

/** The rebuilders that write a table the recount reads run first. */
const rebuildersBefore = OTHER_AREAS.flatMap((area) =>
  area.rebuilders
    .filter((step: RebuildStep) =>
      step.writes.some((table) => RECOUNT_READS.includes(table))
    )
    .map((step) => step.id)
);

/** A window that holds the waves world's fixed-time legacy rows (24 Nov 2025). */
const SERIES_SINCE_MS = Date.UTC(2025, 10, 17);
const SERIES_TO_MS = Date.UTC(2025, 11, 1);

export const metricsManifest: AreaManifest = {
  area: 'metrics',
  flags: {},
  tables: {
    // TDH_ON_MAIN_STAGE_SUBMISSIONS, PROFILE_COUNT and XTDH_GRANTED are not
    // recounted (NOT_RECOUNTED in src/metrics/metrics-rebuild.ts): a
    // rebuild has no rows for them, and the seed drops them with the rest.
    metric_rollup_hour: { class: 'INDEX' }
  },
  seeds: [
    {
      id: 'metrics.recount.seed',
      run: { module: RECOUNT_MODULE, exportName: 'seedMetricRollupHour' },
      writes: ['metric_rollup_hour'],
      reads: RECOUNT_READS,
      after: seedsBefore,
      sources: SOURCES,
      timeoutMinutes: 10
    }
  ],
  rebuilders: [
    {
      id: 'metrics.recount',
      run: { module: RECOUNT_MODULE, exportName: 'rebuildMetricRollupHour' },
      writes: ['metric_rollup_hour'],
      reads: RECOUNT_READS,
      after: rebuildersBefore,
      sources: SOURCES,
      timeoutMinutes: 30
    }
  ],
  probes: [
    {
      id: 'metrics.community-metrics.series',
      path: `/api/community-metrics/series?since=${SERIES_SINCE_MS}&to=${SERIES_TO_MS}`
    }
  ],
  waivers: {
    routes: [
      {
        target: 'GET /api/community-metrics',
        reason:
          "Reads the two days or weeks before the server's last UTC midnight, so its answer depends on the day the check runs; the series probe reads the same rows over a fixed window."
      }
    ]
  }
};

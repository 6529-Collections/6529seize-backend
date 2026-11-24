import * as path from 'node:path';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import {
  DROP_METRICS_REBUILDERS,
  wavesManifest
} from '@/rebuild/manifests/waves.manifest';
import { checkRegistry } from '@/rebuild/registry-check';
import { stepCodeIn } from '@/rebuild/step-code';
import { discoverCodeTables } from '@/rebuild/table-discovery';
import { compareCodeUnits } from '@/waves-chain-index/waves-chain-index.order';

const METRICS_TABLES = ['wave_metrics', 'wave_dropper_metrics'];

// The drop metrics' rebuilder waits outside the waves rebuilders until other
// areas' seeds write their drops' metrics. It is checked here as if it were
// back, so its writes, plans and order edges can't drift while it waits.
describe('the waves drop metrics rebuilder while it waits', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const codeTables = discoverCodeTables();
  const stepCodeHere = stepCodeIn(root);
  const withMetrics = checkRegistry({
    manifests: AREA_MANIFESTS.map((manifest) =>
      manifest.area === 'waves'
        ? {
            ...manifest,
            rebuilders: [...manifest.rebuilders, ...DROP_METRICS_REBUILDERS]
          }
        : manifest
    ),
    codeTables,
    stepCodeHere
  });

  it('passes the registry check among the waves rebuilders', () => {
    expect(withMetrics.problems).toEqual([]);
    expect(withMetrics.crossAreaEdges).toEqual([]);
  });

  it('rebuilds both metrics tables, with the planned owners of the other columns', () => {
    expect(DROP_METRICS_REBUILDERS.map((step) => step.id)).toEqual([
      'waves.drop-metrics',
      'waves.wave-subscriber-count',
      'waves.wave-scores'
    ]);
    expect(
      withMetrics.pending.filter(({ table }) => METRICS_TABLES.includes(table))
    ).toEqual([]);
    expect(
      withMetrics.orderLeftOut.filter(({ step }) =>
        DROP_METRICS_REBUILDERS.some((parked) => parked.id === step)
      )
    ).toEqual([
      { step: 'waves.wave-subscriber-count', tables: ['wave_metrics'] },
      { step: 'waves.wave-scores', tables: ['wave_metrics'] }
    ]);
  });

  it('is not among the waves rebuilders yet, so both tables are pending', () => {
    // Fails on purpose when the rebuilder goes back: remove this test then.
    const ids = new Set(DROP_METRICS_REBUILDERS.map((step) => step.id));
    expect(wavesManifest.rebuilders.filter((step) => ids.has(step.id))).toEqual(
      []
    );
    const asIs = checkRegistry({
      manifests: AREA_MANIFESTS,
      codeTables,
      stepCodeHere
    });
    expect(
      asIs.pending
        .filter(({ table }) => METRICS_TABLES.includes(table))
        .map(({ table }) => table)
        .sort(compareCodeUnits)
    ).toEqual(['wave_dropper_metrics', 'wave_metrics']);
  });
});

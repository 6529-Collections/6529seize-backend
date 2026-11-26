import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { metricsManifest } from '@/rebuild/manifests/metrics.manifest';
import { writtenTables } from '@/rebuild/step-writes';

describe('the metrics area', () => {
  const others = AREA_MANIFESTS.filter((area) => area !== metricsManifest);
  const [seed] = metricsManifest.seeds;
  const [rebuilder] = metricsManifest.rebuilders;

  it('is registered, and owns metric_rollup_hour alone', () => {
    expect(AREA_MANIFESTS).toContain(metricsManifest);
    expect(metricsManifest.tables.metric_rollup_hour).toEqual({
      class: 'INDEX'
    });
    for (const area of others) {
      expect(area.tables).not.toHaveProperty('metric_rollup_hour');
    }
  });

  it('recounts after every other area has seeded its world, last', () => {
    expect(new Set(seed.after)).toEqual(
      new Set(others.flatMap((area) => area.seeds.map((step) => step.id)))
    );
    expect(seed.last).toBe(true);
  });

  it('rebuilds after every rebuilder that writes a table the recount reads', () => {
    const writers = others.flatMap((area) =>
      area.rebuilders
        .filter((step) =>
          writtenTables(step).some((table) => rebuilder.reads!.includes(table))
        )
        .map((step) => step.id)
    );
    expect(new Set(rebuilder.after)).toEqual(new Set(writers));
    expect(rebuilder.writes).toEqual(['metric_rollup_hour']);
    expect(rebuilder.sources).toEqual(['repo']);
  });
});

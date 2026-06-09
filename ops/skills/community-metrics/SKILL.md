---
name: community-metrics
description: Add or change community metrics in the 6529 SEIZE backend by updating metric rollup enums, recorder methods, recording call sites, optional historical backfills, OpenAPI response models, and community-metrics API aggregation. Use when adding new community metrics, exposing metric summaries or series, tracking community activity, or changing MetricsRecorder/MetricsDb behavior.
---

# Community Metrics

Use this workflow for metrics based on `metric_rollup_hour` and exposed through `/community-metrics`.

## Workflow

1. Define the metric contract before editing:
   - enum name in `UPPER_SNAKE_CASE`
   - event source and recording call sites
   - aggregation semantics: event count, value sum, latest overwritten value, distinct scoped count, or custom query
   - dimensions stored in `scope`, `key1`, or `key2`
   - whether historical backfill is required
2. Locate the current implementation with `rg`:
   - `MetricRollupHourMetric` in `src/entities/IMetricRollupHour.ts`
   - `MetricsRecorder` in `src/metrics/MetricsRecorder.ts`
   - `MetricsDb` in `src/metrics/MetricsDb.ts`
   - community API code in `src/api-serverless/src/community-metrics/`
   - OpenAPI contract in `src/api-serverless/openapi.yaml`
3. Add the enum value to `MetricRollupHourMetric`. Keep the persisted enum string identical to the enum key.
4. Add a focused `MetricsRecorder` method. Use `metricsDb.upsertMetricRollupHour` with the current rollup fields:
   - `event_count` for occurrence counts
   - `value_sum` for numeric totals or latest samples
   - `scope`, `key1`, and `key2` for dimensions or distinct counting
   - `overwrite: true` for latest-state metrics such as profile counts or network TDH
5. Wire the recorder after the primary action succeeds. Pass the existing `RequestContext` so timers and transactions are preserved.
6. Expose the metric only where needed:
   - update `src/api-serverless/openapi.yaml` response schemas for summary, series, or mint metrics
   - run `cd src/api-serverless && npm run restructure-openapi && npm run generate`
   - update `CommunityMetricsService` aggregation and mapping
   - update `community-metrics.routes.ts` only when route validation or query behavior changes
7. Add or update tests next to the changed code. Prefer focused service/DB tests; use `src/profiles/abusiveness-check.db.test.ts` as the pattern for DB/repository tests.
8. Run `npm run lint` from the repo root after changes.

## Backfills

Do not create a migration by default. If the user explicitly asks for historical data or the feature would be misleading without it, create a data-only backfill migration:

```bash
npm run migrate:new backfill-metric-name-metric
```

Write SQL in the `up` migration only, delete the generated `.down.sql`, and make the JS `down()` implementation do nothing. Never use migrations for schema changes in this repo.

## Aggregation Patterns

- Simple counter: increment `event_count: 1`, read summed `event_count`.
- Numeric total: set `value_sum` to the numeric delta, read summed `value_sum`.
- Latest sample: set `event_count: 1`, `value_sum`, and `overwrite: true`, then read the latest sample in the requested period.
- Per-identity or per-entity metric: store the dimension in `scope`; use `key1` and `key2` only when a second or third dimension is needed.
- Distinct activity: record dimensions consistently and aggregate with `getMetricBucketDistinctCounts` or a purpose-built query.

## Validation

- [ ] Metric name, dimensions, aggregation, and backfill behavior are clear.
- [ ] Enum value added to `MetricRollupHourMetric` in `src/entities/IMetricRollupHour.ts`.
- [ ] Recording function created in `MetricsRecorder`.
- [ ] Recording function called in all identified locations.
- [ ] Backfill migration created only if explicitly required.
- [ ] OpenAPI schema updated and generated types refreshed when API output changes.
- [ ] Aggregation logic added to `CommunityMetricsService`.
- [ ] Tests cover recording and exposed aggregation behavior.
- [ ] `npm run lint` passes.

---
name: community-metrics
description: Create new community metrics by adding enum values, recording functions, wiring, backfill migrations, and API integration. Use when adding new community metrics, creating metrics, or tracking community activity.
---

# Creating New Community Metrics

This skill guides you through the complete process of creating a new community metric in the 6529 SEIZE Backend.

## Overview

Community metrics track various activities and statistics. Creating a new metric involves six steps:

1. Add enum value to `MetricRollupHourMetric`
2. Create recording function in `MetricsRecorder`
3. Wire up the recorder in relevant code locations
4. Create backfill migration for historical data
5. Add field to `openapi.yaml` in `/community-metrics` endpoint
6. Wire up metric field in `CommunityMetricsService.getCommunityMetricsSummary`

## Required Information

Before implementing, gather these details using `AskUserQuestion`:

### 1. Metric Name
- What should the metric be called?
- Use UPPER_SNAKE_CASE for the enum value
- Example: `DROPS_CREATED`, `WAVE_PARTICIPATIONS`, `RATINGS_GIVEN`

### 2. Recording Function Arguments
- What parameters does the recording function need?
- Common patterns:
  - Simple counter: `recordMetric(metric: MetricRollupHourMetric)`
  - With entity ID: `recordMetric(metric: MetricRollupHourMetric, entityId: string)`
  - With amount: `recordMetric(metric: MetricRollupHourMetric, amount: number)`
  - With identity: `recordMetric(metric: MetricRollupHourMetric, identityId: string)`

### 3. Recording Locations
- Where in the codebase should this metric be recorded?
- Consider:
  - Which API endpoints create/modify the tracked activity?
  - Which background loops process related data?
  - Which services handle the business logic?
- Examples:
  - Drop creation: `drops.api.service.ts` in `createDrop()`
  - Wave participation: `waves.api.service.ts` in multiple methods
  - Ratings: `ratings.api.service.ts` in rating submission methods

### 4. Summary Aggregation Strategy
- How should the metric be aggregated in `getCommunityMetricsSummary`?
- Options:
  - **Sum**: Total count across all time (e.g., total drops created)
  - **Count**: Number of distinct occurrences
  - **Average**: Mean value over time
  - **Latest**: Most recent value
  - **Custom**: Complex calculation requiring joins or subqueries

## Implementation Steps

### Step 1: Add Enum Value

Find `MetricRollupHourMetric` (likely in `src/entities/` or `src/enums/`) and add the new metric:

```typescript
export enum MetricRollupHourMetric {
  // ... existing metrics
  NEW_METRIC_NAME = 'NEW_METRIC_NAME'
}
```

### Step 2: Create Recording Function

In `MetricsRecorder` class (find with `Glob` or `Grep`), add a method to record the metric:

```typescript
async recordNewMetricName(args: any): Promise<void> {
  await this.recordMetric(
    MetricRollupHourMetric.NEW_METRIC_NAME,
    // additional arguments as needed
  );
}
```

### Step 3: Wire Up Recording

In the identified locations, call the recording function:

```typescript
await this.metricsRecorder.recordNewMetricName(args);
```

**Important**: Ensure `MetricsRecorder` is available in the service. Check constructor for dependency injection.

### Step 4: Create Backfill Migration

Run the migration command:
```bash
npm run migrate:new backfill-metric-name-metric
```

This creates two files:
- `migrations/TIMESTAMP-backfill-metric-name-metric.up.sql`
- `migrations/TIMESTAMP-backfill-metric-name-metric.down.sql`

In the `.up.sql` file, write SQL to backfill historical data. Common pattern:

```sql
-- Insert historical metric data
INSERT INTO metric_rollup_hour (metric, hour, value, created_at)
SELECT
  'NEW_METRIC_NAME' as metric,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
  COUNT(*) as value,
  NOW() as created_at
FROM relevant_table
WHERE created_at IS NOT NULL
GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')
ON DUPLICATE KEY UPDATE
  value = VALUES(value);
```

Delete the `.down.sql` file and update the `.js` migration file to do nothing in the down migration:

```javascript
async down() {
  // Do nothing - we don't rollback metric backfills
}
```

### Step 5: Update OpenAPI Schema

Find `/community-metrics` endpoint in `openapi.yaml` and add the new field to the response schema:

```yaml
CommunityMetricsSummary:
  type: object
  properties:
    # ... existing metrics
    new_metric_name:
      type: integer
      description: Description of what this metric represents
```

After editing, regenerate types:
```bash
cd src/api-serverless && npm run restructure-openapi && npm run generate
```

### Step 6: Wire Up in CommunityMetricsService

Find `CommunityMetricsService.getCommunityMetricsSummary` and add the metric aggregation based on the chosen strategy:

**For Sum Strategy:**
```typescript
const newMetricName = await this.db.execute<{total: number}>(
  `SELECT COALESCE(SUM(value), 0) as total
   FROM metric_rollup_hour
   WHERE metric = :metric`,
  { metric: MetricRollupHourMetric.NEW_METRIC_NAME }
);

return {
  // ... existing metrics
  new_metric_name: newMetricName[0]?.total ?? 0
};
```

**For Custom Strategy:**
Implement the specific SQL query needed for the aggregation logic.

## Verification Checklist

After implementation, verify:

- [ ] Enum value added to `MetricRollupHourMetric`
- [ ] Recording function created in `MetricsRecorder`
- [ ] Recording function called in all identified locations
- [ ] Backfill migration created and SQL written
- [ ] OpenAPI schema updated with new field
- [ ] Types regenerated (`npm run restructure-openapi && npm run generate`)
- [ ] Aggregation logic added to `getCommunityMetricsSummary`
- [ ] Tests pass (`npm test`)
- [ ] Code builds (`npm run build`)

## Common Patterns

### Pattern: Simple Activity Counter
- **Use For**: Counting occurrences (drops created, votes cast)
- **Arguments**: Just the metric enum
- **Aggregation**: SUM of all values

### Pattern: Identity-Specific Metric
- **Use For**: Tracking per-user activity
- **Arguments**: Metric enum + identity ID
- **Aggregation**: SUM or COUNT with GROUP BY identity

### Pattern: Weighted Metric
- **Use For**: Metrics with varying values (reputation changes, token amounts)
- **Arguments**: Metric enum + amount
- **Aggregation**: SUM of amounts

## Files to Locate

Use these search patterns to find relevant files:

- `MetricRollupHourMetric`: `Grep "enum MetricRollupHourMetric"`
- `MetricsRecorder`: `Glob "**/*MetricsRecorder*"`
- `CommunityMetricsService`: `Glob "**/CommunityMetricsService*"`
- Migration files: Check `migrations/` directory
- OpenAPI: `openapi.yaml` in project root

## Example: Adding "Comments Created" Metric

1. **Enum**: Add `COMMENTS_CREATED` to `MetricRollupHourMetric`
2. **Recorder**: `async recordCommentCreated() { await this.recordMetric(MetricRollupHourMetric.COMMENTS_CREATED); }`
3. **Wiring**: Call in `comments.api.service.ts` after comment creation
4. **Backfill**: Aggregate from `comments` table grouped by hour
5. **OpenAPI**: Add `comments_created: integer` to response
6. **Service**: SUM all `COMMENTS_CREATED` values

## Next Steps

1. Use `AskUserQuestion` to gather the four required pieces of information
2. Search the codebase to locate the necessary files
3. Implement each step in order
4. Run tests and build to verify
5. Create migration and test backfill locally if possible

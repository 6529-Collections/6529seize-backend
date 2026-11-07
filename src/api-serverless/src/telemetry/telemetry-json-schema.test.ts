import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTelemetryJsonSchema,
  renderTelemetryJsonSchema
} from '@/api/telemetry/telemetry-json-schema';
import { TELEMETRY_PRODUCT_EVENTS } from '@/api/telemetry/telemetry.schema';

const SCHEMA_PATH = join(__dirname, 'telemetry-collector.v1.schema.json');

describe('telemetry JSON schema', () => {
  it('matches the published telemetry-collector.v1.schema.json', () => {
    const rendered = renderTelemetryJsonSchema();
    if (process.env.UPDATE_TELEMETRY_SCHEMA === '1') {
      writeFileSync(SCHEMA_PATH, rendered);
    }
    expect(readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(
      rendered
    );
  });

  it('describes every registered product event', () => {
    const schema = buildTelemetryJsonSchema() as any;
    expect(schema.$defs.event.properties.name.enum).toEqual(
      Object.keys(TELEMETRY_PRODUCT_EVENTS)
    );
    expect(schema.$defs.event.allOf).toHaveLength(
      Object.keys(TELEMETRY_PRODUCT_EVENTS).length
    );
  });

  it('keeps every product event within six props', () => {
    for (const spec of Object.values(TELEMETRY_PRODUCT_EVENTS)) {
      expect(Object.keys(spec).length).toBeLessThanOrEqual(6);
    }
  });
});

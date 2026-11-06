import {
  TELEMETRY_BROWSERS,
  TELEMETRY_DEVICES,
  TELEMETRY_ENTRY_ROUTE,
  TELEMETRY_FP_PATTERN,
  TELEMETRY_HEALTH_ENDPOINT_COUNTERS,
  TELEMETRY_HEALTH_ENUM_COUNTERS,
  TELEMETRY_HEALTH_SCALAR_COUNTERS,
  TELEMETRY_MAX_CLS,
  TELEMETRY_MAX_COUNT,
  TELEMETRY_MAX_DIMS_PER_COUNTER,
  TELEMETRY_MAX_EVENTS_PER_BATCH,
  TELEMETRY_MAX_PRODUCT_EVENT_PROPS,
  TELEMETRY_MAX_REFERRER_LENGTH,
  TELEMETRY_MAX_ROUTE_LENGTH,
  TELEMETRY_MAX_VITAL_MS,
  TELEMETRY_PLATFORMS,
  TELEMETRY_PRODUCT_EVENTS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_TIME_VITALS,
  TelemetryProductEventSpec
} from '@/api/telemetry/telemetry.schema';

type JsonSchema = Record<string, unknown>;

const count: JsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: TELEMETRY_MAX_COUNT
};
const ms: JsonSchema = {
  type: 'number',
  minimum: 0,
  maximum: TELEMETRY_MAX_VITAL_MS
};
const routeTemplate: JsonSchema = {
  type: 'string',
  maxLength: TELEMETRY_MAX_ROUTE_LENGTH,
  description:
    'Route template such as `/waves/[wave]` or `/[user]/collected`. Static segments are lowercase; ids and names must be placeholders (`[name]`, `[...name]`, `[[...name]]` or `:name`). Unknown first segments and id-looking segments are recorded as `/[other]`.'
};

function dimMap(keys: JsonSchema): JsonSchema {
  return {
    type: 'object',
    maxProperties: TELEMETRY_MAX_DIMS_PER_COUNTER,
    propertyNames: keys,
    additionalProperties: count
  };
}

function propSchema(spec: TelemetryProductEventSpec[string]): JsonSchema {
  return spec === true
    ? { type: 'boolean' }
    : { type: 'string', enum: [...spec] };
}

function productEventSchema(
  name: string,
  spec: TelemetryProductEventSpec
): JsonSchema {
  return {
    if: { properties: { name: { const: name } } },
    then: {
      properties: {
        p: {
          type: 'object',
          maxProperties: TELEMETRY_MAX_PRODUCT_EVENT_PROPS,
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.entries(spec).map(([prop, propSpec]) => [
              prop,
              propSchema(propSpec)
            ])
          )
        }
      }
    }
  };
}

function healthCounters(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const counter of TELEMETRY_HEALTH_SCALAR_COUNTERS) {
    properties[counter] = count;
  }
  for (const [counter, dims] of Object.entries(
    TELEMETRY_HEALTH_ENUM_COUNTERS
  )) {
    properties[counter] = dimMap({ enum: [...dims] });
  }
  for (const counter of TELEMETRY_HEALTH_ENDPOINT_COUNTERS) {
    properties[counter] = dimMap({
      ...routeTemplate,
      description: 'API endpoint template without `/api`, e.g. `/drops/[id]`.'
    });
  }
  return { type: 'object', additionalProperties: false, properties };
}

/**
 * JSON Schema (draft 2020-12) for collector batches, generated from
 * telemetry.schema.ts. The server is lenient where the schema is strict:
 * unknown fields, events, props and values are dropped instead of rejecting
 * the batch.
 */
export function buildTelemetryJsonSchema(): JsonSchema {
  const productEventNames = Object.keys(TELEMETRY_PRODUCT_EVENTS);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://6529.io/schemas/telemetry-collector.v1.json',
    title: '6529 first-party telemetry batch, v1',
    description:
      'POST /e (6529.io) or /api/e (API). Body at most 8192 bytes, text/plain or application/json. Responds 204. Never send URLs, query strings, titles, handles, wallet addresses, ids or free text.',
    type: 'object',
    required: ['v', 'events'],
    additionalProperties: false,
    properties: {
      v: { const: TELEMETRY_SCHEMA_VERSION },
      events: {
        type: 'array',
        maxItems: TELEMETRY_MAX_EVENTS_PER_BATCH,
        items: { $ref: '#/$defs/event' }
      }
    },
    $defs: {
      event: {
        type: 'object',
        required: ['v', 't', 'route', 'device', 'platform'],
        additionalProperties: false,
        properties: {
          v: { const: TELEMETRY_SCHEMA_VERSION },
          t: { enum: ['pv', 'vitals', 'ev', 'health'] },
          route: routeTemplate,
          device: { enum: [...TELEMETRY_DEVICES] },
          platform: { enum: [...TELEMETRY_PLATFORMS] },
          page_group: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
          prev_route: {
            anyOf: [{ const: TELEMETRY_ENTRY_ROUTE }, routeTemplate]
          },
          referrer_domain: {
            type: 'string',
            maxLength: TELEMETRY_MAX_REFERRER_LENGTH,
            description:
              'External hostname only, sent only when prev_route is `entry`.'
          },
          browser: { enum: [...TELEMETRY_BROWSERS] },
          signed_in: { type: 'boolean' },
          fp: {
            type: 'string',
            pattern: TELEMETRY_FP_PATTERN.source,
            description:
              'Optional coarse client hash for daily uniques (C52a). Used in memory only, never stored or logged. Omit for EU/EEA/UK/unknown-country visitors.'
          },
          ...Object.fromEntries(TELEMETRY_TIME_VITALS.map((m) => [m, ms])),
          cls: { type: 'number', minimum: 0, maximum: TELEMETRY_MAX_CLS },
          name: { enum: productEventNames },
          p: { type: 'object' },
          c: healthCounters(),
          ws_lag: ms
        },
        allOf: Object.entries(TELEMETRY_PRODUCT_EVENTS).map(([name, spec]) =>
          productEventSchema(name, spec)
        )
      }
    }
  };
}

export function renderTelemetryJsonSchema(): string {
  return `${JSON.stringify(buildTelemetryJsonSchema(), null, 2)}\n`;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

type HttpMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'patch'
  | 'options'
  | 'head';

type OpenApiSchema = {
  type?: string;
  format?: string;
  enum?: string[];
  $ref?: string;
  items?: OpenApiSchema;
};

type OpenApiParameter = {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: OpenApiSchema;
};

type OpenApiResponse = {
  content?: Record<string, { schema?: OpenApiSchema }>;
};

type OpenApiRequestBody = {
  content?: Record<string, { schema?: OpenApiSchema }>;
};

type RouteHandlerConfig = {
  import: string;
  name: string;
};

type RouteCacheConfig =
  | boolean
  | {
      enabled?: boolean;
      ttlSeconds?: number;
      authDependent?: boolean;
      methods?: string[];
    };

type RouteGenerationConfig = {
  enabled?: boolean;
  auth?: 'optional' | 'required' | 'none';
  cache?: RouteCacheConfig;
  handler?: RouteHandlerConfig;
  typeImportGroup?: string;
};

type OpenApiOperation = {
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  'x-6529-router'?: RouteGenerationConfig;
};

export type OpenApiDocument = {
  paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
};

export type GeneratedOpenApiRouteFile = {
  relativePath: string;
  content: string;
};

type GeneratedOperation = {
  auth: 'optional' | 'required' | 'none';
  cache?: NormalizedRouteCacheConfig;
  expressPath: string;
  handlerImport: string;
  handlerName: string;
  method: HttpMethod;
  operationId: string;
  pathParamsTypeName: string;
  queryTypeName: string;
  requestBodyModelImports: string[];
  requestBodyTypeExpression: string;
  requestTypeName: string;
  responseMode: 'json' | 'raw';
  responseModelImports: string[];
  responseTypeExpression: string;
  responseTypeName: string;
  typeImportGroup?: string;
  pathParams: OpenApiParameter[];
  queryParams: OpenApiParameter[];
};

type JsonResponseType = {
  modelImports: string[];
  responseMode: 'json' | 'raw';
  typeExpression: string;
};

type NormalizedRouteCacheConfig = {
  ttlSeconds?: number;
  authDependent?: boolean;
  methods?: string[];
};

const ROUTER_EXTENSION = 'x-6529-router';
const SUPPORTED_METHODS: HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'options',
  'head'
];

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function compareGeneratedOperations(
  a: GeneratedOperation,
  b: GeneratedOperation
): number {
  const aSegments = a.expressPath.split('/');
  const bSegments = b.expressPath.split('/');
  const sharedLength = Math.min(aSegments.length, bSegments.length);

  for (let index = 0; index < sharedLength; index++) {
    const aSegment = aSegments[index];
    const bSegment = bSegments[index];
    if (aSegment === bSegment) {
      continue;
    }

    const aIsParameter = aSegment?.startsWith(':') ?? false;
    const bIsParameter = bSegment?.startsWith(':') ?? false;
    if (aIsParameter !== bIsParameter) {
      return aIsParameter ? 1 : -1;
    }

    return compareStrings(aSegment ?? '', bSegment ?? '');
  }

  if (aSegments.length !== bSegments.length) {
    return aSegments.length - bSegments.length;
  }
  return compareStrings(a.method, b.method);
}

function getOptedInOperations(document: OpenApiDocument): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];
  const seenRoutes = new Set<string>();

  for (const [openApiPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of SUPPORTED_METHODS) {
      const operation = pathItem[method];
      const config = operation?.[ROUTER_EXTENSION];
      if (!operation || !config?.enabled) {
        continue;
      }
      operations.push(
        toGeneratedOperation({
          config,
          method,
          openApiPath,
          operation,
          seenRoutes
        })
      );
    }
  }

  return operations.sort((a, b) =>
    `${a.expressPath}:${a.method}`.localeCompare(`${b.expressPath}:${b.method}`)
  );
}

function toGeneratedOperation({
  config,
  method,
  openApiPath,
  operation,
  seenRoutes
}: {
  config: RouteGenerationConfig;
  method: HttpMethod;
  openApiPath: string;
  operation: OpenApiOperation;
  seenRoutes: Set<string>;
}): GeneratedOperation {
  if (!operation.operationId) {
    throw new Error(
      `Cannot generate route for ${method.toUpperCase()} ${openApiPath}: missing operationId`
    );
  }
  const auth = config.auth ?? 'none';
  if (!['optional', 'required', 'none'].includes(auth)) {
    throw new Error(
      `Cannot generate route for ${operation.operationId}: unsupported auth "${auth}"`
    );
  }
  if (!config.handler?.import || !config.handler.name) {
    throw new Error(
      `Cannot generate route for ${operation.operationId}: missing handler import/name`
    );
  }
  if (
    config.typeImportGroup !== undefined &&
    (!config.typeImportGroup.trim() || config.typeImportGroup.includes('\n'))
  ) {
    throw new Error(
      `Cannot generate route for ${operation.operationId}: typeImportGroup must be a non-empty single-line string`
    );
  }

  const expressPath = toExpressPath(openApiPath);
  const routeKey = `${method.toUpperCase()} ${expressPath}`;
  if (seenRoutes.has(routeKey)) {
    throw new Error(`Duplicate generated route ${routeKey}`);
  }
  seenRoutes.add(routeKey);

  const responseType = getResponseType(operation);
  const requestBodyType = getRequestBodyType(operation);
  const typePrefix = toPascalCase(operation.operationId);
  const parameters = operation.parameters ?? [];
  const unsupportedParameters = parameters.filter(
    (param) => param.in !== 'path' && param.in !== 'query'
  );
  if (unsupportedParameters.length) {
    throw new Error(
      `Cannot generate route for ${
        operation.operationId
      }: unsupported parameter locations ${unsupportedParameters
        .map((param) => param.in)
        .join(', ')}`
    );
  }

  return {
    auth,
    cache: normalizeCacheConfig(config.cache, operation.operationId),
    expressPath,
    handlerImport: config.handler.import,
    handlerName: config.handler.name,
    method,
    operationId: operation.operationId,
    pathParamsTypeName: `${typePrefix}PathParams`,
    queryTypeName: `${typePrefix}Query`,
    requestBodyModelImports: requestBodyType.modelImports,
    requestBodyTypeExpression: requestBodyType.typeExpression,
    requestTypeName: `${typePrefix}Request`,
    responseMode: responseType.responseMode,
    responseModelImports: responseType.modelImports,
    responseTypeExpression: responseType.typeExpression,
    responseTypeName: `${typePrefix}Response`,
    typeImportGroup: config.typeImportGroup,
    pathParams: parameters.filter((param) => param.in === 'path'),
    queryParams: parameters.filter((param) => param.in === 'query')
  };
}

function normalizeCacheConfig(
  cache: RouteCacheConfig | undefined,
  operationId: string
): NormalizedRouteCacheConfig | undefined {
  if (!cache) {
    return undefined;
  }
  if (cache === true) {
    return {};
  }
  if (typeof cache !== 'object') {
    throw new TypeError(
      `Cannot generate route for ${operationId}: cache must be true or an options object`
    );
  }
  const supportedKeys = new Set([
    'enabled',
    'ttlSeconds',
    'authDependent',
    'methods'
  ]);
  const unsupportedKeys = Object.keys(cache).filter(
    (key) => !supportedKeys.has(key)
  );
  if (unsupportedKeys.length) {
    throw new Error(
      `Cannot generate route for ${operationId}: unsupported cache options ${unsupportedKeys.join(
        ', '
      )}`
    );
  }
  if (cache.enabled === false) {
    return undefined;
  }
  if (
    cache.ttlSeconds !== undefined &&
    (!Number.isFinite(cache.ttlSeconds) || cache.ttlSeconds <= 0)
  ) {
    throw new Error(
      `Cannot generate route for ${operationId}: cache.ttlSeconds must be a positive number`
    );
  }
  if (
    cache.authDependent !== undefined &&
    typeof cache.authDependent !== 'boolean'
  ) {
    throw new Error(
      `Cannot generate route for ${operationId}: cache.authDependent must be a boolean`
    );
  }
  if (
    cache.methods !== undefined &&
    (!Array.isArray(cache.methods) ||
      cache.methods.length === 0 ||
      cache.methods.some((method) => typeof method !== 'string' || !method))
  ) {
    throw new Error(
      `Cannot generate route for ${operationId}: cache.methods must be a non-empty string array`
    );
  }
  return {
    ttlSeconds: cache.ttlSeconds,
    authDependent: cache.authDependent,
    methods: cache.methods
  };
}

function getRefModelName(ref: string): string {
  return ref.substring(ref.lastIndexOf('/') + 1);
}

function getResponseType(operation: OpenApiOperation): JsonResponseType {
  const successResponse = operation.responses?.['200'];
  const jsonSchema = successResponse?.content?.['application/json']?.schema;
  const ref = jsonSchema?.$ref;
  if (ref) {
    const modelName = getRefModelName(ref);
    return {
      modelImports: [modelName],
      responseMode: 'json',
      typeExpression: modelName
    };
  }

  const arrayItemRef =
    jsonSchema?.type === 'array' ? jsonSchema.items?.$ref : undefined;
  if (arrayItemRef) {
    const modelName = getRefModelName(arrayItemRef);
    return {
      modelImports: [modelName],
      responseMode: 'json',
      typeExpression: `${modelName}[]`
    };
  }

  const csvSchema = successResponse?.content?.['text/csv']?.schema;
  if (csvSchema?.type === 'string') {
    return {
      modelImports: [],
      responseMode: 'raw',
      typeExpression: 'string'
    };
  }

  throw new Error(
    `Cannot generate route for ${operation.operationId}: expected a 200 application/json $ref, array of $ref, or text/csv string response`
  );
}

function getRequestBodyType(operation: OpenApiOperation): {
  modelImports: string[];
  typeExpression: string;
} {
  if (!operation.requestBody) {
    return {
      modelImports: [],
      typeExpression: 'never'
    };
  }

  const jsonSchema =
    operation.requestBody.content?.['application/json']?.schema;
  const ref = jsonSchema?.$ref;
  if (ref) {
    const modelName = getRefModelName(ref);
    return {
      modelImports: [modelName],
      typeExpression: modelName
    };
  }

  throw new Error(
    `Cannot generate route for ${operation.operationId}: expected an application/json requestBody $ref`
  );
}

function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/{([^}]+)}/g, ':$1');
}

function toPascalCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function getParameterType(param: OpenApiParameter): string {
  const schema = param.schema ?? {};
  if (schema.enum?.length) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `${getParameterType({
        ...param,
        schema: schema.items ?? { type: 'string' }
      })}[]`;
    case 'string':
    default:
      return 'string';
  }
}

function renderParameterInterface(
  typeName: string,
  parameters: OpenApiParameter[]
): string {
  if (!parameters.length) {
    return `export type ${typeName} = Record<string, never>;\n`;
  }
  const fields = parameters
    .map((param) => {
      const optional = param.required ? '' : '?';
      return `  ${JSON.stringify(param.name)}${optional}: ${getParameterType(
        param
      )};`;
    })
    .join('\n');
  return `export interface ${typeName} {\n${fields}\n}\n`;
}

function renderOperationsFile(operations: GeneratedOperation[]): string {
  const modelImports = Array.from(
    new Set(
      operations.flatMap((operation) => [
        ...operation.responseModelImports,
        ...operation.requestBodyModelImports
      ])
    )
  ).sort(compareStrings);
  const importsApiResponse = operations.some(
    (operation) => operation.responseMode === 'json'
  );
  const blocks = operations
    .map((operation) => {
      const responseBodyType =
        operation.responseMode === 'json'
          ? `ApiResponse<${operation.responseTypeName}>`
          : operation.responseTypeName;
      return [
        renderParameterInterface(
          operation.pathParamsTypeName,
          operation.pathParams
        ).trimEnd(),
        renderParameterInterface(
          operation.queryTypeName,
          operation.queryParams
        ).trimEnd(),
        `export type ${operation.responseTypeName} = ${operation.responseTypeExpression};`,
        `export type ${operation.requestTypeName} = Request<\n  ${operation.pathParamsTypeName},\n  ${responseBodyType},\n  ${operation.requestBodyTypeExpression},\n  ${operation.queryTypeName},\n  Record<string, never>\n>;`
      ].join('\n\n');
    })
    .join('\n\n');

  return [
    '// This file is auto-generated by generate-openapi-routes.ts. Do not edit manually.',
    "import { Request } from 'express';",
    importsApiResponse
      ? "import { ApiResponse } from '@/api/api-response';"
      : '',
    ...modelImports.map(
      (modelName) =>
        `import { ${modelName} } from '@/api/generated/models/${modelName}';`
    ),
    '',
    blocks,
    ''
  ].join('\n');
}

function renderRoutesFile(operations: GeneratedOperation[]): string {
  const handlerImports = renderHandlerImports(operations);
  const typeImportsByGroup = new Map<string, string[]>();
  for (const operation of operations) {
    const group = operation.typeImportGroup ?? '';
    const typeImports = typeImportsByGroup.get(group) ?? [];
    typeImports.push(operation.requestTypeName, operation.responseTypeName);
    typeImportsByGroup.set(group, typeImports);
  }
  const authImports = Array.from(
    new Set(
      operations
        .map((operation) => operation.auth)
        .filter((auth) => auth !== 'none')
        .map((auth) =>
          auth === 'optional'
            ? 'maybeAuthenticatedUser'
            : 'needsAuthenticatedUser'
        )
    )
  ).sort(compareStrings);
  const importsCacheRequest = operations.some((operation) => operation.cache);
  const importsTime = operations.some(
    (operation) => operation.cache?.ttlSeconds !== undefined
  );
  const importsApiResponse = operations.some(
    (operation) => operation.responseMode === 'json'
  );
  const routeBlocks = [...operations]
    .sort(compareGeneratedOperations)
    .map(renderRouteBlock)
    .join('\n\n');
  const typeImportLinesByGroup = Array.from(typeImportsByGroup.entries())
    .sort(([a], [b]) => {
      if (!a) return -1;
      if (!b) return 1;
      return compareStrings(a, b);
    })
    .map(([group, typeImports]) => {
      const sortedTypeImports = typeImports.sort(compareStrings);
      return {
        group,
        line: `import { ${sortedTypeImports.join(', ')} } from './operations';`
      };
    });
  const defaultTypeImportLines = typeImportLinesByGroup
    .filter(({ group }) => !group)
    .map(({ line }) => line);
  const groupedTypeImportLines = typeImportLinesByGroup
    .filter(({ group }) => group)
    .map(({ line }) => line);

  return [
    '// This file is auto-generated by generate-openapi-routes.ts. Do not edit manually.',
    "import { asyncRouter } from '@/api/async.router';",
    importsApiResponse
      ? "import { ApiResponse } from '@/api/api-response';"
      : '',
    authImports.length
      ? `import { ${authImports.join(', ')} } from '@/api/auth/auth';`
      : '',
    importsCacheRequest
      ? "import { cacheRequest } from '@/api/request-cache';"
      : '',
    importsTime ? "import { Time } from '@/time';" : '',
    "import { Response } from 'express';",
    ...groupedTypeImportLines,
    ...handlerImports,
    ...defaultTypeImportLines,
    '',
    'const router = asyncRouter();',
    '',
    routeBlocks,
    '',
    'export default router;',
    ''
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function renderHandlerImports(operations: GeneratedOperation[]): string[] {
  const handlerNamesByImport = new Map<string, Set<string>>();
  for (const operation of operations) {
    const handlerNames =
      handlerNamesByImport.get(operation.handlerImport) ?? new Set<string>();
    handlerNames.add(operation.handlerName);
    handlerNamesByImport.set(operation.handlerImport, handlerNames);
  }
  return Array.from(handlerNamesByImport.entries())
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([importPath, handlerNames]) => {
      const sortedHandlerNames = Array.from(handlerNames).sort(compareStrings);
      return `import { ${sortedHandlerNames.join(
        ', '
      )} } from '${importPath}';`;
    });
}

function renderRouteBlock(operation: GeneratedOperation): string {
  const middleware = [
    renderAuthMiddleware(operation),
    renderCacheMiddleware(operation.cache)
  ].filter((value): value is string => !!value);
  const middlewareLines = middleware.length
    ? `\n  ${middleware.join(',\n  ')},`
    : '';
  if (operation.responseMode === 'raw') {
    return `router.${operation.method}(\n  '${operation.expressPath}',${middlewareLines}\n  async (\n    req: ${operation.requestTypeName},\n    res: Response<${operation.responseTypeName}>\n  ) => {\n    await ${operation.handlerName}(req, res);\n  }\n);`;
  }
  return `router.${operation.method}(\n  '${operation.expressPath}',${middlewareLines}\n  async (\n    req: ${operation.requestTypeName},\n    res: Response<ApiResponse<${operation.responseTypeName}>>\n  ) => {\n    res.send(await ${operation.handlerName}(req));\n  }\n);`;
}

function renderAuthMiddleware(
  operation: GeneratedOperation
): string | undefined {
  if (operation.auth === 'none') {
    return undefined;
  }
  return `${
    operation.auth === 'optional'
      ? 'maybeAuthenticatedUser'
      : 'needsAuthenticatedUser'
  }()`;
}

function renderCacheMiddleware(
  cache: NormalizedRouteCacheConfig | undefined
): string | undefined {
  if (!cache) {
    return undefined;
  }
  const options: string[] = [];
  if (cache.ttlSeconds !== undefined) {
    options.push(`ttl: Time.seconds(${cache.ttlSeconds})`);
  }
  if (cache.authDependent !== undefined) {
    options.push(`authDependent: ${cache.authDependent}`);
  }
  if (cache.methods !== undefined) {
    options.push(
      `methods: [${cache.methods
        .map((method) => JSON.stringify(method))
        .join(', ')}]`
    );
  }
  if (!options.length) {
    return 'cacheRequest()';
  }
  return `cacheRequest({ ${options.join(', ')} })`;
}

function renderIndexFile(): string {
  return [
    '// This file is auto-generated by generate-openapi-routes.ts. Do not edit manually.',
    "export { default } from './openapi-generated.routes';",
    ''
  ].join('\n');
}

export function generateOpenApiRouteFiles(
  document: OpenApiDocument
): GeneratedOpenApiRouteFile[] {
  const operations = getOptedInOperations(document);
  return [
    {
      relativePath: 'operations.ts',
      content: renderOperationsFile(operations)
    },
    {
      relativePath: 'openapi-generated.routes.ts',
      content: renderRoutesFile(operations)
    },
    {
      relativePath: 'index.ts',
      content: renderIndexFile()
    }
  ];
}

export function generateOpenApiRoutes({
  inputPath = './openapi.yaml',
  outputDir = './src/generated/routes'
}: {
  inputPath?: string;
  outputDir?: string;
} = {}): void {
  const fileContents = fs.readFileSync(inputPath, 'utf8');
  const document = yaml.load(fileContents) as OpenApiDocument;
  const files = generateOpenApiRouteFiles(document);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  for (const file of files) {
    fs.writeFileSync(
      path.join(outputDir, file.relativePath),
      file.content,
      'utf8'
    );
  }
}

if (require.main === module) {
  generateOpenApiRoutes();
}

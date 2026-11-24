import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'generated', 'dist'].includes(entry.name)
        ? []
        : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

interface SdkNames {
  factories: Set<string>;
  types: Set<string>;
}

function addImportNames(statement: ts.Statement, names: SdkNames): void {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    !/arweave/.test(statement.moduleSpecifier.text)
  )
    return;
  const clause = statement.importClause;
  if (statement.moduleSpecifier.text === 'arweave' && clause?.name)
    names.types.add(clause.name.text);
  const named = clause?.namedBindings;
  if (!named || !ts.isNamedImports(named)) return;
  for (const item of named.elements) {
    if (names.factories.has(item.propertyName?.text ?? item.name.text))
      names.factories.add(item.name.text);
  }
}

function addFactoryBinding(
  node: ts.Node,
  source: ts.SourceFile,
  names: SdkNames,
  bindings: Set<string>
): void {
  if (
    !ts.isVariableDeclaration(node) ||
    !node.initializer ||
    !ts.isCallExpression(node.initializer)
  )
    return;
  const factory = node.initializer.expression.getText(source);
  if (
    !names.factories.has(factory) &&
    !Array.from(names.types).some((type) => factory === `${type}.init`)
  )
    return;
  if (ts.isIdentifier(node.name)) {
    bindings.add(node.name.text);
    return;
  }
  for (const item of node.name.elements) {
    if (
      ts.isBindingElement(item) &&
      ts.isIdentifier(item.name) &&
      (item.propertyName?.getText(source) ?? item.name.text) === 'arweave'
    )
      bindings.add(item.name.text);
  }
}

function addTypedBinding(
  node: ts.Node,
  source: ts.SourceFile,
  names: SdkNames,
  bindings: Set<string>
): void {
  if (
    !(
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isVariableDeclaration(node)
    )
  )
    return;
  if (
    node.type &&
    names.types.has(node.type.getText(source)) &&
    ts.isIdentifier(node.name)
  )
    bindings.add(node.name.text);
}

function sdkBindings(source: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  const names = {
    factories: new Set(['createArweaveClient', 'getArweaveInstance']),
    types: new Set(['Arweave'])
  };
  for (const statement of source.statements) addImportNames(statement, names);
  const visit = (node: ts.Node) => {
    addFactoryBinding(node, source, names, bindings);
    addTypedBinding(node, source, names, bindings);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function directSdkPost(
  call: ts.CallExpression,
  bindings: Set<string>
): boolean {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'post')
    return false;
  const api = method.expression;
  if (!ts.isPropertyAccessExpression(api) || api.name.text !== 'api')
    return false;
  const receiver = api.expression;
  const name = ts.isIdentifier(receiver)
    ? receiver.text
    : ts.isPropertyAccessExpression(receiver)
      ? receiver.name.text
      : '';
  const endpoint = call.arguments[0];
  return (
    bindings.has(name) &&
    endpoint !== undefined &&
    ts.isStringLiteralLike(endpoint) &&
    /^\/?(?:tx|chunk)$/.test(endpoint.text)
  );
}

function violationsIn(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const bindings = sdkBindings(source);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (
        ['uploadChunk', 'getUploader', 'createTransaction'].includes(method) ||
        (method === 'init' &&
          /arweave/i.test(node.expression.expression.getText(source))) ||
        directSdkPost(node, bindings)
      )
        violations.push(`${name}:${method}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

it('keeps selected SDK creation and submission calls inside the shared Arweave boundary', () => {
  const root = join(__dirname, '..');
  const violations = sources(root).flatMap((path) => {
    const name = relative(root, path);
    return name.startsWith('arweave/')
      ? []
      : violationsIn(name, readFileSync(path, 'utf8'));
  });
  expect(violations).toEqual([]);
});

it.each(['chunk', '/chunk', 'tx'])(
  'detects direct SDK api.post to %s while allowing unrelated post calls',
  (endpoint) => {
    const text = `import { createArweaveClient as create } from '@/arweave/client';
      const client = create(); client.api.post('${endpoint}', payload);
      httpClient.api.post('${endpoint}', payload); client.api.post('graphql', query);`;
    expect(violationsIn('outside.ts', text)).toEqual(['outside.ts:post']);
  }
);

it('detects a typed SDK receiver without blocking an unrelated typed client', () => {
  const text = `import Ar from 'arweave';
    function send(client: Ar, httpClient: HttpClient) {
      client.api.post('chunk', payload); httpClient.api.post('chunk', payload);
    }`;
  expect(violationsIn('outside.ts', text)).toEqual(['outside.ts:post']);
});

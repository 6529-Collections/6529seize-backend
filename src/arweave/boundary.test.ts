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

type SdkKind =
  | 'sdk'
  | 'container'
  | 'class'
  | 'clientFactory'
  | 'containerFactory'
  | undefined;

function importKind(declaration: ts.Declaration): SdkKind {
  if (
    ts.isImportClause(declaration) &&
    declaration.name &&
    ts.isStringLiteral(declaration.parent.moduleSpecifier) &&
    declaration.parent.moduleSpecifier.text === 'arweave'
  )
    return 'class';
  if (!ts.isImportSpecifier(declaration)) return undefined;
  const imported = declaration.parent.parent.parent;
  if (
    !ts.isImportDeclaration(imported) ||
    !ts.isStringLiteral(imported.moduleSpecifier) ||
    !/(^|\/)arweave(?:\/client)?$/.test(imported.moduleSpecifier.text)
  )
    return undefined;
  const name = declaration.propertyName?.text ?? declaration.name.text;
  if (name === 'createArweaveClient') return 'clientFactory';
  if (name === 'getArweaveInstance') return 'containerFactory';
  return undefined;
}

function sdkClassifier(
  source: ts.SourceFile
): (expression: ts.Expression) => SdkKind {
  // Let TypeScript bind lexical declarations; a name in a different function or
  // a shadowing local must not inherit an SDK type from elsewhere in the file.
  const options = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) =>
    name === source.fileName ? source : undefined;
  const checker = ts
    .createProgram([source.fileName], options, host)
    .getTypeChecker();
  const resolving = new Set<ts.Node>();
  const symbolKind = (node: ts.Node): SdkKind => {
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
    for (const declaration of declarations) {
      if (resolving.has(declaration)) continue;
      resolving.add(declaration);
      try {
        const kind = declarationKind(declaration);
        if (kind) return kind;
      } finally {
        resolving.delete(declaration);
      }
    }
    return undefined;
  };
  const declarationKind = (node: ts.Declaration): SdkKind => {
    const imported = importKind(node);
    if (imported) return imported;
    if (ts.isBindingElement(node)) {
      const variable = node.parent.parent;
      if (
        (node.propertyName?.getText(source) ?? node.name.getText(source)) ===
          'arweave' &&
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        classify(variable.initializer) === 'container'
      )
        return 'sdk';
      return undefined;
    }
    if (
      !(
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyDeclaration(node)
      )
    )
      return undefined;
    if (
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      symbolKind(node.type.typeName) === 'class'
    )
      return 'sdk';
    return node.initializer ? classify(node.initializer) : undefined;
  };
  const callKind = (call: ts.CallExpression): SdkKind => {
    const method = call.expression;
    const factory = classify(method);
    if (factory === 'clientFactory') return 'sdk';
    if (factory === 'containerFactory') return 'container';
    if (!ts.isPropertyAccessExpression(method)) return undefined;
    const receiver = classify(method.expression);
    if (method.name.text === 'init' && receiver === 'class') return 'sdk';
    if (method.name.text === 'getUploader' && receiver === 'sdk') return 'sdk';
    return undefined;
  };
  const classify = (expression: ts.Expression): SdkKind => {
    if (
      ts.isAwaitExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    )
      return classify(expression.expression);
    if (ts.isIdentifier(expression)) return symbolKind(expression);
    if (ts.isCallExpression(expression)) return callKind(expression);
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    if (expression.expression.kind === ts.SyntaxKind.ThisKeyword)
      return symbolKind(expression.name);
    const receiver = classify(expression.expression);
    if (expression.name.text === 'arweave' && receiver === 'container')
      return 'sdk';
    return ['transactions', 'api'].includes(expression.name.text) &&
      receiver === 'sdk'
      ? 'sdk'
      : undefined;
  };
  return classify;
}

function directSdkPost(
  call: ts.CallExpression,
  classify: ReturnType<typeof sdkClassifier>
): boolean {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'post')
    return false;
  const api = method.expression;
  if (!ts.isPropertyAccessExpression(api) || api.name.text !== 'api')
    return false;
  const endpoint = call.arguments[0];
  return (
    classify(api.expression) === 'sdk' &&
    endpoint !== undefined &&
    ts.isStringLiteralLike(endpoint) &&
    /^\/?(?:tx|chunk)$/.test(endpoint.text)
  );
}

function violationsIn(name: string, text: string): string[] {
  if (!text.includes('arweave')) return [];
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const classify = sdkClassifier(source);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (
        ![
          'uploadChunk',
          'getUploader',
          'createTransaction',
          'init',
          'post'
        ].includes(method)
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const receiver = classify(node.expression.expression);
      if (
        (['uploadChunk', 'getUploader', 'createTransaction'].includes(method) &&
          receiver === 'sdk') ||
        (method === 'init' && receiver === 'class') ||
        directSdkPost(node, classify)
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

it('detects aliased SDK initialization and permits unrelated init methods', () => {
  const text = `import Ar from 'arweave'; Ar.init(config); otherArweaveTools.init(config);`;
  expect(violationsIn('outside.ts', text)).toEqual(['outside.ts:init']);
});

it('restricts transaction and uploader methods to resolved SDK receivers', () => {
  const text = `import { createArweaveClient } from '@/arweave/client';
    const client = createArweaveClient(); client.createTransaction(data);
    const uploader = await client.transactions.getUploader(tx); uploader.uploadChunk();
    payments.createTransaction(data); payments.getUploader(tx); payments.uploadChunk();`;
  expect(violationsIn('outside.ts', text)).toEqual([
    'outside.ts:createTransaction',
    'outside.ts:getUploader',
    'outside.ts:uploadChunk'
  ]);
});

it('resolves same-named parameters, nested shadows and factories in their lexical scope', () => {
  const text = `import Ar from 'arweave';
    import { createArweaveClient as create } from '@/arweave/client';
    function sdk(client: Ar) { client.createTransaction(data); }
    function payments(client: Payments) { client.createTransaction(data); client.api.post('chunk', data); }
    function shadow(create: () => Payments) { create().api.post('chunk', data); }
    const client = create();
    { const client = payments; client.createTransaction(data); }
    client.api.post('tx', data);`;
  expect(violationsIn('outside.ts', text)).toEqual([
    'outside.ts:createTransaction',
    'outside.ts:post'
  ]);
});

it('recognizes inline imported factories, destructured instances and typed class properties', () => {
  const text = `import Ar from 'arweave';
    import { createArweaveClient as create } from '@/arweave/client';
    import { getArweaveInstance as instance } from '@/arweave';
    create().api.post('chunk', data); paymentFactory().api.post('chunk', data);
    instance().arweave.api.post('tx', data);
    const { arweave: client } = instance(); client.createTransaction(data);
    class Sender { constructor(private client: Ar) {} send() { this.client.api.post('chunk', data); } }
    class Payments { constructor(private client: PaymentsClient) {} send() { this.client.api.post('chunk', data); } }`;
  expect(violationsIn('outside.ts', text)).toEqual([
    'outside.ts:post',
    'outside.ts:post',
    'outside.ts:createTransaction',
    'outside.ts:post'
  ]);
});

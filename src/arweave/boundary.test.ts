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

it('keeps SDK creation and upload/chunk submission inside the shared Arweave boundary', () => {
  const root = join(__dirname, '..');
  const violations: string[] = [];
  for (const path of sources(root)) {
    const name = relative(root, path);
    if (name.startsWith('arweave/')) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        if (
          ['uploadChunk', 'getUploader', 'createTransaction'].includes(
            method
          ) ||
          (method === 'init' &&
            /arweave/i.test(node.expression.expression.getText(source)))
        )
          violations.push(`${name}:${method}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

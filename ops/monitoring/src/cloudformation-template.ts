import { parseDocument } from 'yaml';

interface Resource extends Record<string, unknown> {
  Type: string;
}
interface Template extends Record<string, unknown> {
  Resources: Record<string, Resource>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** AWS returns original templates as objects, JSON strings or YAML strings.
 * Long-form intrinsic functions remain intact. Reject unsupported short-form
 * tags instead of silently discarding their CloudFormation semantics. */
export function parseCloudFormationTemplate(body: unknown): Template {
  let template = body;
  if (typeof body === 'string') {
    try {
      const document = parseDocument(body);
      if (document.errors.length || document.warnings.length)
        throw new Error('Unsupported template encoding');
      template = document.toJS({ maxAliasCount: 100 });
    } catch {
      throw new Error(
        'Invalid or unsupported CloudFormation template encoding'
      );
    }
  }
  if (!isRecord(template) || !isRecord(template.Resources))
    throw new Error('CloudFormation template must contain a resource mapping');
  for (const resource of Object.values(template.Resources)) {
    if (!isRecord(resource) || typeof resource.Type !== 'string')
      throw new Error('CloudFormation resource must contain a type');
  }
  return template as Template;
}

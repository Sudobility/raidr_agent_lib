/**
 * GraphQL tools: a site API whose tool takes a GraphQL `query` document.
 *
 * The planner cannot know a site's schema, and guessing field names wastes
 * every round on "Field 'x' doesn't exist". So before planning, the runner
 * introspects the schema once through the tool itself
 * ({@link introspectionArguments}) and hands the planner a compact summary
 * ({@link summarizeSchema}): the root query fields with their arguments, and
 * the object, input and enum types reachable from them, as GraphQL SDL lines.
 */
import type { McpTool } from '@sudobility/raidr_types';

/** Most characters of schema summary shown to the planner per tool. */
export const MAX_SCHEMA_SUMMARY = 6_000;

/** How deep from the root query fields types are followed. */
const MAX_DEPTH = 4;

/** Most enum values listed per enum. */
const MAX_ENUM_VALUES = 40;

/** The standard introspection query, trimmed to what the summary uses. */
export const INTROSPECTION_QUERY =
  'query IntrospectionQuery { __schema { queryType { name } types { kind name ' +
  'fields { name args { name type { ...T } } type { ...T } } ' +
  'inputFields { name type { ...T } } enumValues { name } } } } ' +
  'fragment T on __Type { kind name ofType { kind name ofType { kind name ' +
  'ofType { kind name } } } }';

type Props = Record<
  string,
  { type?: unknown; description?: unknown; examples?: unknown; enum?: unknown }
>;

function properties(tool: McpTool): Props {
  const schema = tool.inputSchema as { properties?: Props } | undefined;
  return schema?.properties ?? {};
}

/** Whether `tool` sends a GraphQL document in its `query` argument. */
export function isGraphqlTool(tool: McpTool): boolean {
  const query = properties(tool).query;
  if (!query || query.type !== 'string') return false;
  const request = (tool as { request?: { pathTemplate?: unknown } }).request;
  const text = [
    tool.description,
    typeof query.description === 'string' ? query.description : '',
    typeof request?.pathTemplate === 'string' ? request.pathTemplate : '',
  ].join(' ');
  return /graphql/i.test(text);
}

/**
 * Arguments that send {@link INTROSPECTION_QUERY} through `tool`: the query,
 * plus `operationName` / `variables` when the tool has them, plus the first
 * recorded example (or enum value) of any other required argument.
 */
export function introspectionArguments(tool: McpTool): Record<string, unknown> {
  const props = properties(tool);
  const args: Record<string, unknown> = { query: INTROSPECTION_QUERY };
  if (props.operationName) args.operationName = 'IntrospectionQuery';
  if (props.variables) args.variables = {};
  const required =
    (tool.inputSchema as { required?: unknown } | undefined)?.required ?? [];
  for (const name of Array.isArray(required) ? required : []) {
    if (typeof name !== 'string' || name in args) continue;
    const prop = props[name];
    const example = Array.isArray(prop?.examples)
      ? prop.examples[0]
      : Array.isArray(prop?.enum)
        ? prop.enum[0]
        : undefined;
    if (example !== undefined) args[name] = example;
  }
  return args;
}

interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  args?: Array<{ name: string; type: TypeRef }>;
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string;
  fields?: Field[] | null;
  inputFields?: Array<{ name: string; type: TypeRef }> | null;
  enumValues?: Array<{ name: string }> | null;
}

function render(ref: TypeRef | null | undefined): string {
  if (!ref) return '?';
  if (ref.kind === 'NON_NULL') return `${render(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${render(ref.ofType)}]`;
  return ref.name ?? '?';
}

function named(ref: TypeRef | null | undefined): string | null {
  let current = ref;
  while (current && !current.name) current = current.ofType;
  return current?.name ?? null;
}

/**
 * The introspection answer as compact SDL: `query { … }` with the root
 * fields and their arguments, then the types reachable from them
 * (breadth-first, {@link MAX_DEPTH} deep), cut at `maxChars`. Null when the
 * answer holds no schema.
 */
export function summarizeSchema(
  answer: unknown,
  maxChars = MAX_SCHEMA_SUMMARY
): string | null {
  const root =
    (answer as { data?: { __schema?: unknown } })?.data?.__schema ??
    (answer as { __schema?: unknown })?.__schema;
  const schema = root as
    { queryType?: { name?: string }; types?: FullType[] } | undefined;
  if (!schema?.types || !Array.isArray(schema.types)) return null;
  const types = new Map(schema.types.map(t => [t.name, t]));
  const queryType = types.get(schema.queryType?.name ?? 'Query');
  if (!queryType?.fields) return null;

  const fieldLine = (f: Field) => {
    const args = (f.args ?? [])
      .map(a => `${a.name}: ${render(a.type)}`)
      .join(', ');
    return `${f.name}${args ? `(${args})` : ''}: ${render(f.type)}`;
  };
  const lines = [`query { ${queryType.fields.map(fieldLine).join('; ')} }`];
  const seen = new Set<string>([queryType.name]);
  let frontier = queryType.fields.flatMap(f => [
    named(f.type),
    ...(f.args ?? []).map(a => named(a.type)),
  ]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: Array<string | null> = [];
    for (const name of frontier) {
      if (!name || seen.has(name) || name.startsWith('__')) continue;
      seen.add(name);
      const type = types.get(name);
      if (!type) continue;
      if (type.kind === 'ENUM') {
        const values = (type.enumValues ?? []).map(v => v.name);
        lines.push(
          `enum ${name} = ${values.slice(0, MAX_ENUM_VALUES).join(' | ')}${values.length > MAX_ENUM_VALUES ? ' | …' : ''}`
        );
      } else if (type.kind === 'OBJECT' || type.kind === 'INTERFACE') {
        const fields = type.fields ?? [];
        lines.push(
          `type ${name} { ${fields.map(f => `${f.name}: ${render(f.type)}`).join('; ')} }`
        );
        for (const f of fields) next.push(named(f.type));
      } else if (type.kind === 'INPUT_OBJECT') {
        const fields = type.inputFields ?? [];
        lines.push(
          `input ${name} { ${fields.map(f => `${f.name}: ${render(f.type)}`).join('; ')} }`
        );
        for (const f of fields) next.push(named(f.type));
      }
    }
    frontier = next;
  }
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += `${line}\n`;
  }
  return out.trimEnd() || null;
}

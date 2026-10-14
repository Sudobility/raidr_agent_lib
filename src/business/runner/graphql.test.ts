import { describe, expect, it } from 'vitest';
import type { McpTool } from '@sudobility/raidr_types';
import {
  INTROSPECTION_QUERY,
  introspectionArguments,
  isGraphqlTool,
  summarizeSchema,
} from './graphql';

const graphqlTool = {
  name: 'search_discover_events',
  description: 'Searches Discover events through a GraphQL query.',
  inputSchema: {
    type: 'object',
    required: ['operationName', 'variables', 'query', 'sha256'],
    properties: {
      query: { type: 'string', description: 'GraphQL query document text.' },
      operationName: { type: 'string' },
      variables: { type: 'object' },
      sha256: { type: 'string', examples: ['abc123'] },
    },
  },
  request: { method: 'POST', pathTemplate: '/discover/graphql' },
} as unknown as McpTool;

describe('isGraphqlTool', () => {
  it('needs a string query and a GraphQL mention', () => {
    expect(isGraphqlTool(graphqlTool)).toBe(true);
    const search = {
      name: 'search',
      description: 'Search events by text.',
      inputSchema: { properties: { query: { type: 'string' } } },
      request: { method: 'GET', pathTemplate: '/api/search' },
    } as unknown as McpTool;
    expect(isGraphqlTool(search)).toBe(false);
  });
});

describe('introspectionArguments', () => {
  it('sends the introspection query with the tool’s own required arguments', () => {
    expect(introspectionArguments(graphqlTool)).toEqual({
      query: INTROSPECTION_QUERY,
      operationName: 'IntrospectionQuery',
      variables: {},
      sha256: 'abc123',
    });
  });
});

describe('summarizeSchema', () => {
  const t = (name: string, kind = 'OBJECT') => ({ kind, name, ofType: null });
  const list = (inner: object) => ({ kind: 'LIST', name: null, ofType: inner });
  const answer = {
    data: {
      __schema: {
        queryType: { name: 'Query' },
        types: [
          {
            kind: 'OBJECT',
            name: 'Query',
            fields: [
              {
                name: 'search',
                args: [
                  { name: 'query', type: t('String', 'SCALAR') },
                  { name: 'time', type: t('TimeFilter', 'ENUM') },
                ],
                type: t('Search'),
              },
            ],
          },
          {
            kind: 'OBJECT',
            name: 'Search',
            fields: [{ name: 'events', args: [], type: list(t('Event')) }],
          },
          {
            kind: 'OBJECT',
            name: 'Event',
            fields: [
              { name: 'title', args: [], type: t('String', 'SCALAR') },
              { name: 'unused', args: [], type: t('Lonely') },
            ],
          },
          {
            kind: 'ENUM',
            name: 'TimeFilter',
            enumValues: [{ name: 'TODAY' }, { name: 'THIS_WEEKEND' }],
          },
          { kind: 'OBJECT', name: 'Unreachable', fields: [] },
          { kind: 'OBJECT', name: '__Type', fields: [] },
        ],
      },
    },
  };

  it('renders the root fields and the types reachable from them as SDL', () => {
    const sdl = summarizeSchema(answer)!;
    expect(sdl.split('\n')).toEqual([
      'query { search(query: String, time: TimeFilter): Search }',
      'type Search { events: [Event] }',
      'enum TimeFilter = TODAY | THIS_WEEKEND',
      'type Event { title: String; unused: Lonely }',
    ]);
    expect(sdl).not.toContain('Unreachable');
  });

  it('is cut to the limit, and null without a schema', () => {
    expect(summarizeSchema(answer, 70)!.split('\n')).toHaveLength(1);
    expect(
      summarizeSchema({ errors: [{ message: 'introspection off' }] })
    ).toBeNull();
    expect(summarizeSchema('nope')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { McpTool } from '@sudobility/raidr_types';
import { dateWindow } from './condense';
import { nextPageArgs, pastWindow, withLargestPage } from './paging';

const tool = (properties: Record<string, object>) =>
  ({
    name: 't',
    description: '',
    inputSchema: { type: 'object', properties },
    request: { method: 'GET', pathTemplate: '/x' },
  }) as unknown as McpTool;

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('nextPageArgs', () => {
  it('sends the cursor back, until has_more is false or it repeats', () => {
    const t = tool({
      pagination_cursor: { type: 'string' },
      pagination_limit: {},
    });
    const args = { pagination_limit: 50 };
    expect(
      nextPageArgs(t, args, {
        entries: items(50),
        has_more: true,
        next_cursor: 'c2',
      })
    ).toEqual({ pagination_limit: 50, pagination_cursor: 'c2' });
    expect(
      nextPageArgs(t, args, {
        entries: items(50),
        has_more: false,
        next_cursor: 'c2',
      })
    ).toBeNull();
    expect(
      nextPageArgs(
        t,
        { ...args, pagination_cursor: 'c2' },
        { entries: items(5), next_cursor: 'c2' }
      )
    ).toBeNull();
    // A cursor one level down (GraphQL pageInfo).
    expect(
      nextPageArgs(
        tool({ after: {} }),
        {},
        { edges: items(3), pageInfo: { endCursor: 'e', hasNextPage: true } }
      )
    ).toEqual({ after: 'e' });
  });

  it('counts pages while full or while pages remain', () => {
    const t = tool({ page: {}, pageSize: {} });
    expect(
      nextPageArgs(t, { page: 1, pageSize: 24 }, { items: items(24) })
    ).toEqual({
      page: 2,
      pageSize: 24,
    });
    expect(
      nextPageArgs(t, { page: 1, pageSize: 24 }, { items: items(10) })
    ).toBeNull();
    expect(
      nextPageArgs(t, { page: 3 }, { items: items(5), numberOfPages: 3 })
    ).toBeNull();
    expect(
      nextPageArgs(t, { page: 2 }, { items: items(5), numberOfPages: 3 })
    ).toEqual({ page: 3 });
    expect(nextPageArgs(t, { page: 1 }, { items: [] })).toBeNull();
  });

  it('advances an offset by the items received, up to the total', () => {
    const t = tool({ offset: {}, limit: {} });
    expect(
      nextPageArgs(t, { limit: 20 }, { results: items(20), total: 45 })
    ).toEqual({
      limit: 20,
      offset: 20,
    });
    expect(
      nextPageArgs(
        t,
        { limit: 20, offset: 40 },
        { results: items(5), total: 45 }
      )
    ).toBeNull();
    expect(nextPageArgs(t, { limit: 20 }, { results: items(7) })).toBeNull();
  });

  it('is null for a tool without a paging parameter', () => {
    expect(
      nextPageArgs(
        tool({ q: {} }),
        { q: 'x' },
        { items: items(50), next_cursor: 'c' }
      )
    ).toBeNull();
  });
});

describe('withLargestPage / pastWindow', () => {
  it('raises the page size to the schema maximum only', () => {
    const t = tool({ limit: { type: 'integer', maximum: 100 } });
    expect(withLargestPage(t, { limit: 20 })).toEqual({ limit: 100 });
    expect(withLargestPage(tool({ limit: {} }), { limit: 20 })).toEqual({
      limit: 20,
    });
  });

  it('is past the window when every dated item is after it', () => {
    const w = dateWindow({
      start: '2026-10-17T00:00:00-07:00',
      end: '2026-10-18T23:59:00-07:00',
    });
    const page = (d: string[]) => ({
      entries: d.map(start_at => ({ start_at })),
    });
    expect(
      pastWindow(page(['2026-10-21T01:00:00Z', '2026-10-22T01:00:00Z']), w)
    ).toBe(true);
    expect(
      pastWindow(page(['2026-10-18T20:00:00Z', '2026-10-22T01:00:00Z']), w)
    ).toBe(false);
    expect(pastWindow(page(['2026-10-21T01:00:00Z']), null)).toBe(false);
  });
});

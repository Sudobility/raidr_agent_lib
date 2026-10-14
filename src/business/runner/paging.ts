/**
 * Following a list API's pages, so a run gets the complete list for the
 * request rather than its first page.
 *
 * After a successful call the runner asks {@link nextPageArgs} for the
 * arguments of the next page. It recognises the three usual schemes from the
 * response and the tool's own parameters:
 * - a cursor (`next_cursor`, `nextPageToken`, `endCursor`…) sent back in a
 *   cursor parameter (`pagination_cursor`, `page_token`, `after`…);
 * - a page number (`page`) while the page is full or pages remain;
 * - an offset (`offset`, `start`, `skip`) advanced by the items received.
 * It stops when the response says there is no more (`has_more: false`), the
 * page is empty, or (with the request's dates) every dated item is already
 * past them ({@link pastWindow}).
 */
import type { McpTool } from '@sudobility/raidr_types';
import { type DateWindow, itemDate } from './condense';

/** Most pages followed after one planned call. */
export const MAX_AUTO_PAGES = 10;
/** Most list items collected by following pages. */
export const MAX_AUTO_ITEMS = 500;

const CURSOR_KEY =
  /^(next_?cursor|cursor|next_?page_?token|next_?token|end_?cursor|after|continuation(_?token)?)$/i;
const CURSOR_PARAM = /(cursor|page_?token|continuation|^after$)/i;
const HAS_MORE_KEY = /^(has_?more|has_?next(_?page)?|more)$/i;
const PAGE_PARAM = /^(page|page_?num(ber)?|page_?no)$/i;
const TOTAL_PAGES_KEY = /^(total_?pages|number_?of_?pages|page_?count|pages)$/i;
const OFFSET_PARAM = /^(offset|start|start_?index|skip|from)$/i;
const TOTAL_KEY = /^(total|total_?count|total_?results|count)$/i;
const LIMIT_PARAM =
  /^(limit|page_?size|per_?page|size|pagination_?limit|max_?results|rows)$/i;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The body's top-level values and those one level down (`pageInfo.endCursor`). */
function scalars(body: unknown): Array<[string, unknown]> {
  if (!isObject(body)) return [];
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(body)) {
    if (isObject(value)) {
      for (const [k, v] of Object.entries(value))
        if (!v || typeof v !== 'object') out.push([k, v]);
    } else if (!Array.isArray(value)) {
      out.push([key, value]);
    }
  }
  return out;
}

/** The body's longest list of objects (its page of items), up to 3 levels down. */
export function pageItems(body: unknown): unknown[] {
  let best: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (Array.isArray(value)) {
      if (value.length > best.length && value.some(isObject)) best = value;
      return;
    }
    if (!isObject(value) || depth > 3) return;
    for (const v of Object.values(value)) visit(v, depth + 1);
  };
  visit(body, 0);
  return best;
}

function params(tool: McpTool): Record<string, Json> {
  const schema = tool.inputSchema as { properties?: Record<string, Json> };
  return schema?.properties ?? {};
}

function findParam(tool: McpTool, re: RegExp): string | null {
  return Object.keys(params(tool)).find(name => re.test(name)) ?? null;
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * The arguments for the page after `body` (the answer to `args`), or null
 * when there is none or the tool has no parameter to ask for it.
 */
export function nextPageArgs(
  tool: McpTool,
  args: Json,
  body: unknown
): Json | null {
  const values = scalars(body);
  const hasMore = values.find(([k]) => HAS_MORE_KEY.test(k))?.[1];
  if (hasMore === false || hasMore === 'false') return null;
  const items = pageItems(body);

  const cursorParam = findParam(tool, CURSOR_PARAM);
  if (cursorParam) {
    const cursor = values.find(
      ([k, v]) => CURSOR_KEY.test(k) && typeof v === 'string' && v !== ''
    )?.[1];
    if (typeof cursor === 'string') {
      return cursor === args[cursorParam]
        ? null
        : { ...args, [cursorParam]: cursor };
    }
  }
  if (items.length === 0) return null;

  const pageParam = findParam(tool, PAGE_PARAM);
  if (pageParam) {
    const page = numberOf(args[pageParam]) ?? 1;
    const totalPages = numberOf(
      values.find(([k]) => TOTAL_PAGES_KEY.test(k))?.[1]
    );
    const limitParam = findParam(tool, LIMIT_PARAM);
    const limit = limitParam ? numberOf(args[limitParam]) : null;
    const more =
      totalPages !== null
        ? page < totalPages
        : hasMore === true || hasMore === 'true'
          ? true
          : limit !== null && items.length >= limit;
    return more ? { ...args, [pageParam]: page + 1 } : null;
  }

  const offsetParam = findParam(tool, OFFSET_PARAM);
  if (offsetParam) {
    const offset = numberOf(args[offsetParam]) ?? 0;
    const total = numberOf(values.find(([k]) => TOTAL_KEY.test(k))?.[1]);
    const next = offset + items.length;
    if (total !== null && next >= total) return null;
    if (total === null && hasMore !== true && hasMore !== 'true') {
      const limitParam = findParam(tool, LIMIT_PARAM);
      const limit = limitParam ? numberOf(args[limitParam]) : null;
      if (limit === null || items.length < limit) return null;
    }
    return { ...args, [offsetParam]: next };
  }
  return null;
}

/**
 * `args` with the tool's page size raised to its schema's `maximum`, when it
 * declares one: fewer, fuller pages.
 */
export function withLargestPage(tool: McpTool, args: Json): Json {
  const name = findParam(tool, LIMIT_PARAM);
  if (!name) return args;
  const maximum = numberOf(params(tool)[name]?.maximum);
  if (maximum === null) return args;
  const current = numberOf(args[name]);
  return current === null || current < maximum
    ? { ...args, [name]: maximum }
    : args;
}

/** Whether every dated item on this page is after the window: later pages are too. */
export function pastWindow(body: unknown, window: DateWindow | null): boolean {
  if (!window) return false;
  const dates = pageItems(body)
    .map(item => itemDate(item))
    .filter((d): d is number => d !== null);
  return dates.length > 0 && dates.every(d => d > window.end);
}

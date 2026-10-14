/**
 * A result's page on the site, built deterministically from raidr's page
 * routes and the raw response item the result came from. The model never
 * writes this URL: it only says where in which response the item is
 * (`ref: { callId, itemPath }`), and these rules do the rest.
 *
 *   a. the item = the value at `itemPath` in the call's parsed body
 *      (missing → no page URL);
 *   b. a route's `urlFields` entry for the same endpoint whose field, with
 *      the item's array prefix stripped (`entries[].event.url` against item
 *      `entries[3]` → `event.url`), is an absolute http(s) URL on the item;
 *   c. else a route whose every param has a source for the same endpoint
 *      under the same prefix with a non-empty string/number on the item:
 *      the template filled (each value `encodeURIComponent`ed);
 *   d. routes are tried strongest source first (router > code > response >
 *      visited > link), then fewest query params; all of (b) before (c);
 *      first match wins;
 *   e. the URL's host must be one of the site origins' hosts (or a
 *      subdomain of one), else it is discarded and the next one is tried;
 *   f. else a link on the item itself ({@link itemLink}): an absolute
 *      on-site URL in a link-named field, a site path (`/e/123`) resolved
 *      against the site, or a bare slug when the site's routes show pages
 *      live at `/{slug}`; the item's own fields before nested ones, never a
 *      host's, venue's or image's;
 *   g. no match → `''`.
 *
 * RN-safe: no `URL` class.
 */
import { type McpTool, parseHttpUrl } from '@sudobility/raidr_types';
import {
  type ResultSource,
  SITE_PAGE_ROUTE_SOURCES,
  type SitePageRoute,
} from '@sudobility/raidr_agent_types';

/** The endpoint key of a tool: `evidence.endpointKey`, else `METHOD /path/{template}`. */
export function toolEndpoint(tool: McpTool): string {
  return (
    tool.evidence?.endpointKey ??
    `${tool.request.method} ${tool.request.pathTemplate}`
  );
}

type Segment = { key: string } | { index: number };

/**
 * Parse a JSON path (`data.events[0].name`, `[2]`, `entries[3]`). `''` is
 * the root. Returns null for anything else (including `[]` wildcards).
 */
function parsePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  const re = /\.?([^.[\]]+)|\[(\d+)\]/gy;
  let at = 0;
  const trimmed = path.trim();
  while (at < trimmed.length) {
    re.lastIndex = at;
    const m = re.exec(trimmed);
    if (!m) return null;
    // A leading dot is not allowed; a key after an index needs the dot.
    if (m[1] !== undefined) {
      const dotted = m[0].startsWith('.');
      if (at === 0 ? dotted : !dotted) return null;
      segments.push({ key: m[1] });
    } else {
      segments.push({ index: Number(m[2]) });
    }
    at = re.lastIndex;
  }
  return segments;
}

/**
 * The value at `path` inside `body` (`entries[3].event`, `data.items[0]`,
 * `''` for the body itself); undefined when any step is missing. Only own
 * properties are followed.
 */
export function resolvePath(body: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (!segments) return undefined;
  let value: unknown = body;
  for (const segment of segments) {
    if ('index' in segment) {
      if (!Array.isArray(value) || segment.index >= value.length)
        return undefined;
      value = value[segment.index];
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
      if (!Object.prototype.hasOwnProperty.call(value, segment.key))
        return undefined;
      value = (value as Record<string, unknown>)[segment.key];
    }
  }
  return value;
}

/** `entries[3].event` → `entries[].event`: the path with every index made a wildcard. */
function pattern(path: string): string {
  return path.trim().replace(/\[\d+\]/g, '[]');
}

/**
 * A response field (`entries[].event.url`) relative to an item at
 * `itemPath` (`entries[3]` → `event.url`). Null when the field is not under
 * the item, or still crosses an array the item does not pin down.
 */
export function relativeField(field: string, itemPath: string): string | null {
  const prefix = pattern(itemPath);
  const f = field.trim();
  let rest: string;
  if (prefix === '') rest = f;
  else if (f === prefix) rest = '';
  else if (f.startsWith(`${prefix}.`)) rest = f.slice(prefix.length + 1);
  else if (f.startsWith(`${prefix}[`)) rest = f.slice(prefix.length);
  else return null;
  return rest.includes('[]') ? null : rest;
}

function hostOf(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.hasCredentials) return null;
  return parsed.host.toLowerCase();
}

/** `www.example.com` and `example.com` are the same site. */
const bare = (host: string) => host.replace(/^www\./, '');

/** True when `url` is http(s) on one of `siteOrigins`' hosts or a subdomain of one. */
export function isOnSite(url: string, siteOrigins: string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return siteOrigins.some(origin => {
    const originHost = hostOf(origin);
    if (!originHost) return false;
    const h = bare(host);
    const o = bare(originHost);
    return h === o || h.endsWith(`.${o}`);
  });
}

function sourceRank(route: SitePageRoute): number {
  const ranks = (route.sources ?? []).map(s =>
    SITE_PAGE_ROUTE_SOURCES.indexOf(s)
  );
  const known = ranks.filter(r => r >= 0);
  return known.length > 0 ? Math.min(...known) : SITE_PAGE_ROUTE_SOURCES.length;
}

/** Routes in the order they are tried (rule d). Stable. */
export function orderRoutes(routes: SitePageRoute[]): SitePageRoute[] {
  return routes
    .map((route, i) => ({ route, i }))
    .sort(
      (a, b) =>
        sourceRank(a.route) - sourceRank(b.route) ||
        (a.route.query?.length ?? 0) - (b.route.query?.length ?? 0) ||
        a.i - b.i
    )
    .map(x => x.route);
}

/** An absolute http(s) URL, trimmed, without spaces or control characters. */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u0020\u007f<>"\\]/.test(url)) return null;
  return hostOf(url) ? url : null;
}

function paramValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/**
 * The result's page on the site, or `''` (rules a–f above).
 *
 * @param routes the site's page routes ({@link SiteContext.routes})
 * @param source where the result came from: its call's endpoint key and the item's path
 * @param body the call's full parsed response body
 * @param siteOrigins the site's origins; the page must be on one of them
 */
export function buildPageUrl(
  routes: SitePageRoute[],
  source: Pick<ResultSource, 'endpoint' | 'itemPath'>,
  body: unknown,
  siteOrigins: string[]
): string {
  const item = resolvePath(body, source.itemPath);
  if (item === undefined || item === null) return '';
  return (
    routePageUrl(routes, source, body, siteOrigins) ||
    // f. a link the item carries itself
    itemLink(item, routes, siteOrigins)
  );
}

/** Rules a–e only: the page from the site's routes, or `''`. */
export function routePageUrl(
  routes: SitePageRoute[],
  source: Pick<ResultSource, 'endpoint' | 'itemPath'>,
  body: unknown,
  siteOrigins: string[]
): string {
  const item = resolvePath(body, source.itemPath);
  if (item === undefined || item === null) return '';
  const ordered = orderRoutes(routes);
  const field = (f: string): unknown => {
    const rest = relativeField(f, source.itemPath);
    return rest === null ? undefined : resolvePath(item, rest);
  };

  // b. a field on the item that holds the page's full URL
  for (const route of ordered) {
    for (const ref of route.urlFields) {
      if (ref.endpoint !== source.endpoint) continue;
      const url = cleanUrl(field(ref.field));
      if (url && isOnSite(url, siteOrigins)) return url;
    }
  }

  // c. the template filled from the item's fields
  for (const route of ordered) {
    if (route.params.length === 0) continue;
    const values = new Map<string, string>();
    for (const param of route.params) {
      for (const ref of param.sources) {
        if (ref.endpoint !== source.endpoint) continue;
        const value = paramValue(field(ref.field));
        if (value !== null) {
          values.set(param.name, value);
          break;
        }
      }
      if (!values.has(param.name)) break;
    }
    if (values.size !== route.params.length) continue;
    let unresolved = false;
    const url = route.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const value = values.get(name);
      if (value === undefined) {
        unresolved = true;
        return '';
      }
      return encodeURIComponent(value);
    });
    if (unresolved) continue;
    const clean = cleanUrl(url);
    if (clean && isOnSite(clean, siteOrigins)) return clean;
  }
  return '';
}

/** Fields that hold an item's own page: a full URL, a path or a slug. */
const LINK_FIELD =
  /^(url|permalink|link|href|web_?url|share_?url|canonical_?url|seo_?url|page_?url|full_?url|public_?url|event_?url|slug|path)$/i;
/** Nested objects that describe something else (who hosts it, where, its picture). */
const OTHER_THING =
  /^(hosts?|organi[sz]ers?|calendar|creator|owner|user|author|venue|place|location|images?|cover|photos?|media|thumbnail|avatar|brand|seller|merchant)$/i;
/** A slug: one path segment of URL-safe characters. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.~-]{2,127}$/;

/** The site's primary origin, without a trailing slash. */
function primaryOrigin(siteOrigins: string[]): string | null {
  for (const origin of siteOrigins) {
    const clean = cleanUrl(origin);
    if (clean) {
      const parsed = parseHttpUrl(clean);
      if (parsed) return `${parsed.protocol}://${parsed.host}`;
    }
  }
  return null;
}

/** Whether the site's routes put pages at `/{slug}` (Luma: `/{url}`, `/{url}/claim`). */
function slugPagesAtRoot(routes: SitePageRoute[], origin: string): boolean {
  return routes.some(route => {
    const parsed = parseHttpUrl(route.url.replace(/\{[^{}]+\}/g, 'x'));
    if (!parsed || parsed.host !== parseHttpUrl(origin)?.host) return false;
    return /^\/\{[^{}/]+\}(\/|$|\?)/.test(
      route.url.slice(route.url.indexOf(parsed.host) + parsed.host.length)
    );
  });
}

/**
 * Rule f: a page link carried by the item itself, breadth-first (its own
 * fields, then nested objects other than {@link OTHER_THING}), at most three
 * levels down: an absolute on-site URL, a path on the site, or a bare slug
 * when {@link slugPagesAtRoot}. `''` when none.
 */
export function itemLink(
  item: unknown,
  routes: SitePageRoute[],
  siteOrigins: string[]
): string {
  const origin = primaryOrigin(siteOrigins);
  let level: unknown[] = [item];
  for (let depth = 0; depth < 3 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>
      )) {
        if (value && typeof value === 'object') {
          if (!Array.isArray(value) && !OTHER_THING.test(key)) next.push(value);
          continue;
        }
        if (!LINK_FIELD.test(key) || typeof value !== 'string') continue;
        const text = value.trim();
        const absolute = cleanUrl(text);
        if (absolute) {
          if (isOnSite(absolute, siteOrigins)) return absolute;
          continue;
        }
        if (!origin) continue;
        if (text.startsWith('/') && !text.startsWith('//')) {
          const url = cleanUrl(`${origin}${text}`);
          if (url && isOnSite(url, siteOrigins)) return url;
        } else if (SLUG.test(text) && slugPagesAtRoot(routes, origin)) {
          const url = cleanUrl(`${origin}/${encodeURIComponent(text)}`);
          if (url) return url;
        }
      }
    }
    level = next;
  }
  return '';
}

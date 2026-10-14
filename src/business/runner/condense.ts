/**
 * What the models see of a site's JSON response: the whole body rarely fits,
 * and a plain cut keeps the first items and loses what matters — the paging
 * cursor at the end, and the items for the dates the user asked about.
 *
 * {@link condenseBody} keeps a response's shape and every item's position
 * (extraction refers to items by path, e.g. `entries[7]`), and:
 * - puts each object's plain values (cursors, totals, `has_more`) before its
 *   lists and objects, and drops empty values;
 * - shortens long strings;
 * - with a date window (the request's `when`), replaces list items dated
 *   outside it with `null`, and says so in a note line before the JSON
 *   ("entries: 50 items, 50 outside 2026-10-17 – 2026-10-19, latest
 *   2026-10-15: page further"), so the planner knows to page on;
 * - when it is still too long, keeps fewer items per list (and says how many
 *   more there are), then shorter strings.
 */

/** The dates a request is about, in epoch milliseconds (inclusive). */
export interface DateWindow {
  start: number;
  end: number;
}

/** Slack on each side of the window: time zones, all-day events. */
const WINDOW_SLACK_MS = 3 * 60 * 60 * 1000;

/** Keys that hold an item's date (its start). */
const DATE_KEY =
  /^(start|starts|start_?at|start_?date|start_?time|starts_?at|begins_?at|date|date_?time|event_?date|local_?date|start_?date_?time)$/i;

/** Plausible event years, so ids or counts are never read as dates. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * The window `when` asks about, widened by {@link WINDOW_SLACK_MS}; null when
 * it gives no usable start (an end alone means "until": from now).
 */
export function dateWindow(
  when: { start?: string | null; end?: string | null } | null | undefined
): DateWindow | null {
  const start = when?.start ? Date.parse(when.start) : NaN;
  if (Number.isNaN(start)) return null;
  const endParsed = when?.end ? Date.parse(when.end) : NaN;
  const end = Number.isNaN(endParsed) ? start + 24 * 60 * 60 * 1000 : endParsed;
  return { start: start - WINDOW_SLACK_MS, end: end + WINDOW_SLACK_MS };
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || value.length < 8) return null;
  if (!/\d{4}/.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const year = new Date(at).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? at : null;
}

/** An item's date: a date-named key on it, or one level down (`event.start_at`). */
export function itemDate(item: unknown, depth = 0): number | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const entries = Object.entries(item as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (DATE_KEY.test(key)) {
      const at = parseDate(value);
      if (at !== null) return at;
    }
  }
  if (depth >= 1) return null;
  for (const [, value] of entries) {
    const at = itemDate(value, depth + 1);
    if (at !== null) return at;
  }
  return null;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Pass {
  maxString: number;
  maxItems: number;
  window: DateWindow | null;
  notes: string[];
  /** Only these positions of this list are shown (the rest as null). */
  range?: { list: unknown[]; from: number; to: number };
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0)
  );
}

/** A string that is markup (several tags), not text that mentions `<`. */
const HTML_LIKE =
  /<(div|li|a|span|p|ul|ol|table|tr|td|h[1-6]|article|section|img)\b[^>]*>[\s\S]*<\/?\w+[^>]*>/i;
/** Characters of text kept from markup outside list items. */
const MAX_HTML_TEXT = 8_000;

/**
 * The readable text of markup, keeping each link as `text (href)`: the
 * entries of a server-rendered list and the paths to their pages.
 */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, inner: string) => {
        const label = inner
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return label ? ` ${label} (${href}) ` : ` (${href}) `;
      }
    )
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s*(\|\s*)+/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keys that describe how an item looks, not what it is: dropped inside list items. */
const NOISE_KEY =
  /(colou?rs?|palette|avatar|thumbnail|blurhash|social_image|tracking|analytics|checksum|_hash$|^hash$|theme|font|styles?$|seo|^meta$|i18n|locale_?strings|handle$|linkedin|twitter|instagram|facebook|tiktok|youtube|^bio|coordinate|visibility|restriction|_plan$|launch_status)/i;
/** A secondary id inside an item (`calendar_api_id`, `userId`); the item's own `id`/`api_id` stays. */
const NESTED_ID_KEY = /(_api_id|_id|Id|Ids|_ids)$/;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
/** How deep inside one list item values are shown. */
const MAX_ITEM_DEPTH = 3;
/** Entries shown of a list nested inside a list item. */
const MAX_NESTED_ITEMS = 3;

/** Whether `key: value` is presentation or bookkeeping inside a list item. */
function isItemNoise(key: string, value: unknown, itemDepth: number): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string' && HEX_COLOR.test(value)) return true;
  if (NOISE_KEY.test(key)) return true;
  if (itemDepth > 0 && NESTED_ID_KEY.test(key)) return true;
  return false;
}

function condense(
  value: unknown,
  pass: Pass,
  path: string,
  depth: number,
  /** Levels below the nearest enclosing list item; null outside lists. */
  itemDepth: number | null = null
): unknown {
  if (typeof value === 'string') {
    // Markup inside a JSON field (a server-rendered list): its text and
    // links, with room to show them when it is not one field of a list item.
    const text = HTML_LIKE.test(value) ? htmlText(value) : value;
    const max =
      text !== value && itemDepth === null
        ? Math.max(pass.maxString, MAX_HTML_TEXT)
        : pass.maxString;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  if (Array.isArray(value)) {
    if (depth > 8) return [`${value.length} items`];
    let outside = 0;
    let dated = 0;
    let latest = -Infinity;
    const kept: unknown[] = [];
    let shown = 0;
    let more = 0;
    const range = pass.range?.list === value ? pass.range : null;
    for (const [i, item] of value.entries()) {
      if (range && (i < range.from || i >= range.to)) {
        if (i >= range.to) break;
        kept.push(null);
        continue;
      }
      if (pass.window && item && typeof item === 'object') {
        const at = itemDate(item);
        if (at !== null) {
          dated++;
          latest = Math.max(latest, at);
          if (at < pass.window.start || at > pass.window.end) {
            outside++;
            kept.push(null);
            continue;
          }
        }
      }
      // A list item that is itself an array (a tuple: Craigslist's
      // [id, …, price, title]) keeps every field; lists inside an item are
      // cut to a few entries.
      const cap =
        itemDepth !== null && itemDepth > 0
          ? Math.min(pass.maxItems, MAX_NESTED_ITEMS)
          : pass.maxItems;
      if (shown >= cap) {
        more = value.length - i;
        break;
      }
      shown++;
      // A list's items start a new item; a list inside an item goes deeper.
      kept.push(
        condense(
          item,
          pass,
          `${path}[${i}]`,
          depth + 1,
          itemDepth === null ? 0 : itemDepth + 1
        )
      );
    }
    if (range && range.from > 0)
      pass.notes.push(
        `${path || 'body'}: items ${range.from}–${Math.min(range.to, value.length) - 1} of ${value.length} (earlier ones in another excerpt).`
      );
    if (outside > 0 && pass.window) {
      const page =
        latest < pass.window.start
          ? `latest ${isoDay(latest)}: page further for later items`
          : `latest ${isoDay(latest)}`;
      pass.notes.push(
        `${path || 'body'}: ${value.length} items, ${outside} of ${dated} dated outside ${isoDay(pass.window.start + WINDOW_SLACK_MS)} – ${isoDay(pass.window.end - WINDOW_SLACK_MS)} (shown as null), ${page}.`
      );
    }
    if (more > 0 && itemDepth === null)
      pass.notes.push(
        `${path || 'body'}: ${more} more items not shown (of ${value.length}).`
      );
    // Trailing nulls say nothing; leading and inner ones keep positions.
    while (kept.length > 0 && kept[kept.length - 1] === null) kept.pop();
    return kept;
  }
  if (value && typeof value === 'object') {
    if (depth > 8) return '{…}';
    const plain: Array<[string, unknown]> = [];
    const nested: Array<[string, unknown]> = [];
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isEmpty(v)) continue;
      if (itemDepth !== null) {
        if (isItemNoise(key, v, itemDepth)) continue;
        if (itemDepth >= MAX_ITEM_DEPTH && typeof v === 'object') continue;
      }
      (v !== null && typeof v === 'object' ? nested : plain).push([key, v]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of [...plain, ...nested]) {
      const child = condense(
        v,
        pass,
        path ? `${path}.${key}` : key,
        depth + 1,
        itemDepth === null ? null : itemDepth + 1
      );
      if (!isEmpty(child)) out[key] = child;
    }
    return out;
  }
  return value;
}

/** String lengths tried, longest first; at each, as many list items as fit. */
const STRING_STEPS = [200, 120, 60];
/** Fewer items than this at a string length: try shorter strings for more. */
const ENOUGH_ITEMS = 12;
/** The list cap with no limit (long enough for any page). */
const ALL_ITEMS = 1_000;

function render(
  body: unknown,
  maxString: number,
  maxItems: number,
  window: DateWindow | null,
  range?: Pass['range']
): string {
  const pass: Pass = {
    maxString,
    maxItems,
    window,
    notes: [],
    ...(range ? { range } : {}),
  };
  const json = JSON.stringify(condense(body, pass, '', 0));
  return pass.notes.length > 0 ? `NOTE ${pass.notes.join(' ')}\n${json}` : json;
}

/**
 * The body as at most `max` characters for a model: notes (if any) on the
 * first line, then the condensed JSON. Item positions are unchanged. At each
 * string length the most list items that fit are kept (binary search); the
 * first length that shows every item, or {@link ENOUGH_ITEMS}, wins.
 */
export function condenseBody(
  body: unknown,
  max: number,
  window: DateWindow | null = null
): string {
  let best: { text: string; items: number } | null = null;
  for (const maxString of STRING_STEPS) {
    const all = render(body, maxString, ALL_ITEMS, window);
    if (all.length <= max) return all;
    let lo = 0;
    let hi = ALL_ITEMS;
    let fit: string | null = null;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const text = render(body, maxString, mid, window);
      if (text.length <= max) {
        lo = mid;
        fit = text;
      } else {
        hi = mid - 1;
      }
    }
    if (fit !== null && (!best || lo > best.items))
      best = { text: fit, items: lo };
    if (best && best.items >= ENOUGH_ITEMS) return best.text;
  }
  return best?.text ?? render(body, 40, 1, window).slice(0, max);
}

/** Most excerpts one response is split into. */
export const MAX_CHUNKS = 12;

/** The body's longest list (its items), the one split across excerpts. */
function longestList(body: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const visit = (value: unknown, depth: number) => {
    if (Array.isArray(value)) {
      if (!best || value.length > best.length) best = value;
      return;
    }
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const v of Object.values(value)) visit(v, depth + 1);
  };
  visit(body, 0);
  return best;
}

/**
 * The body as excerpts of at most `max` characters that together show every
 * item of its longest list (each excerpt a slice of it, other positions as
 * null, so paths stay valid), for extraction to see the whole page. A body
 * that fits is one excerpt; at most {@link MAX_CHUNKS}.
 */
export function condenseChunks(
  body: unknown,
  max: number,
  window: DateWindow | null = null
): string[] {
  const whole = render(body, STRING_STEPS[0] ?? 200, ALL_ITEMS, window);
  const list = longestList(body);
  if (whole.length <= max || !list || list.length < 2) {
    return [whole.length <= max ? whole : condenseBody(body, max, window)];
  }
  for (const maxString of STRING_STEPS) {
    const chunks: string[] = [];
    let from = 0;
    let stuck = false;
    while (from < list.length && chunks.length < MAX_CHUNKS) {
      // The most items from `from` that fit (binary search on the end).
      let lo = from;
      let hi = list.length;
      let fit: string | null = null;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const text = render(body, maxString, ALL_ITEMS, window, {
          list,
          from,
          to: mid,
        });
        if (text.length <= max) {
          lo = mid;
          fit = text;
        } else {
          hi = mid - 1;
        }
      }
      if (fit === null) {
        stuck = true;
        break;
      }
      chunks.push(fit);
      from = lo;
    }
    if (!stuck) return chunks;
  }
  return [condenseBody(body, max, window)];
}

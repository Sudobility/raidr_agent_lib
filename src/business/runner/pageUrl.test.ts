import { describe, expect, it } from 'vitest';
import type { McpTool } from '@sudobility/raidr_types';
import type { SitePageRoute } from '@sudobility/raidr_agent_types';
import {
  buildPageUrl,
  isOnSite,
  itemLink,
  routePageUrl,
  orderRoutes,
  relativeField,
  resolvePath,
  toolEndpoint,
} from './index';

const EP = 'GET /discover/events';
const origins = ['https://luma.com'];

const body = {
  entries: [
    { event: { url: 'https://luma.com/abc', api_id: 'evt-1', slug: 'abc' } },
    { event: { url: '', api_id: 'evt-2', slug: 'a b/c' } },
    { event: { url: 'https://evil.example/x', api_id: 'evt-3', slug: 'x' } },
    { event: { api_id: 42, slug: '' } },
  ],
  meta: { share_url: 'https://luma.com/discover' },
};

const route = (over: Partial<SitePageRoute>): SitePageRoute => ({
  url: 'https://luma.com/{slug}',
  params: [],
  urlFields: [],
  ...over,
});

describe('resolvePath', () => {
  it('follows keys and indices', () => {
    expect(resolvePath(body, '')).toBe(body);
    expect(resolvePath(body, 'entries[0].event.slug')).toBe('abc');
    expect(resolvePath(body, 'entries[3].event.api_id')).toBe(42);
    expect(resolvePath([1, [2, 3]], '[1][0]')).toBe(2);
    expect(resolvePath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c')).toBe(1);
  });

  it('is undefined for missing or malformed paths', () => {
    expect(resolvePath(body, 'entries[9]')).toBeUndefined();
    expect(resolvePath(body, 'entries.0')).toBeUndefined();
    expect(resolvePath(body, 'entries[]')).toBeUndefined();
    expect(resolvePath(body, '.entries')).toBeUndefined();
    expect(resolvePath(body, 'entries[0]event')).toBeUndefined();
    expect(resolvePath(body, 'nope.x')).toBeUndefined();
    expect(resolvePath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(resolvePath('text', '[0]')).toBeUndefined();
  });

  it('only follows own properties', () => {
    expect(resolvePath({}, 'constructor')).toBeUndefined();
    expect(resolvePath({}, '__proto__')).toBeUndefined();
    expect(resolvePath({ a: {} }, 'a.toString')).toBeUndefined();
  });
});

describe('relativeField', () => {
  it('strips the item array prefix', () => {
    expect(relativeField('entries[].event.url', 'entries[3]')).toBe(
      'event.url'
    );
    expect(relativeField('data.events[].url', 'data.events[0]')).toBe('url');
    expect(relativeField('entries[].event.url', 'entries[3].event')).toBe(
      'url'
    );
    expect(relativeField('event.url', '')).toBe('event.url');
    expect(relativeField('entries[]', 'entries[2]')).toBe('');
    expect(relativeField('rows[][1]', 'rows[0]')).toBe('[1]');
  });

  it('refuses fields outside the item or across another array', () => {
    expect(relativeField('meta.share_url', 'entries[3]')).toBeNull();
    expect(relativeField('entries[].tags[].url', 'entries[3]')).toBeNull();
    expect(relativeField('entries[].event.url', '')).toBeNull();
    expect(relativeField('entriesX[].url', 'entries[1]')).toBeNull();
  });
});

describe('isOnSite', () => {
  it('accepts the origin host, www and subdomains only', () => {
    expect(isOnSite('https://luma.com/x', origins)).toBe(true);
    expect(isOnSite('https://www.luma.com/x', origins)).toBe(true);
    expect(isOnSite('https://lu.ma.luma.com/x', origins)).toBe(true);
    expect(isOnSite('https://notluma.com/x', origins)).toBe(false);
    expect(isOnSite('https://luma.com.evil.example/x', origins)).toBe(false);
    expect(isOnSite('javascript:alert(1)', origins)).toBe(false);
    expect(isOnSite('https://u:p@luma.com/', origins)).toBe(false);
    expect(isOnSite('https://luma.com/', [])).toBe(false);
  });
});

describe('orderRoutes', () => {
  it('orders by strongest source, then fewer query params, else stable', () => {
    const a = route({ url: 'a', sources: ['link'] });
    const b = route({ url: 'b', sources: ['visited', 'router'] });
    const c = route({ url: 'c', sources: ['router'], query: ['x', 'y'] });
    const d = route({ url: 'd' });
    const e = route({ url: 'e', sources: ['router'], query: [] });
    expect(orderRoutes([a, b, c, d, e]).map(r => r.url)).toEqual([
      'b',
      'e',
      'c',
      'a',
      'd',
    ]);
  });
});

describe('buildPageUrl', () => {
  const urlRoute = route({
    url: 'https://luma.com/{slug}',
    params: [{ name: 'slug', sources: [] }],
    urlFields: [{ endpoint: EP, field: 'entries[].event.url' }],
  });
  const slugRoute = route({
    url: 'https://luma.com/{slug}',
    params: [
      {
        name: 'slug',
        sources: [{ endpoint: EP, field: 'entries[].event.slug' }],
      },
    ],
  });

  it('a. no item, no page', () => {
    expect(
      buildPageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'entries[9]' },
        body,
        origins
      )
    ).toBe('');
    expect(
      buildPageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'bad[' },
        body,
        origins
      )
    ).toBe('');
  });

  it('b. uses a urlFields value on the item (array prefix stripped)', () => {
    expect(
      buildPageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('https://luma.com/abc');
    // The item is the nested event: the field is relative to it.
    expect(
      buildPageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'entries[0].event' },
        body,
        origins
      )
    ).toBe('https://luma.com/abc');
  });

  it('b. only for the same endpoint', () => {
    expect(
      routePageUrl(
        [urlRoute],
        { endpoint: 'GET /other', itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('');
  });

  it('b. an empty or relative url field falls through to the template', () => {
    expect(
      buildPageUrl(
        [urlRoute, slugRoute],
        { endpoint: EP, itemPath: 'entries[1]' },
        body,
        origins
      )
    ).toBe('https://luma.com/a%20b%2Fc');
  });

  it('b. prefers urlFields over a template even on a weaker route', () => {
    const strongTemplate = {
      ...slugRoute,
      url: 'https://luma.com/e/{slug}',
      sources: ['router' as const],
    };
    const weakUrl = { ...urlRoute, sources: ['link' as const] };
    expect(
      buildPageUrl(
        [strongTemplate, weakUrl],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('https://luma.com/abc');
  });

  it('e. a url field on another host is discarded (and the template used)', () => {
    expect(
      buildPageUrl(
        [urlRoute, slugRoute],
        { endpoint: EP, itemPath: 'entries[2]' },
        body,
        origins
      )
    ).toBe('https://luma.com/x');
    expect(
      buildPageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'entries[2]' },
        body,
        origins
      )
    ).toBe('');
  });

  it('c. fills every param from the item, numbers too', () => {
    const idRoute = route({
      url: 'https://luma.com/event/{id}',
      params: [
        {
          name: 'id',
          sources: [{ endpoint: EP, field: 'entries[].event.api_id' }],
        },
      ],
    });
    expect(
      buildPageUrl(
        [idRoute],
        { endpoint: EP, itemPath: 'entries[3]' },
        body,
        origins
      )
    ).toBe('https://luma.com/event/42');
  });

  it('c. a missing or empty param skips the route', () => {
    expect(
      routePageUrl(
        [slugRoute],
        { endpoint: EP, itemPath: 'entries[3]' },
        body,
        origins
      )
    ).toBe('');
    const twoParams = route({
      url: 'https://luma.com/{slug}/{missing}',
      params: [
        {
          name: 'slug',
          sources: [{ endpoint: EP, field: 'entries[].event.slug' }],
        },
        {
          name: 'missing',
          sources: [{ endpoint: EP, field: 'entries[].event.nope' }],
        },
      ],
    });
    expect(
      routePageUrl(
        [twoParams],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('');
  });

  it('c. a template placeholder without a param is unresolved', () => {
    const extra = route({
      url: 'https://luma.com/{slug}/{other}',
      params: [
        {
          name: 'slug',
          sources: [{ endpoint: EP, field: 'entries[].event.slug' }],
        },
      ],
    });
    expect(
      routePageUrl(
        [extra],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('');
  });

  it('c. a route without params never matches (it is not about the item)', () => {
    const home = route({ url: 'https://luma.com/', params: [] });
    expect(
      routePageUrl(
        [home],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('');
  });

  it("c. tries a param's sources in order and takes the first that resolves", () => {
    const r = route({
      url: 'https://luma.com/{slug}',
      params: [
        {
          name: 'slug',
          sources: [
            { endpoint: 'GET /else', field: 'entries[].event.slug' },
            { endpoint: EP, field: 'entries[].event.nope' },
            { endpoint: EP, field: 'entries[].event.api_id' },
          ],
        },
      ],
    });
    expect(
      buildPageUrl([r], { endpoint: EP, itemPath: 'entries[0]' }, body, origins)
    ).toBe('https://luma.com/evt-1');
  });

  it('d. prefers the stronger source, then fewer query params', () => {
    const viaLink = {
      ...slugRoute,
      url: 'https://luma.com/l/{slug}',
      sources: ['link' as const],
    };
    const viaRouter = {
      ...slugRoute,
      url: 'https://luma.com/r/{slug}',
      sources: ['router' as const],
    };
    expect(
      buildPageUrl(
        [viaLink, viaRouter],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('https://luma.com/r/abc');
    const withQuery = {
      ...viaRouter,
      url: 'https://luma.com/q/{slug}',
      query: ['ref'],
    };
    expect(
      buildPageUrl(
        [withQuery, viaRouter],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('https://luma.com/r/abc');
  });

  it('e. a template on another host is discarded', () => {
    const off = route({
      url: 'https://evil.example/{slug}',
      params: [
        {
          name: 'slug',
          sources: [{ endpoint: EP, field: 'entries[].event.slug' }],
        },
      ],
    });
    expect(
      routePageUrl(
        [off],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('');
    expect(
      routePageUrl(
        [off, slugRoute],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        origins
      )
    ).toBe('https://luma.com/abc');
  });

  it('works on a whole-body item', () => {
    const single = { event: { url: 'https://luma.com/one', slug: 'one' } };
    const r = route({
      urlFields: [{ endpoint: 'GET /event/{id}', field: 'event.url' }],
    });
    expect(
      buildPageUrl(
        [r],
        { endpoint: 'GET /event/{id}', itemPath: '' },
        single,
        origins
      )
    ).toBe('https://luma.com/one');
  });

  it('f. nothing matches → empty', () => {
    expect(
      routePageUrl([], { endpoint: EP, itemPath: 'entries[0]' }, body, origins)
    ).toBe('');
    expect(
      routePageUrl(
        [urlRoute],
        { endpoint: EP, itemPath: 'entries[0]' },
        body,
        []
      )
    ).toBe('');
  });
});

describe('toolEndpoint', () => {
  it('uses the evidence key, else method and path', () => {
    const t = {
      name: 't',
      description: '',
      inputSchema: { type: 'object' },
      request: { method: 'GET', pathTemplate: '/a/{id}' },
    } as McpTool;
    expect(toolEndpoint(t)).toBe('GET /a/{id}');
    expect(
      toolEndpoint({
        ...t,
        evidence: { endpointKey: 'GET /api/a/{id}', calls: 1 },
      })
    ).toBe('GET /api/a/{id}');
  });
});

describe('itemLink (rule f)', () => {
  const luma = ['https://luma.com'];
  const slugRoute = {
    url: 'https://luma.com/{url}/claim',
    params: [{ name: 'url', sources: [] }],
    urlFields: [],
  } as unknown as SitePageRoute;

  it('finds an absolute on-site URL before nested ones, never a host’s', () => {
    expect(
      itemLink(
        {
          hosts: [{ url: 'https://luma.com/user/someone' }],
          calendar: { url: 'https://luma.com/cal' },
          event: { name: 'X', permalink: 'https://www.luma.com/e/abc' },
        },
        [],
        luma
      )
    ).toBe('https://www.luma.com/e/abc');
    expect(itemLink({ url: 'https://elsewhere.com/x' }, [], luma)).toBe('');
  });

  it('resolves a site path, and a slug only when pages live at /{slug}', () => {
    expect(itemLink({ path: '/events/42' }, [], luma)).toBe(
      'https://luma.com/events/42'
    );
    expect(itemLink({ event: { url: 'a1xuboaj' } }, [slugRoute], luma)).toBe(
      'https://luma.com/a1xuboaj'
    );
    expect(itemLink({ event: { url: 'a1xuboaj' } }, [], luma)).toBe('');
    expect(itemLink({ url: 'not a slug' }, [slugRoute], luma)).toBe('');
  });

  it('is what buildPageUrl falls back to when no route matches', () => {
    const body = { entries: [{ event: { url: 'a1xuboaj' } }] };
    expect(
      buildPageUrl(
        [slugRoute],
        { endpoint: 'GET /x', itemPath: 'entries[0]' },
        body,
        luma
      )
    ).toBe('https://luma.com/a1xuboaj');
  });
});

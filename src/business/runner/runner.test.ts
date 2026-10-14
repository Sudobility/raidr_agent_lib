import { describe, expect, it } from 'vitest';
import type { McpManifest, McpTool } from '@sudobility/raidr_types';
import type { AgentStep, RunRequest } from '@sudobility/raidr_agent_types';
import {
  isBotChallenge,
  type AiTransport,
  MAX_TOOLS,
  rankTools,
  runSites,
  safeUrl,
  type SiteCatalog,
  type SiteConnector,
  parseCallBody,
  toAgentIntent,
  randomId,
} from './index';

const tool = (name: string, method = 'GET', description = ''): McpTool =>
  ({
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    request: { method, pathTemplate: `/${name}` },
  }) as McpTool;

const manifest = {
  apiHost: 'api.recipes.example',
  title: 'Recipes Example',
  description: 'Recipes',
  siteOrigins: ['https://recipes.example'],
  auth: { style: 'bearer' },
  tools: [
    tool('search_recipes', 'GET', 'Search recipes'),
    tool('get_recipe'),
    tool('delete_account', 'DELETE'),
  ],
} as unknown as McpManifest;

const input: RunRequest = {
  request: 'Give me a recipe for pad thai',
  intent: {
    location_needed: false,
    intent: 'recipe',
    labels: ['recipes'],
    slots: [],
    resultKind: 'recipe',
    query: 'pad thai',
    what: 'find a recipe',
    who: null,
    how: null,
    when: null,
    where: null,
    why: null,
    selection: 'all',
  },
  sites: [{ apiHost: 'api.recipes.example', token: 'secret-site-token' }],
};

/** Scripted AI: plan answers in order, then extraction. */
function ai(
  plans: unknown[],
  items: unknown[] = []
): AiTransport & {
  seen: Array<{ step: AgentStep; input: Record<string, unknown> }>;
} {
  const seen: Array<{ step: AgentStep; input: Record<string, unknown> }> = [];
  return {
    seen,
    async invoke(step, payload) {
      seen.push({ step, input: payload });
      if (step === 'plan') return plans.shift() ?? { done: true, calls: [] };
      return { items };
    },
  };
}

const catalog: SiteCatalog = { manifest: async () => manifest };

function sites(
  answer: (
    tool: string,
    args: Record<string, unknown>
  ) => { ok: boolean; httpStatus?: number; text: string }
) {
  const opened: Array<string | undefined> = [];
  const connector: SiteConnector = {
    async open(_host, token) {
      opened.push(token);
      return {
        callTool: async (name, args) => answer(name, args),
        close: async () => undefined,
      };
    },
  };
  return { connector, opened };
}

function collector() {
  const parts: Array<{ type: string; id?: string; data: any }> = [];
  return { parts, writer: { write: (p: any) => void parts.push(p) } };
}

describe('rankTools', () => {
  it('puts reads and matching tools first and caps the list', () => {
    const tools = [
      tool('delete_account', 'DELETE'),
      tool('list_orders'),
      tool('search_recipes', 'GET', 'Search recipes by name'),
    ];
    expect(
      rankTools(tools, 'recipe for pad thai recipes').map(t => t.name)[0]
    ).toBe('search_recipes');
    expect(
      rankTools(
        Array.from({ length: 60 }, (_, i) => tool(`t${i}`)),
        'x'
      )
    ).toHaveLength(MAX_TOOLS);
  });
});

describe('runSites', () => {
  it('loops plan → calls → extract and streams status, calls and results', async () => {
    const model = ai(
      [
        {
          done: false,
          calls: [
            {
              tool: 'search_recipes',
              arguments: '{"q":"pad thai"}',
              reason: 'find',
            },
          ],
        },
        {
          done: false,
          calls: [
            { tool: 'get_recipe', arguments: '{"id":"9"}', reason: 'detail' },
          ],
        },
        { done: true, calls: [] },
      ],
      [
        {
          title: 'Easy Pad Thai',
          summary: 'Quick',
          imageUrl: 'javascript:alert(1)',
          sourceUrl: 'https://recipes.example/9',
          recipe: {
            ingredients: ['noodles'],
            steps: ['cook'],
            totalMinutes: 30,
            servings: 2,
          },
          fields: [],
        },
      ]
    );
    const { connector, opened } = sites(name => ({
      ok: true,
      httpStatus: 200,
      text:
        name === 'search_recipes' ? '[{"id":"9"}]' : '{"name":"Easy Pad Thai"}',
    }));
    const { parts, writer } = collector();
    const calls: unknown[] = [];
    let n = 0;
    const outcome = await runSites(
      input,
      writer,
      { ai: model, catalog, connector, newId: () => `id-${++n}` },
      { onCall: c => void calls.push(c) }
    );

    expect(outcome.sites).toEqual([
      { apiHost: 'api.recipes.example', status: 'done', error: null },
    ]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      id: 'api.recipes.example:0',
      siteTitle: 'Recipes Example',
      imageUrl: '',
      sourceUrl: 'https://recipes.example/9',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ callId: 'id-1', status: 'ok' });
    // The token reaches the connector and nothing else.
    expect(opened).toEqual(['secret-site-token']);
    expect(JSON.stringify(parts)).not.toContain('secret-site-token');
    expect(JSON.stringify(model.seen)).not.toContain('secret-site-token');
    // The second plan sees the first call's excerpt.
    expect((model.seen[1]!.input.history as unknown[]).length).toBe(1);
    const statuses = parts
      .filter(p => p.type === 'data-site-status')
      .map(p => p.data.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses.at(-1)).toBe('done');
    expect(parts.filter(p => p.type === 'data-result')).toHaveLength(1);
  });

  it('stops after maxSteps, and skips unknown tools and bad arguments', async () => {
    const round = (page: number) => ({
      done: false,
      calls: [
        { tool: 'search_recipes', arguments: JSON.stringify({ page }) },
        { tool: 'nope', arguments: JSON.stringify({ page }) },
        { tool: 'get_recipe', arguments: 'not json' },
      ],
    });
    const model = ai([1, 2, 3, 4, 5, 6].map(round));
    let n = 0;
    const { connector } = sites(
      () => (n++, { ok: true, httpStatus: 200, text: '[]' })
    );
    const { writer } = collector();
    await runSites(
      input,
      writer,
      { ai: model, catalog, connector },
      { maxSteps: 2 }
    );
    expect(model.seen.filter(s => s.step === 'plan')).toHaveLength(2);
    expect(n).toBe(2);
  });

  it('skips a call already made, and stops when a round only repeats', async () => {
    const search = (args: object) => ({
      tool: 'search_recipes',
      arguments: JSON.stringify(args),
    });
    const model = ai([
      { done: false, calls: [search({ q: 'pad thai', limit: 10 })] },
      {
        done: false,
        // Same arguments in another key order, plus one new call.
        calls: [search({ limit: 10, q: 'pad thai' }), search({ q: 'noodles' })],
      },
      { done: false, calls: [search({ q: 'noodles' })] },
      { done: false, calls: [search({ q: 'never reached' })] },
    ]);
    const made: unknown[] = [];
    const { connector } = sites(
      (_tool, args) => (
        made.push(args),
        { ok: true, httpStatus: 200, text: '[]' }
      )
    );
    const { writer } = collector();
    await runSites(input, writer, { ai: model, catalog, connector });
    expect(made).toEqual([{ q: 'pad thai', limit: 10 }, { q: 'noodles' }]);
    expect(model.seen.filter(s => s.step === 'plan')).toHaveLength(3);
  });

  it('gives extraction the intent details and the form inputs', async () => {
    const model = ai([
      { done: false, calls: [{ tool: 'search_recipes', arguments: '{}' }] },
    ]);
    const { connector } = sites(() => ({
      ok: true,
      httpStatus: 200,
      text: '[]',
    }));
    const { writer } = collector();
    const when = { text: 'tonight', start: '2026-10-08T18:00:00-07:00' };
    await runSites(
      {
        ...input,
        intent: { ...input.intent, when, how: 'vegan' },
        inputs: { keyword: 'pad thai' },
      },
      writer,
      { ai: model, catalog, connector }
    );
    const extract = model.seen.find(s => s.step === 'extract')!.input;
    expect(extract).toMatchObject({
      query: 'pad thai',
      what: 'find a recipe',
      how: 'vegan',
      when,
      where: null,
      inputs: { keyword: 'pad thai' },
    });
  });

  it('stops planning once the signal is aborted', async () => {
    const signal = { aborted: true };
    const model = ai([]);
    const { connector } = sites(() => ({ ok: true, text: '' }));
    const { writer } = collector();
    const outcome = await runSites(
      input,
      writer,
      { ai: model, catalog, connector },
      { signal }
    );
    expect(model.seen).toHaveLength(0);
    expect(outcome.sites[0]).toMatchObject({ status: 'done' });
  });

  it('a site whose calls all fail is reported failed, without results or an extraction', async () => {
    const model = ai([
      { done: false, calls: [{ tool: 'search_recipes', arguments: '{}' }] },
    ]);
    const { connector } = sites(() => ({
      ok: false,
      httpStatus: 401,
      text: 'unauthorized',
    }));
    const { writer } = collector();
    const outcome = await runSites(input, writer, {
      ai: model,
      catalog,
      connector,
    });
    expect(outcome.sites[0]).toMatchObject({ status: 'failed' });
    expect(model.seen.some(s => s.step === 'extract')).toBe(false);
  });

  it('an error loading a site fails that site only', async () => {
    const { connector } = sites(() => ({ ok: true, text: '' }));
    const { writer } = collector();
    const outcome = await runSites(
      {
        ...input,
        sites: [{ apiHost: 'x' }, { apiHost: 'api.recipes.example' }],
      },
      writer,
      {
        ai: ai([]),
        catalog: {
          manifest: async (h: string) => {
            if (h === 'x') throw new Error('raidr /mcps/x: MCP not found');
            return manifest;
          },
        },
        connector,
      }
    );
    expect(outcome.sites.find(s => s.apiHost === 'x')).toMatchObject({
      status: 'failed',
      error: 'raidr /mcps/x: MCP not found',
    });
    expect(
      outcome.sites.find(s => s.apiHost === 'api.recipes.example')
    ).toMatchObject({ status: 'done' });
  });
});

describe('safeUrl', () => {
  it('keeps http(s) URLs only', () => {
    expect(safeUrl(' https://a.example/x y ')).toBe('https://a.example/x%20y');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('/relative')).toBe('');
    expect(safeUrl('https://u:p@a.example/')).toBe('');
    expect(safeUrl('https://a.example/"><script>')).toBe('');
  });
});

describe('toAgentIntent', () => {
  it('normalises labels, kind and query', () => {
    expect(
      toAgentIntent(
        {
          location_needed: false,
          intent: 'recipe',
          labels: ['Recipes ', 'not a label!'],
          resultKind: 'spaceship',
        },
        'pad thai'
      )
    ).toEqual({
      location_needed: false,
      intent: 'recipe',
      labels: ['recipes'],
      slots: [],
      resultKind: 'generic',
      query: 'pad thai',
      what: 'recipe',
      who: null,
      how: null,
      when: null,
      where: null,
      why: null,
      selection: 'all',
    });
    expect(() => toAgentIntent({ labels: [] }, 'r')).toThrow();
    expect(() => toAgentIntent('nope', 'r')).toThrow();
  });
});

describe('randomId', () => {
  it('makes v4 UUIDs', () => {
    expect(randomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe('runSites (v2: context, prepared tools, inputs, page URLs, best)', () => {
  const eventTool = (name: string, path: string, endpointKey?: string) =>
    ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      request: { method: 'GET', pathTemplate: path },
      ...(endpointKey ? { evidence: { endpointKey, calls: 1 } } : {}),
    }) as McpTool;

  const context = {
    manifest: {
      apiHost: 'api.lu.ma',
      title: 'Luma',
      description: 'Events',
      siteOrigins: ['https://luma.com'],
      auth: { style: 'bearer' },
      tools: [
        eventTool('list_categories', '/categories'),
        eventTool(
          'discover_events',
          '/discover',
          'GET /discover/bootstrap-page'
        ),
      ],
    } as unknown as McpManifest,
    toolAuth: {},
    routes: [
      {
        url: 'https://luma.com/{slug}',
        params: [
          {
            name: 'slug',
            sources: [
              {
                endpoint: 'GET /discover/bootstrap-page',
                field: 'entries[].event.url',
              },
            ],
          },
        ],
        urlFields: [],
        sources: ['router' as const],
      },
    ],
  };

  const body = {
    entries: [
      { event: { name: 'Jazz night', url: 'jazz-night' } },
      { event: { name: 'Rust meetup', url: 'rust-sf' } },
    ],
  };

  it("puts prepared tools first, passes inputs and W's, builds page URLs, picks the best", async () => {
    const seen: Array<{ step: AgentStep; input: Record<string, unknown> }> = [];
    let planned = false;
    const model: AiTransport = {
      async invoke(step, payload) {
        seen.push({ step, input: payload });
        if (step === 'plan') {
          if (planned) return { done: true, calls: [] };
          planned = true;
          return {
            done: false,
            calls: [
              { tool: 'discover_events', arguments: '{"category":"music"}' },
            ],
          };
        }
        if (step === 'extract')
          return {
            items: [
              {
                title: 'Jazz night',
                summary: 's',
                ref: { callId: 'c1', itemPath: 'entries[0]' },
              },
              {
                title: 'Rust meetup',
                summary: 's',
                ref: { callId: 'c1', itemPath: 'entries[1].event' },
              },
              {
                title: 'Ghost',
                summary: 's',
                ref: { callId: 'c9', itemPath: 'entries[0]' },
              },
              {
                title: 'Missing',
                summary: 's',
                ref: { callId: 'c1', itemPath: 'entries[7]' },
              },
            ],
          };
        if (step === 'pick-best')
          return { bestId: 'api.lu.ma:1', reason: 'Closest' };
        throw new Error(`unexpected ${step}`);
      },
    };
    const { parts, writer } = collector();
    const outcome = await runSites(
      {
        request: 'events tonight',
        intent: {
          ...input.intent,
          selection: 'best',
          when: { text: 'tonight' },
        },
        sites: [{ apiHost: 'api.lu.ma', tools: ['discover_events', 'nope'] }],
        inputs: { category: 'music' },
      },
      writer,
      {
        ai: model,
        catalog: { context: async () => context },
        connector: {
          open: async () => ({
            // Hosted-MCP style text: a status line, then pretty JSON.
            callTool: async () => ({
              ok: true,
              httpStatus: 200,
              text: `HTTP 200\n${JSON.stringify(body, null, 2)}`,
            }),
            close: async () => undefined,
          }),
        },
        newId: () => 'call-1',
      }
    );

    const plan = seen.find(s => s.step === 'plan')!.input;
    expect((plan.tools as Array<{ name: string }>)[0]!.name).toBe(
      'discover_events'
    );
    expect(plan.preferredTools).toEqual(['discover_events']);
    expect(plan.inputs).toEqual({ category: 'music' });
    expect(plan.when).toEqual({ text: 'tonight' });
    expect(plan.what).toBe('find a recipe');

    const extract = seen.find(s => s.step === 'extract')!.input;
    expect(extract.responses).toEqual([
      {
        callId: 'c1',
        tool: 'discover_events',
        endpoint: 'GET /discover/bootstrap-page',
        excerpt: JSON.stringify(body),
      },
    ]);

    expect(outcome.results.map(r => [r.title, r.pageUrl])).toEqual([
      ['Jazz night', 'https://luma.com/jazz-night'],
      ['Rust meetup', 'https://luma.com/rust-sf'],
      ['Ghost', ''],
      ['Missing', ''],
    ]);
    expect(outcome.results[0]!.source).toEqual({
      callId: 'call-1',
      tool: 'discover_events',
      endpoint: 'GET /discover/bootstrap-page',
      itemPath: 'entries[0]',
    });
    expect(outcome.results[2]!.source).toBeUndefined();
    expect(outcome.best).toEqual({
      resultId: 'api.lu.ma:1',
      reason: 'Closest',
    });
    expect(parts.filter(p => p.type === 'data-best')).toEqual([
      {
        type: 'data-best',
        id: 'best',
        data: { resultId: 'api.lu.ma:1', reason: 'Closest' },
      },
    ]);
  });

  it('an `all` run picks no best', async () => {
    const model = ai(
      [{ done: false, calls: [{ tool: 'search_recipes', arguments: '{}' }] }],
      [
        { title: 'A', summary: '' },
        { title: 'B', summary: '' },
      ]
    );
    const { connector } = sites(() => ({
      ok: true,
      httpStatus: 200,
      text: '[]',
    }));
    const { parts, writer } = collector();
    const outcome = await runSites(input, writer, {
      ai: model,
      catalog,
      connector,
    });
    expect(outcome.results).toHaveLength(2);
    expect(outcome.best).toBeNull();
    expect(parts.some(p => p.type === 'data-best')).toBe(false);
    expect(model.seen.some(s => s.step === 'pick-best')).toBe(false);
    // A bare manifest catalog: no routes, so no page URLs.
    expect(outcome.results[0]!.pageUrl).toBe('');
  });

  it('an `all` run merges duplicates and streams data-groups; other modes do not', async () => {
    const steps: string[] = [];
    let ids: string[] = [];
    const model: AiTransport = {
      async invoke(step, payload) {
        steps.push(step);
        if (step === 'plan')
          return steps.filter(s => s === 'plan').length === 1
            ? {
                done: false,
                calls: [{ tool: 'search_recipes', arguments: '{}' }],
              }
            : { done: true, calls: [] };
        if (step === 'extract')
          return {
            items: [
              { title: 'Pad thai', summary: '' },
              { title: 'Pad Thai (again)', summary: '' },
            ],
          };
        if (step === 'dedupe') {
          ids = (payload.results as Array<{ id: string }>).map(r => r.id);
          return {
            groups: [
              { members: ids.map((id, i) => ({ id, note: `copy ${i}` })) },
            ],
          };
        }
        return { bestId: '', reason: '' };
      },
    };
    const { connector } = sites(() => ({
      ok: true,
      httpStatus: 200,
      text: '[]',
    }));
    const { parts, writer } = collector();
    const outcome = await runSites(input, writer, {
      ai: model,
      catalog,
      connector,
    });
    expect(outcome.groups).toEqual([
      {
        members: [
          { resultId: ids[0], note: 'copy 0' },
          { resultId: ids[1], note: 'copy 1' },
        ],
      },
    ]);
    expect(parts.find(p => p.type === 'data-groups')?.data).toEqual({
      groups: outcome.groups,
    });

    steps.length = 0;
    const best = await runSites(
      { ...input, intent: { ...input.intent, selection: 'best' } },
      collector().writer,
      { ai: model, catalog, connector }
    );
    expect(best.groups).toEqual([]);
    expect(steps).not.toContain('dedupe');
  });

  it('flags a site whose every call was refused with 401/403', async () => {
    const model = ai([
      {
        done: false,
        calls: [
          { tool: 'search_recipes', arguments: '{}' },
          { tool: 'get_recipe', arguments: '{}' },
        ],
      },
    ]);
    let n = 0;
    const { connector } = sites(() => ({
      ok: false,
      httpStatus: n++ === 0 ? 401 : 403,
      text: 'no',
    }));
    const { parts, writer } = collector();
    const outcome = await runSites(input, writer, {
      ai: model,
      catalog,
      connector,
    });
    expect(outcome.sites[0]).toMatchObject({
      status: 'failed',
      needsSignIn: true,
    });
    expect(parts[parts.length - 1]!.data).toMatchObject({
      status: 'failed',
      needsSignIn: true,
    });

    const other = ai([
      { done: false, calls: [{ tool: 'search_recipes', arguments: '{}' }] },
    ]);
    const { connector: down } = sites(() => ({
      ok: false,
      httpStatus: 500,
      text: 'x',
    }));
    const failed = await runSites(input, collector().writer, {
      ai: other,
      catalog,
      connector: down,
    });
    expect(failed.sites[0]!.needsSignIn).toBeUndefined();
  });

  it('keeps results in site order whatever finishes first', async () => {
    const model: AiTransport = {
      async invoke(step, payload) {
        const host = (payload.site as { apiHost: string }).apiHost;
        if (step === 'plan')
          return (payload.history as unknown[]).length
            ? { done: true, calls: [] }
            : {
                done: false,
                calls: [{ tool: 'search_recipes', arguments: '{}' }],
              };
        return { items: [{ title: host, summary: '' }] };
      },
    };
    const outcome = await runSites(
      { ...input, sites: [{ apiHost: 'slow' }, { apiHost: 'fast' }] },
      collector().writer,
      {
        ai: model,
        catalog,
        connector: {
          open: async host => ({
            callTool: async () => {
              await new Promise(r => setTimeout(r, host === 'slow' ? 20 : 0));
              return { ok: true, httpStatus: 200, text: '{}' };
            },
            close: async () => undefined,
          }),
        },
      }
    );
    expect(outcome.results.map(r => r.title)).toEqual(['slow', 'fast']);
  });
});

describe('parseCallBody', () => {
  it('prefers the connector body, else parses text after a status line', () => {
    expect(parseCallBody({ ok: true, text: 'x', body: { a: 1 } })).toEqual({
      a: 1,
    });
    expect(parseCallBody({ ok: true, text: 'HTTP 200\n{"a":2}' })).toEqual({
      a: 2,
    });
    expect(parseCallBody({ ok: true, text: '[1]' })).toEqual([1]);
    expect(parseCallBody({ ok: true, text: '<html>' })).toBeUndefined();
    expect(parseCallBody({ ok: true, text: '' })).toBeUndefined();
  });
});

describe('isBotChallenge', () => {
  it('recognises bot-protection pages, not ordinary data', () => {
    expect(
      isBotChallenge(
        '<!DOCTYPE html><html><head><title>Challenge Validation</title>'
      )
    ).toBe(true);
    expect(isBotChallenge('<div id="px-captcha"></div>')).toBe(true);
    expect(isBotChallenge('<title>Just a moment...</title>')).toBe(true);
    expect(
      isBotChallenge('{"items":[{"name":"Captcha the flag night"}]}')
    ).toBe(false);
  });
});

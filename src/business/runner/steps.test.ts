import { describe, expect, it } from 'vitest';
import type { McpManifest, McpTool } from '@sudobility/raidr_types';
import type {
  AgentIntent,
  AgentStep,
  CandidateSite,
  FormField,
  ResultItem,
  SiteContext,
} from '@sudobility/raidr_agent_types';
import {
  type AiTransport,
  MAX_RANKED_SITES,
  mergeForm,
  dedupeResults,
  pickBest,
  classifySiteRegions,
  planSearch,
  planSites,
  prepareSites,
  siteHost,
  rankSites,
  type SiteContextSource,
  understandIntent,
} from './index';

function scripted(answers: Partial<Record<AgentStep, unknown>>) {
  const seen: Array<{ step: AgentStep; input: Record<string, unknown> }> = [];
  const ai: AiTransport = {
    async invoke(step, input) {
      seen.push({ step, input });
      const answer = answers[step];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(input) : answer;
    },
  };
  return { ai, seen };
}

const intent: AgentIntent = {
  location_needed: true,
  intent: 'event_search',
  labels: ['events'],
  slots: [],
  resultKind: 'generic',
  query: 'events tonight',
  what: 'find events',
  who: { kind: 'self' },
  how: null,
  when: {
    text: 'tonight',
    start: '2026-10-08T18:00:00-07:00',
    end: '2026-10-08T23:59:00-07:00',
  },
  where: { kind: 'current', places: [] },
  why: null,
  selection: 'all',
};

describe('understandIntent', () => {
  it('sends the device context and normalises the answer', async () => {
    const { ai, seen } = scripted({
      understand: {
        intent: 'event_search',
        labels: ['Events', 'nightlife', 'bad label!'],
        slots: [{ name: 'time', value: 'tonight' }],
        resultKind: 'generic',
        query: 'events tonight',
        what: 'find events',
        who: { kind: 'self' },
        how: null,
        when: {
          text: 'tonight',
          start: '2026-10-08T18:00:00-07:00',
          end: '2026-10-08T23:59:00-07:00',
        },
        where: { kind: 'current', places: [] },
        why: null,
        selection: 'all',
        location_needed: true,
      },
    });
    const result = await understandIntent(ai, {
      request: ' Find the events tonight ',
      vocabulary: ['events'],
      country: 'US',
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      now: '2026-10-08T15:00:00-07:00',
    });
    expect(seen[0]).toEqual({
      step: 'understand',
      input: {
        request: 'Find the events tonight',
        vocabulary: ['events'],
        country: 'US',
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
        now: '2026-10-08T15:00:00-07:00',
      },
    });
    expect(result).toEqual({
      ...intent,
      labels: ['events', 'nightlife'],
      slots: [{ name: 'time', value: 'tonight' }],
    });
  });

  it("turns unusable W's into null and defaults the selection", async () => {
    const { ai } = scripted({
      understand: {
        intent: 'apartment_rental',
        labels: ['real-estate'],
        resultKind: 'place',
        query: '',
        who: { kind: 'robot' },
        how: '   ',
        when: { text: '', start: 'next tuesday' },
        where: { kind: 'place', places: [] },
        why: 42,
        selection: 'some',
      },
    });
    const result = await understandIntent(ai, { request: 'apartments' });
    expect(result).toMatchObject({
      intent: 'apartment_rental',
      query: 'apartments',
      what: 'apartment_rental',
      who: null,
      how: null,
      when: null,
      where: null,
      why: null,
      selection: 'all',
      location_needed: false,
    });
  });

  it('keeps a party, places and clamps the party size', async () => {
    const { ai } = scripted({
      understand: {
        intent: 'flight_booking',
        labels: ['travel'],
        resultKind: 'product',
        query: 'flights SFO to Paris',
        what: 'book a flight',
        who: { kind: 'party', partySize: 1000.4, description: '2 adults' },
        where: {
          kind: 'place',
          places: [
            { name: 'SFO', role: 'origin' },
            { name: 'Paris', role: 'moon' },
            { role: 'stop' },
          ],
        },
        when: { text: 'next friday', start: '2026-10-16' },
        selection: 'best',
      },
    });
    const result = await understandIntent(ai, { request: 'flights' });
    expect(result.who).toEqual({
      kind: 'party',
      partySize: 100,
      description: '2 adults',
    });
    expect(result.where).toEqual({
      kind: 'places',
      places: [{ name: 'SFO', role: 'origin' }, { name: 'Paris' }],
    });
    expect(result.when).toEqual({ text: 'next friday', start: '2026-10-16' });
    expect(result.selection).toBe('best');
  });

  it('location_needed without a place means the current location', async () => {
    const { ai } = scripted({
      understand: { intent: 'x', location_needed: true, where: null },
    });
    const result = await understandIntent(ai, { request: 'coffee near me' });
    expect(result.where).toEqual({ kind: 'current', places: [] });
    expect(result.location_needed).toBe(true);
  });

  it('throws when there is no intent', async () => {
    const { ai } = scripted({ understand: { labels: [] } });
    await expect(understandIntent(ai, { request: 'x' })).rejects.toThrow(
      'did not understand'
    );
  });
});

const candidate = (apiHost: string): CandidateSite => ({
  apiHost,
  title: apiHost.toUpperCase(),
  description: `about ${apiHost}`,
  labels: ['events'],
  siteOrigins: [`https://${apiHost}`],
  toolCount: 3,
  authStyle: 'none',
});

describe('planSites', () => {
  it('returns the well-known sites as hosts, with or without a search', async () => {
    const { ai } = scripted({
      'plan-search': {
        search: false,
        country: '',
        query: '',
        reason: 'Generic events nearby',
        sites: [
          'lu.ma',
          'https://www.eventbrite.com/d/ca--san-francisco/tech/',
          'Meetup.com',
          'lu.ma',
          'not a domain',
          42,
        ],
      },
    });
    expect(
      await planSites(ai, { request: 'tech events this weekend', intent })
    ).toEqual({
      search: null,
      sites: ['lu.ma', 'www.eventbrite.com', 'meetup.com'],
      country: null,
    });
  });

  it('keeps the search beside the sites, and caps the sites', async () => {
    const { ai } = scripted({
      'plan-search': {
        search: true,
        country: 'US',
        query: 'taylor swift tickets',
        reason: 'A named artist',
        sites: Array.from({ length: 12 }, (_, i) => `site${i}.com`),
      },
    });
    const plan = await planSites(ai, { request: 'r', intent });
    expect(plan.search?.query).toBe('taylor swift tickets');
    expect(plan.sites).toHaveLength(8);
  });

  it('is empty when the model fails or answers nonsense', async () => {
    const down = scripted({ 'plan-search': new Error('model down') });
    expect(
      await planSites(down.ai, { request: 'r', intent, country: 'us' })
    ).toEqual({ search: null, sites: [], country: 'US' });
    expect(
      await planSites(scripted({ 'plan-search': 'nonsense' }).ai, {
        request: 'r',
        intent,
      })
    ).toEqual({ search: null, sites: [], country: null });
  });

  it("takes the target country, else the user's", async () => {
    const abroad = scripted({
      'plan-search': { search: false, sites: [], target_country: 'gb' },
    });
    expect(
      (await planSites(abroad.ai, { request: 'r', intent, country: 'US' }))
        .country
    ).toBe('GB');
    const home = scripted({ 'plan-search': { search: false, sites: [] } });
    expect(
      (await planSites(home.ai, { request: 'r', intent, country: 'US' }))
        .country
    ).toBe('US');
  });
});

describe('classifySiteRegions', () => {
  it('asks once per domain and keeps only usable answers for those domains', async () => {
    const { ai, seen } = scripted({
      'site-regions': {
        sites: [
          {
            domain: 'AfricaTickets.org',
            global: false,
            countries: ['ng', 'KE', 'xx1'],
          },
          { domain: 'eventbrite.com', global: true, countries: ['US'] },
          { domain: 'vague.com', global: false, countries: [] },
          { domain: 'not-asked.com', global: true, countries: [] },
        ],
      },
    });
    const areas = await classifySiteRegions(ai, [
      { domain: 'africatickets.org', title: 'Africa Tickets', description: '' },
      { domain: 'eventbrite.com', title: 'Eventbrite', description: '' },
      { domain: 'Eventbrite.com', title: 'dup', description: '' },
      { domain: 'vague.com', title: 'Vague', description: '' },
    ]);
    expect(areas).toEqual([
      { domain: 'africatickets.org', global: false, countries: ['NG', 'KE'] },
      { domain: 'eventbrite.com', global: true, countries: [] },
    ]);
    expect((seen[0]!.input.sites as unknown[]).length).toBe(3);
  });

  it('is empty without sites, and when the model fails', async () => {
    const { ai, seen } = scripted({});
    expect(await classifySiteRegions(ai, [])).toEqual([]);
    expect(seen).toHaveLength(0);
    const down = scripted({ 'site-regions': new Error('down') });
    expect(
      await classifySiteRegions(down.ai, [
        { domain: 'a.com', title: 'A', description: '' },
      ])
    ).toEqual([]);
  });
});

describe('siteHost', () => {
  it('takes a host or a URL and rejects what is not a public hostname', () => {
    expect(siteHost('LU.MA')).toBe('lu.ma');
    expect(siteHost('https://user:pw@www.meetup.com:8443/x?y')).toBe(
      'www.meetup.com'
    );
    expect(siteHost('localhost')).toBeNull();
    expect(siteHost('10.0.0.1')).toBeNull();
    expect(siteHost('')).toBeNull();
    expect(siteHost(null)).toBeNull();
  });
});

describe('planSearch', () => {
  it('sends the request, intent and region, and returns the plan', async () => {
    const { ai, seen } = scripted({
      'plan-search': {
        search: true,
        country: 'US',
        query: 'taylor swift tickets',
        reason: 'A named artist',
      },
    });
    const plan = await planSearch(ai, {
      request: ' Taylor Swift concert tickets ',
      intent,
      country: 'US',
      locale: 'en-US',
    });
    expect(plan).toEqual({
      country: 'US',
      query: 'taylor swift tickets',
      reason: 'A named artist',
    });
    expect(seen[0]).toEqual({
      step: 'plan-search',
      input: {
        request: 'Taylor Swift concert tickets',
        intent,
        country: 'US',
        locale: 'en-US',
      },
    });
  });

  it('is null when searching does not help, or the answer is unusable', async () => {
    const no = scripted({
      'plan-search': {
        search: false,
        country: '',
        query: '',
        reason: 'Generic',
      },
    });
    expect(
      await planSearch(no.ai, { request: 'events around me', intent })
    ).toBeNull();
    const noQuery = scripted({
      'plan-search': { search: true, country: 'US', query: ' ', reason: '' },
    });
    expect(await planSearch(noQuery.ai, { request: 'r', intent })).toBeNull();
    const down = scripted({ 'plan-search': new Error('model down') });
    expect(await planSearch(down.ai, { request: 'r', intent })).toBeNull();
    expect(
      await planSearch(scripted({ 'plan-search': 'nonsense' }).ai, {
        request: 'r',
        intent,
      })
    ).toBeNull();
  });

  it("searches the user's region when the model names none", async () => {
    const answer = {
      search: true,
      country: 'China',
      query: '周杰伦 门票',
      reason: '',
    };
    const cn = await planSearch(scripted({ 'plan-search': answer }).ai, {
      request: 'r',
      intent,
      country: 'cn',
    });
    expect(cn?.country).toBe('CN');
    const anywhere = await planSearch(scripted({ 'plan-search': answer }).ai, {
      request: 'r',
      intent,
    });
    expect(anywhere?.country).toBeNull();
    const jp = await planSearch(
      scripted({ 'plan-search': { ...answer, country: 'jp' } }).ai,
      { request: 'r', intent, country: 'US' }
    );
    expect(jp?.country).toBe('JP');
  });
});

describe('rankSites', () => {
  it('shows search results found on a candidate', async () => {
    const { ai, seen } = scripted({ 'rank-sites': { sites: [] } });
    const hit = (n: number) => ({
      url: `https://www.ticketmaster.com/e/${n}`,
      title: `Taylor Swift ${n}`,
      snippet: 's'.repeat(400),
    });
    await rankSites(ai, {
      request: 'r',
      intent,
      candidates: [
        {
          apiHost: 'app.ticketmaster.com',
          title: 'Ticketmaster',
          description: '',
          labels: ['events'],
          siteOrigins: ['https://www.ticketmaster.com'],
          toolCount: 9,
          authStyle: 'none',
          searchHits: [hit(1), hit(2), hit(3), hit(4)],
        },
      ],
    });
    const sites = seen[0]!.input.sites as Array<{
      searchHits?: Array<{ snippet: string }>;
    }>;
    expect(sites[0]!.searchHits).toHaveLength(3);
    expect(sites[0]!.searchHits![0]!.snippet).toHaveLength(300);
  });

  it("shows each candidate's most relevant tools when given a catalog", async () => {
    const { ai, seen } = scripted({ 'rank-sites': { sites: [] } });
    const tool = (name: string, description: string, params: string[]) => ({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          params.map(p => [p, { type: 'string' }])
        ),
      },
      request: { method: 'GET', pathTemplate: `/${name}` },
    });
    const catalog = {
      manifest: async (apiHost: string) => {
        if (apiHost === 'broken.example') throw new Error('gone');
        return {
          apiHost,
          tools: [
            tool('post_comment', 'Post a comment', ['content']),
            tool('search_events', 'Search events', ['query', 'date']),
          ],
        } as never;
      },
    };
    await rankSites(
      ai,
      {
        request: 'events tonight',
        intent,
        candidates: [candidate('a.example'), candidate('broken.example')],
      },
      catalog
    );
    const sites = (seen[0]!.input as { sites: Array<Record<string, unknown>> })
      .sites;
    // `query` is a keyword parameter: the site can search for what was asked.
    expect(sites[0]!.canSearch).toBe(true);
    expect(sites[1]!.canSearch).toBeUndefined();
    expect(sites[0]!.tools).toEqual([
      {
        name: 'search_events',
        description: 'Search events',
        params: ['query', 'date'],
      },
      {
        name: 'post_comment',
        description: 'Post a comment',
        params: ['content'],
      },
    ]);
    // A manifest that fails to load just leaves the tools out.
    expect(sites[1]).not.toHaveProperty('tools');
  });

  it('keeps only known sites, in the model order, with reasons', async () => {
    const { ai, seen } = scripted({
      'rank-sites': {
        sites: [
          { apiHost: 'b.example', reason: 'Local events' },
          { apiHost: 'evil.example', reason: 'not a candidate' },
          { apiHost: 'a.example', reason: '' },
          { apiHost: 'b.example', reason: 'dup' },
          { nope: true },
        ],
      },
    });
    const ranked = await rankSites(ai, {
      request: 'events tonight',
      intent,
      country: 'US',
      candidates: [
        candidate('a.example'),
        candidate('b.example'),
        candidate('c.example'),
      ],
    });
    expect(ranked.map(s => s.apiHost)).toEqual(['b.example', 'a.example']);
    expect(ranked[0]!.reason).toBe('Local events');
    expect(ranked[1]!.reason).toBeUndefined();
    expect(seen[0]!.input).toMatchObject({
      country: 'US',
      sites: [
        {
          apiHost: 'a.example',
          title: 'A.EXAMPLE',
          labels: ['events'],
          toolCount: 3,
        },
        expect.anything(),
        expect.anything(),
      ],
    });
  });

  it('caps at 12 and keeps the candidate order when the answer is unusable', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate(`s${i}.example`)
    );
    const all = scripted({
      'rank-sites': {
        sites: many.map(s => ({ apiHost: s.apiHost, reason: 'ok' })),
      },
    });
    expect(
      await rankSites(all.ai, { request: 'r', intent, candidates: many })
    ).toHaveLength(MAX_RANKED_SITES);
    const broken = scripted({ 'rank-sites': 'nonsense' });
    const kept = await rankSites(broken.ai, {
      request: 'r',
      intent,
      candidates: many,
    });
    expect(kept.map(s => s.apiHost)).toEqual(
      many.slice(0, 12).map(s => s.apiHost)
    );
  });

  it('does not ask the model about no candidates', async () => {
    const { ai, seen } = scripted({});
    expect(
      await rankSites(ai, { request: 'r', intent, candidates: [] })
    ).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

const tool = (name: string, description = ''): McpTool =>
  ({
    name,
    description,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    request: { method: 'GET', pathTemplate: `/${name}` },
  }) as McpTool;

function contextOf(
  apiHost: string,
  style: 'none' | 'bearer',
  toolAuth: SiteContext['toolAuth'] = {}
): SiteContext {
  return {
    manifest: {
      apiHost,
      title: `Site ${apiHost}`,
      description: 'desc',
      siteOrigins: [`https://${apiHost}`],
      auth: { style },
      tools: [
        tool('search_events', 'Search events'),
        tool('my_tickets'),
        tool('get_event'),
      ],
    } as unknown as McpManifest,
    toolAuth,
    routes: [],
  };
}

describe('prepareSites', () => {
  const catalog: SiteContextSource = {
    async context(apiHost) {
      if (apiHost === 'gone.example') throw new Error('404');
      return contextOf(
        apiHost,
        apiHost === 'open.example' ? 'none' : 'bearer',
        { search_events: 'user', my_tickets: 'user' }
      );
    },
  };

  it('plans each site, checks tools, forces no sign-in for auth none, merges the form', async () => {
    const { ai, seen } = scripted({
      prepare: (input: Record<string, unknown>) => {
        const site = (input.site as { apiHost: string }).apiHost;
        if (site === 'nope.example')
          return {
            tools: [],
            login: 'none',
            fields: [],
            unsupported: 'Only sells shoes',
          };
        return {
          tools: ['search_events', 'made_up', 'search_events', 'get_event'],
          login: 'fallback',
          loginReason: 'See events for members',
          fields: [
            {
              name: 'Category',
              label: 'Category',
              type: 'select',
              required: false,
              options: [{ value: site, label: site }],
            },
            {
              name: 'startDate',
              label: 'Start',
              type: 'date',
              required: site === 'open.example',
              default: '2026-10-08',
            },
            { name: '???', label: 'bad', type: 'text', required: true },
          ],
        };
      },
    });
    const result = await prepareSites(ai, catalog, {
      request: 'events tonight',
      intent,
      location: { latitude: 1, longitude: 2 },
      sites: ['events.example', 'open.example', 'nope.example', 'gone.example'],
    });
    expect(result.sites).toEqual([
      {
        apiHost: 'events.example',
        title: 'Site events.example',
        tools: ['search_events', 'get_event'],
        login: 'fallback',
        loginReason: 'See events for members',
      },
      {
        apiHost: 'open.example',
        title: 'Site open.example',
        tools: ['search_events', 'get_event'],
        login: 'none',
      },
      {
        apiHost: 'nope.example',
        title: 'Site nope.example',
        tools: ['search_events', 'my_tickets', 'get_event'],
        login: 'none',
        unsupported: 'Only sells shoes',
      },
      {
        apiHost: 'gone.example',
        title: 'gone.example',
        tools: [],
        login: 'none',
        unsupported: 'This site could not be loaded',
      },
    ]);
    expect(result.form).toEqual([
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        required: false,
        options: [
          { value: 'events.example', label: 'events.example' },
          { value: 'open.example', label: 'open.example' },
        ],
      },
      {
        name: 'start_date',
        label: 'Start',
        type: 'date',
        required: true,
        default: '2026-10-08',
      },
    ]);
    const first = seen.find(
      s => (s.input.site as { apiHost: string }).apiHost === 'events.example'
    )!;
    expect(first.input.location).toEqual({ latitude: 1, longitude: 2 });
    expect(first.input.tools).toEqual([
      expect.objectContaining({ name: 'search_events', auth: 'user' }),
      expect.objectContaining({ name: 'my_tickets', auth: 'user' }),
      expect.objectContaining({ name: 'get_event', auth: 'unknown' }),
    ]);
  });

  it('falls back to the best-ranked tools when the answer is unusable', async () => {
    const { ai } = scripted({ prepare: { nothing: true } });
    const result = await prepareSites(ai, catalog, {
      request: 'events',
      intent: { ...intent, location_needed: false },
      sites: ['events.example'],
    });
    expect(result.sites[0]).toEqual({
      apiHost: 'events.example',
      title: 'Site events.example',
      tools: ['search_events', 'my_tickets', 'get_event'],
      login: 'fallback',
    });
    expect(result.form).toEqual([]);
  });

  it('works with a bare manifest catalog (no tool auth)', async () => {
    const { ai, seen } = scripted({
      prepare: { tools: ['get_event'], login: 'required', fields: [] },
    });
    const result = await prepareSites(
      ai,
      { manifest: async h => contextOf(h, 'bearer').manifest },
      { request: 'my tickets', intent, sites: ['events.example'] }
    );
    expect(result.sites[0]).toMatchObject({
      tools: ['get_event'],
      login: 'required',
    });
    expect((seen[0]!.input.tools as Array<{ auth: string }>)[0]!.auth).toBe(
      'unknown'
    );
  });

  it('passes model errors on', async () => {
    const { ai } = scripted({ prepare: new Error('provider down') });
    await expect(
      prepareSites(ai, catalog, {
        request: 'x',
        intent,
        sites: ['events.example'],
      })
    ).rejects.toThrow('provider down');
  });
});

describe('mergeForm', () => {
  const f = (over: Partial<FormField>): FormField => ({
    name: 'keyword',
    label: 'Keyword',
    type: 'text',
    required: false,
    ...over,
  });

  it('dedupes by name: first wins, options union, required if any', () => {
    const merged = mergeForm([
      [
        f({ label: 'Search' }),
        f({
          name: 'genre',
          type: 'multiselect',
          options: [{ value: 'rock', label: 'Rock' }],
        }),
      ],
      [
        f({ label: 'Other', required: true, default: 'x' }),
        f({
          name: 'genre',
          type: 'multiselect',
          options: [
            { value: 'rock', label: 'ROCK' },
            { value: 'jazz', label: 'Jazz' },
          ],
        }),
      ],
    ]);
    expect(merged).toEqual([
      f({ label: 'Search', required: true }),
      f({
        name: 'genre',
        type: 'multiselect',
        options: [
          { value: 'rock', label: 'Rock' },
          { value: 'jazz', label: 'Jazz' },
        ],
      }),
    ]);
  });

  it('does not mutate its input and caps the form', () => {
    const options = [{ value: 'a', label: 'A' }];
    const first = [f({ name: 's', type: 'select', options })];
    mergeForm([
      first,
      [f({ name: 's', type: 'select', options: [{ value: 'b', label: 'B' }] })],
    ]);
    expect(options).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => f({ name: `f${i}` }));
    expect(mergeForm([many])).toHaveLength(12);
  });
});

describe('pickBest', () => {
  const result = (id: string): ResultItem => ({
    id,
    apiHost: 'a',
    siteTitle: 'A',
    title: `T ${id}`,
    summary: '',
    imageUrl: '',
    sourceUrl: '',
    pageUrl: '',
    recipe: null,
    fields: [{ label: 'Price', value: '$1' }],
  });

  it('asks the model and checks its answer', async () => {
    const { ai, seen } = scripted({
      'pick-best': { bestId: 'b', reason: 'Cheapest' },
    });
    expect(
      await pickBest(ai, {
        request: 'r',
        intent,
        results: [result('a'), result('b')],
      })
    ).toEqual({ resultId: 'b', reason: 'Cheapest' });
    expect(seen[0]!.input.results).toEqual([
      {
        id: 'a',
        siteTitle: 'A',
        title: 'T a',
        summary: '',
        fields: [{ label: 'Price', value: '$1' }],
      },
      expect.objectContaining({ id: 'b' }),
    ]);
  });

  it('falls back to the first result', async () => {
    const results = [result('a'), result('b')];
    for (const answer of [
      { bestId: 'zzz', reason: 'x' },
      'garbage',
      new Error('down'),
    ]) {
      const { ai } = scripted({ 'pick-best': answer });
      expect(await pickBest(ai, { request: 'r', intent, results })).toEqual({
        resultId: 'a',
        reason: '',
      });
    }
  });

  it('one result is the best without asking; none is null', async () => {
    const { ai, seen } = scripted({});
    expect(
      await pickBest(ai, { request: 'r', intent, results: [result('x')] })
    ).toEqual({
      resultId: 'x',
      reason: '',
    });
    expect(
      await pickBest(ai, { request: 'r', intent, results: [] })
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('dedupeResults', () => {
  const result = (id: string, apiHost = 'a'): ResultItem => ({
    id,
    apiHost,
    siteTitle: apiHost.toUpperCase(),
    title: `T ${id}`,
    summary: '',
    imageUrl: '',
    sourceUrl: '',
    pageUrl: '',
    recipe: null,
    fields: [{ label: 'Price', value: '$1' }],
  });

  it('keeps known ids once, groups of two or more, in result order', async () => {
    const { ai, seen } = scripted({
      dedupe: {
        groups: [
          {
            members: [
              { id: 'c', note: '$90 · Section B' },
              { id: 'a', note: '$85 · GA' },
              { id: 'ghost', note: 'not a result' },
            ],
          },
          // 'a' is already taken; 'b' alone is not a group.
          { members: [{ id: 'a' }, { id: 'b', note: 'x' }] },
          { members: [{ id: 'd' }, { id: 'e', note: '  ' }] },
          'junk',
        ],
      },
    });
    const groups = await dedupeResults(ai, {
      request: 'r',
      intent,
      results: ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
        result(id, i % 2 ? 'b.example' : 'a.example')
      ),
    });
    expect(groups).toEqual([
      {
        members: [
          { resultId: 'a', note: '$85 · GA' },
          { resultId: 'c', note: '$90 · Section B' },
        ],
      },
      {
        members: [
          { resultId: 'd', note: '' },
          { resultId: 'e', note: '' },
        ],
      },
    ]);
    expect(seen[0]!.input.results).toContainEqual({
      id: 'b',
      site: 'B.EXAMPLE',
      title: 'T b',
      summary: '',
      fields: [{ label: 'Price', value: '$1' }],
    });
  });

  it('merges nothing for one result, a model error or a bad answer', async () => {
    const one = scripted({});
    expect(
      await dedupeResults(one.ai, {
        request: 'r',
        intent,
        results: [result('a')],
      })
    ).toEqual([]);
    expect(one.seen).toHaveLength(0);
    for (const answer of [new Error('down'), 'nonsense', { groups: 'no' }]) {
      const { ai } = scripted({ dedupe: answer });
      expect(
        await dedupeResults(ai, {
          request: 'r',
          intent,
          results: [result('a'), result('b')],
        })
      ).toEqual([]);
    }
  });
});

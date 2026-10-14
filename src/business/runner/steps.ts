/**
 * The model decisions around a run: understand the request, rank the
 * candidate sites, prepare each chosen site (tools, sign-in, form), and pick
 * the best result. Each one calls one ShapeShyft endpoint through the
 * {@link AiTransport} and checks the (untrusted) answer.
 *
 * Shared by raidr_agent_api (cloud) and the app (local mode). RN-safe.
 */
import type {
  AgentIntent,
  BestData,
  CandidateSite,
  FormField,
  GeoLocation,
  PrepareResponse,
  ResultGroup,
  ResultGroupMember,
  ResultItem,
  SearchPlan,
  SitePlan,
  SiteServiceArea,
  ToolAuth,
} from '@sudobility/raidr_agent_types';
import type { AiTransport, SiteCatalog, SiteContextSource } from './runner';
import { loadSiteContext, rankTools } from './runner';
import {
  dedupeSchema,
  MAX_PREPARED_TOOLS,
  MAX_REGION_SITES,
  pickBestSchema,
  prepareSchema,
  rankSitesSchema,
  siteRegionsSchema,
  type SitesPlan,
  toAgentIntent,
  toSitesPlan,
} from './schemas';
import { MAX_HITS_PER_SITE } from './search';

// =============================================================================
// understand
// =============================================================================

export interface UnderstandInput {
  request: string;
  /** The catalog's labels (the server adds them; local mode gets them via `/llm/payload`). */
  vocabulary?: string[];
  country?: string;
  locale?: string;
  timeZone?: string;
  now?: string;
}

/**
 * `understand-intent`: the request → its {@link AgentIntent} (six W's and
 * the selection mode), normalised by {@link toAgentIntent}.
 *
 * @throws when the model's answer has no usable intent.
 */
export async function understandIntent(
  ai: AiTransport,
  input: UnderstandInput
): Promise<AgentIntent> {
  const request = input.request.trim();
  const output = await ai.invoke('understand', {
    request,
    ...(input.vocabulary ? { vocabulary: input.vocabulary } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    return toAgentIntent(output, request);
  } catch {
    throw new Error('The model did not understand the request');
  }
}

// =============================================================================
// plan-search
// =============================================================================

export interface PlanSearchInput {
  request: string;
  intent: AgentIntent;
  country?: string;
  locale?: string;
}

/**
 * `plan-search`: which well-known sites serve this request in the user's
 * region (from the model's own knowledge), and whether to also search the web
 * first, where and for what. The sites are what the catalog's labels cannot
 * tell apart ("tech events in San Francisco": Luma and Eventbrite, not a
 * ticket shop abroad). Optional: a model error or an unusable answer is no
 * sites and no search, and the flow goes on with the label candidates.
 */
export async function planSites(
  ai: AiTransport,
  input: PlanSearchInput
): Promise<SitesPlan> {
  let output: unknown;
  try {
    output = await ai.invoke('plan-search', {
      request: input.request.trim(),
      intent: input.intent,
      ...(input.country ? { country: input.country } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    });
  } catch {
    return toSitesPlan(null, input.country);
  }
  return toSitesPlan(output, input.country);
}

// =============================================================================
// site-regions
// =============================================================================

/** A site to classify: what the model needs to tell where it serves. */
export interface SiteToClassify {
  /** Registrable domain (`africatickets.org`). */
  domain: string;
  title: string;
  description: string;
}

/**
 * `site-regions`: where each site serves people (worldwide, or which
 * countries), from its domain, title and description. Only the domains asked
 * about come back, and only usable answers (worldwide, or at least one
 * country); a model error is no answers, and the caller treats those sites
 * as unknown.
 */
export async function classifySiteRegions(
  ai: AiTransport,
  sites: SiteToClassify[]
): Promise<SiteServiceArea[]> {
  const byDomain = new Map<string, SiteToClassify>();
  for (const site of sites) {
    const domain = site.domain.trim().toLowerCase();
    if (domain && !byDomain.has(domain))
      byDomain.set(domain, { ...site, domain });
  }
  const asked = [...byDomain.values()].slice(0, MAX_REGION_SITES);
  if (asked.length === 0) return [];
  let output: unknown;
  try {
    output = await ai.invoke('site-regions', {
      sites: asked.map(s => ({
        domain: s.domain,
        title: s.title.slice(0, 200),
        description: s.description.slice(0, 400),
      })),
    });
  } catch {
    return [];
  }
  const parsed = siteRegionsSchema.safeParse(output);
  if (!parsed.success) return [];
  const wanted = new Set(asked.map(s => s.domain));
  const seen = new Set<string>();
  const areas: SiteServiceArea[] = [];
  for (const answer of parsed.data.sites) {
    if (!wanted.has(answer.domain) || seen.has(answer.domain)) continue;
    if (!answer.global && answer.countries.length === 0) continue;
    seen.add(answer.domain);
    areas.push({
      domain: answer.domain,
      global: answer.global,
      countries: answer.global ? [] : answer.countries,
    });
  }
  return areas;
}

/**
 * The web-search half of {@link planSites}: a request for one specific thing
 * (an artist's concert tickets) gets a plan; a generic one ("events around
 * me") gets null, as does a model error.
 */
export async function planSearch(
  ai: AiTransport,
  input: PlanSearchInput
): Promise<SearchPlan | null> {
  return (await planSites(ai, input)).search;
}

// =============================================================================
// rank-sites
// =============================================================================

/** Most sites `rank-sites` keeps. */
export const MAX_RANKED_SITES = 12;

/** Tools per candidate shown to `rank-sites` (the most relevant ones). */
export const RANK_TOOLS_PER_SITE = 8;

export interface RankSitesInput {
  request: string;
  intent: AgentIntent;
  country?: string;
  candidates: CandidateSite[];
}

/** A candidate's most relevant tools, as `rank-sites` sees them. */
/** Parameters that take the user's words: a tool with one can search for exactly what was asked. */
const SEARCH_PARAM =
  /^(q|query|search|keywords?|term|text|search_?term|search_?query|search_?text|searchterm)$/i;

/** Whether any of these tools searches by keyword (has a `q`/`query`/`search`… parameter). */
export function toolsCanSearch(
  tools: Array<{ inputSchema?: unknown }>
): boolean {
  return tools.some(t =>
    Object.keys(
      ((t.inputSchema ?? {}) as { properties?: Record<string, unknown> })
        .properties ?? {}
    ).some(p => SEARCH_PARAM.test(p))
  );
}

/**
 * What `rank-sites` sees of a candidate's tools: the most relevant ones, and
 * whether any tool searches by keyword (`canSearch`).
 */
async function rankingTools(
  catalog: SiteCatalog,
  apiHost: string,
  text: string
): Promise<{
  tools: Array<{ name: string; description: string; params: string[] }>;
  canSearch: boolean;
} | null> {
  try {
    const manifest = await catalog.manifest(apiHost);
    const paramsOf = (t: { inputSchema?: unknown }) =>
      Object.keys(
        ((t.inputSchema ?? {}) as { properties?: Record<string, unknown> })
          .properties ?? {}
      );
    return {
      tools: rankTools(manifest.tools, text)
        .slice(0, RANK_TOOLS_PER_SITE)
        .map(t => ({
          name: t.name,
          description: (t.description ?? '').slice(0, 160),
          params: paramsOf(t).slice(0, 12),
        })),
      canSearch: manifest.tools.some(t =>
        paramsOf(t).some(p => SEARCH_PARAM.test(p))
      ),
    };
  } catch {
    // An unreadable manifest just ranks on the description.
    return null;
  }
}

/**
 * `rank-sites`: the label matches ordered best first, unsuitable ones left
 * out, each with a `reason`. Only sites from `candidates` survive (deduped,
 * at most {@link MAX_RANKED_SITES}). An answer that does not parse keeps the
 * candidates' own order.
 *
 * With a `catalog`, each candidate also carries its most relevant tools
 * (name, description, parameter names), so a site whose tools cannot take
 * the request's search terms ranks below one that can.
 */
export async function rankSites(
  ai: AiTransport,
  input: RankSitesInput,
  catalog?: SiteCatalog
): Promise<CandidateSite[]> {
  if (input.candidates.length === 0) return [];
  const byHost = new Map(input.candidates.map(c => [c.apiHost, c]));
  const text = `${input.request} ${input.intent.query}`;
  const tools = catalog
    ? await Promise.all(
        input.candidates.map(c => rankingTools(catalog, c.apiHost, text))
      )
    : [];
  const output = await ai.invoke('rank-sites', {
    request: input.request,
    intent: input.intent,
    ...(input.country ? { country: input.country } : {}),
    sites: input.candidates.map((c, i) => ({
      apiHost: c.apiHost,
      title: c.title,
      description: c.description,
      labels: c.labels,
      toolCount: c.toolCount,
      ...(c.searchHits?.length
        ? {
            searchHits: c.searchHits.slice(0, MAX_HITS_PER_SITE).map(h => ({
              url: h.url,
              title: h.title.slice(0, 200),
              snippet: h.snippet.slice(0, 300),
            })),
          }
        : {}),
      ...(tools[i]?.tools.length ? { tools: tools[i]?.tools } : {}),
      ...(tools[i] ? { canSearch: tools[i]?.canSearch } : {}),
    })),
  });
  const parsed = rankSitesSchema.safeParse(output);
  if (!parsed.success) return input.candidates.slice(0, MAX_RANKED_SITES);
  const seen = new Set<string>();
  const ranked: CandidateSite[] = [];
  for (const { apiHost, reason } of parsed.data.sites) {
    const site = byHost.get(apiHost);
    if (!site || seen.has(apiHost)) continue;
    seen.add(apiHost);
    ranked.push(reason ? { ...site, reason } : site);
    if (ranked.length >= MAX_RANKED_SITES) break;
  }
  return ranked;
}

// =============================================================================
// prepare
// =============================================================================

/** Most fields the merged form holds. */
export const MAX_MERGED_FIELDS = 12;

/**
 * One form from several sites' fields: deduped by name (the first site's
 * field wins, options are the union, required if any site requires it),
 * capped at {@link MAX_MERGED_FIELDS}.
 */
export function mergeForm(fieldLists: FormField[][]): FormField[] {
  const merged: FormField[] = [];
  const byName = new Map<string, FormField>();
  for (const fields of fieldLists) {
    for (const field of fields) {
      const existing = byName.get(field.name);
      if (!existing) {
        if (merged.length >= MAX_MERGED_FIELDS) continue;
        const copy: FormField = {
          ...field,
          ...(field.options ? { options: [...field.options] } : {}),
        };
        byName.set(field.name, copy);
        merged.push(copy);
        continue;
      }
      if (field.required) existing.required = true;
      if (existing.options && field.options) {
        for (const option of field.options) {
          if (!existing.options.some(o => o.value === option.value))
            existing.options.push(option);
        }
      }
    }
  }
  return merged;
}

export interface PrepareSitesInput {
  request: string;
  intent: AgentIntent;
  location?: GeoLocation;
  /** apiHosts the user chose. */
  sites: string[];
}

/** Most tools shown to `prepare` per site. */
export const MAX_PREPARE_TOOLS = 40;

/**
 * `prepare-site` for each chosen site (at most 4 at a time): which tools to
 * call, whether to sign in, which inputs to ask for; then one merged form.
 *
 * - tools the model names that the site does not have are dropped (at most
 *   {@link MAX_PREPARED_TOOLS}); none left → the 3 best-ranked tools;
 * - a site whose manifest needs no credential (`auth.style: 'none'`) never
 *   asks to sign in;
 * - a site the model calls `unsupported`, or whose context cannot be
 *   loaded, is reported with `unsupported` set and left out of the form;
 * - an answer that does not parse gives the 3 best-ranked tools, sign-in
 *   `fallback` when any of them needs the user, and no fields.
 *
 * Model transport errors are thrown (the caller decides about fallbacks).
 */
export async function prepareSites(
  ai: AiTransport,
  catalog: SiteContextSource | SiteCatalog,
  input: PrepareSitesInput
): Promise<PrepareResponse> {
  const hosts = [...new Set(input.sites)];
  const plans: Array<{ plan: SitePlan; fields: FormField[] }> = new Array(
    hosts.length
  );
  const queue = hosts.map((apiHost, index) => ({ apiHost, index }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      plans[next.index] = await prepareSite(ai, catalog, input, next.apiHost);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, worker));
  return {
    sites: plans.map(p => p.plan),
    form: mergeForm(plans.filter(p => !p.plan.unsupported).map(p => p.fields)),
  };
}

async function prepareSite(
  ai: AiTransport,
  catalog: SiteContextSource | SiteCatalog,
  input: PrepareSitesInput,
  apiHost: string
): Promise<{ plan: SitePlan; fields: FormField[] }> {
  let context;
  try {
    context = await loadSiteContext(catalog, apiHost);
  } catch {
    return {
      plan: {
        apiHost,
        title: apiHost,
        tools: [],
        login: 'none',
        unsupported: 'This site could not be loaded',
      },
      fields: [],
    };
  }
  const { manifest, toolAuth } = context;
  const ranked = rankTools(
    manifest.tools,
    `${input.request} ${input.intent.query}`
  ).slice(0, MAX_PREPARE_TOOLS);
  const auth = (name: string): ToolAuth | 'unknown' =>
    toolAuth[name] ?? 'unknown';
  const output = await ai.invoke('prepare', {
    request: input.request,
    intent: input.intent,
    ...(input.intent.location_needed && input.location
      ? { location: input.location }
      : {}),
    site: {
      apiHost,
      title: manifest.title,
      description: manifest.description,
    },
    tools: ranked.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      auth: auth(t.name),
    })),
  });
  const known = new Set(manifest.tools.map(t => t.name));
  const parsed = prepareSchema.safeParse(output);
  const noCredential = manifest.auth.style === 'none';

  if (!parsed.success) {
    const tools = ranked.slice(0, 3).map(t => t.name);
    const login =
      !noCredential && tools.some(t => auth(t) === 'user')
        ? 'fallback'
        : 'none';
    return {
      plan: { apiHost, title: manifest.title, tools, login },
      fields: [],
    };
  }
  const answer = parsed.data;
  let tools = [...new Set(answer.tools.filter(t => known.has(t)))].slice(
    0,
    MAX_PREPARED_TOOLS
  );
  if (tools.length === 0) tools = ranked.slice(0, 3).map(t => t.name);
  const login = noCredential ? 'none' : answer.login;
  const plan: SitePlan = {
    apiHost,
    title: manifest.title,
    tools,
    login,
    ...(login !== 'none' && answer.loginReason
      ? { loginReason: answer.loginReason }
      : {}),
    ...(answer.unsupported ? { unsupported: answer.unsupported } : {}),
  };
  return { plan, fields: answer.unsupported ? [] : answer.fields };
}

// =============================================================================
// pick-best
// =============================================================================

/** Most results `pick-best` compares. */
export const MAX_BEST_CANDIDATES = 40;

export interface PickBestInput {
  request: string;
  intent: AgentIntent;
  results: ResultItem[];
}

/**
 * `pick-best`: the one result that best answers the request. One result is
 * the best without asking; an unknown `bestId`, an answer that does not
 * parse or a model error falls back to the first result. Null only when
 * there are no results.
 */
export async function pickBest(
  ai: AiTransport,
  input: PickBestInput
): Promise<BestData | null> {
  const first = input.results[0];
  if (!first) return null;
  if (input.results.length === 1) return { resultId: first.id, reason: '' };
  const shown = input.results.slice(0, MAX_BEST_CANDIDATES);
  let output: unknown;
  try {
    output = await ai.invoke('pick-best', {
      request: input.request,
      intent: input.intent,
      results: shown.map(r => ({
        id: r.id,
        siteTitle: r.siteTitle,
        title: r.title,
        summary: r.summary,
        fields: r.fields,
      })),
    });
  } catch {
    return { resultId: first.id, reason: '' };
  }
  const parsed = pickBestSchema.safeParse(output);
  if (!parsed.success || !shown.some(r => r.id === parsed.data.bestId))
    return { resultId: first.id, reason: '' };
  return { resultId: parsed.data.bestId, reason: parsed.data.reason };
}

// =============================================================================
// dedupe
// =============================================================================

/** Most results `dedupe` compares. */
export const MAX_DEDUPE_RESULTS = 60;

export interface DedupeInput {
  request: string;
  intent: AgentIntent;
  results: ResultItem[];
}

/**
 * `dedupe`: results that are the same thing (the same concert on two ticket
 * sites), to show as one item. Only known ids count, each in one group, and
 * only groups of two or more survive; members keep the results' order, so
 * the first-listed copy is the one shown. A model error or an answer that
 * does not parse merges nothing.
 */
export async function dedupeResults(
  ai: AiTransport,
  input: DedupeInput
): Promise<ResultGroup[]> {
  if (input.results.length < 2) return [];
  const shown = input.results.slice(0, MAX_DEDUPE_RESULTS);
  let output: unknown;
  try {
    output = await ai.invoke('dedupe', {
      request: input.request,
      intent: input.intent,
      results: shown.map(r => ({
        id: r.id,
        site: r.siteTitle || r.apiHost,
        title: r.title,
        summary: r.summary,
        fields: r.fields,
      })),
    });
  } catch {
    return [];
  }
  const parsed = dedupeSchema.safeParse(output);
  if (!parsed.success) return [];
  const order = new Map(shown.map((r, i) => [r.id, i]));
  const taken = new Set<string>();
  const groups: ResultGroup[] = [];
  for (const group of parsed.data.groups) {
    const members: ResultGroupMember[] = [];
    for (const { id, note } of group.members) {
      if (!order.has(id) || taken.has(id)) continue;
      taken.add(id);
      members.push({ resultId: id, note });
    }
    if (members.length < 2) {
      for (const m of members) taken.delete(m.resultId);
      continue;
    }
    members.sort((a, b) => order.get(a.resultId)! - order.get(b.resultId)!);
    groups.push({ members });
  }
  return groups;
}

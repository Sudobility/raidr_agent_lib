import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AGENT_STEPS, type AgentStep } from '@sudobility/raidr_agent_types';
import {
  dedupeSchema,
  extractItemSchema,
  extractSchema,
  pickBestSchema,
  planSchema,
  planSearchSchema,
  prepareSchema,
  rankSitesSchema,
  siteRegionsSchema,
  STEP_ENDPOINTS,
  STEP_SCHEMAS,
  understandOutputSchema,
} from './index';

type Json = {
  type?: string;
  properties?: Record<string, Json>;
  required?: string[];
  items?: Json;
};

const ZOD: Record<AgentStep, z.ZodObject> = {
  understand: understandOutputSchema,
  'plan-search': planSearchSchema,
  'rank-sites': rankSitesSchema,
  prepare: prepareSchema,
  plan: planSchema,
  extract: extractSchema,
  'pick-best': pickBestSchema,
  dedupe: dedupeSchema,
  'site-regions': siteRegionsSchema,
};

/** The JSON object and the zod object name the same keys; zod's must-have keys are JSON-required. */
function agree(json: Json, schema: z.ZodObject, where: string) {
  const shape = schema.shape as Record<string, z.ZodType>;
  expect(Object.keys(json.properties ?? {}).sort(), where).toEqual(
    Object.keys(shape).sort()
  );
  for (const key of json.required ?? [])
    expect(Object.keys(shape), `${where}.${key}`).toContain(key);
  for (const [key, field] of Object.entries(shape)) {
    if (!field.safeParse(undefined).success)
      expect(json.required ?? [], `${where}.${key} must be required`).toContain(
        key
      );
  }
}

/** Every property is described and has a single-string type (ShapeShyft prints it). */
function walk(json: Json, path: string, visit: (j: Json, p: string) => void) {
  visit(json, path);
  for (const [k, v] of Object.entries(json.properties ?? {}))
    walk(v, `${path}.${k}`, visit);
  if (json.items) walk(json.items, `${path}[]`, visit);
}

describe('STEP_SCHEMAS', () => {
  it('covers every step with a named endpoint', () => {
    expect(Object.keys(STEP_SCHEMAS).sort()).toEqual([...AGENT_STEPS].sort());
    expect(Object.keys(STEP_ENDPOINTS).sort()).toEqual([...AGENT_STEPS].sort());
    for (const name of Object.values(STEP_ENDPOINTS))
      expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it.each(AGENT_STEPS.map(s => [s]))(
    '%s output agrees with its zod schema',
    step => {
      const json = STEP_SCHEMAS[step].output as Json;
      expect(json.type).toBe('object');
      agree(json, ZOD[step], step);
    }
  );

  it('nested items agree too', () => {
    const extract = STEP_SCHEMAS.extract.output as Json;
    agree(
      extract.properties!.items!.items!,
      extractItemSchema,
      'extract.items'
    );
    const plan = STEP_SCHEMAS.plan.output as Json;
    agree(
      plan.properties!.calls!.items!,
      planSchema.shape.calls.element,
      'plan.calls'
    );
    const prepare = STEP_SCHEMAS.prepare.output as Json;
    expect(
      Object.keys(prepare.properties!.fields!.items!.properties!).sort()
    ).toEqual(
      [
        'default',
        'description',
        'label',
        'name',
        'options',
        'required',
        'type',
      ].sort()
    );
  });

  it('every output property has a description and a single type', () => {
    for (const step of AGENT_STEPS) {
      walk(STEP_SCHEMAS[step].output as Json, step, (j, p) => {
        if (p === step) return;
        expect(
          (j as { description?: string }).description ??
            (p.endsWith('[]') ? 'item' : undefined),
          p
        ).toBeTruthy();
        if (j.type !== undefined) expect(typeof j.type, p).toBe('string');
      });
    }
  });

  it('required keys exist in properties', () => {
    for (const step of AGENT_STEPS) {
      for (const part of ['input', 'output'] as const) {
        walk(STEP_SCHEMAS[step][part] as Json, `${step}.${part}`, (j, p) => {
          for (const key of j.required ?? [])
            expect(Object.keys(j.properties ?? {}), p).toContain(key);
        });
      }
    }
  });

  it('an answer that follows the JSON Schema parses to itself', () => {
    const understand = {
      language: 'en',
      intent: 'event_search',
      labels: ['events'],
      slots: [],
      resultKind: 'generic',
      query: 'events',
      what: 'find events',
      who: { kind: 'self' },
      how: null,
      when: { text: 'tonight', start: '2026-10-08T18:00:00-07:00' },
      where: { kind: 'current', places: [] },
      why: null,
      selection: 'all',
      location_needed: true,
    };
    expect(understandOutputSchema.parse(understand)).toEqual(understand);
    const pick = { bestId: 'a:0', reason: 'Cheapest' };
    expect(pickBestSchema.parse(pick)).toEqual(pick);
    const rank = { sites: [{ apiHost: 'a.example', reason: 'Fits' }] };
    expect(rankSitesSchema.parse(rank)).toEqual(rank);
    const search = {
      search: true,
      country: 'CN',
      query: '周杰伦 演唱会 门票',
      reason: 'A named artist',
      sites: ['damai.cn', 'www.maoyan.com'],
      target_country: 'CN',
    };
    expect(planSearchSchema.parse(search)).toEqual(search);
    const regions = {
      sites: [
        { domain: 'eventbrite.com', global: true, countries: [] },
        { domain: 'africatickets.org', global: false, countries: ['NG', 'KE'] },
      ],
    };
    expect(siteRegionsSchema.parse(regions)).toEqual(regions);
    const plan = { done: false, calls: [{ tool: 't', arguments: '{}' }] };
    expect(planSchema.parse(plan)).toEqual(plan);
  });
});

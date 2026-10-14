import { describe, expect, it } from 'vitest';
import {
  languageTag,
  MAX_EXTRACTED,
  agentIntentSchema,
  canonicalFieldName,
  extractSchema,
  planSchema,
  prepareSchema,
  toAgentIntent,
  toFormField,
} from './index';

describe('canonicalFieldName', () => {
  it('makes snake_case names', () => {
    expect(canonicalFieldName('Party Size')).toBe('party_size');
    expect(canonicalFieldName('partySize')).toBe('party_size');
    expect(canonicalFieldName('price-max')).toBe('price_max');
    expect(canonicalFieldName('  start_date ')).toBe('start_date');
    expect(canonicalFieldName('123')).toBeNull();
    expect(canonicalFieldName('???')).toBeNull();
  });
});

describe('toFormField', () => {
  it('normalises names, labels, types and defaults', () => {
    expect(
      toFormField({
        name: 'partySize',
        type: 'number',
        default: '4',
        required: 'yes',
      })
    ).toEqual({
      name: 'party_size',
      label: 'Party size',
      type: 'number',
      required: false,
      default: 4,
    });
    expect(toFormField({ name: 'when', type: 'calendar', default: 7 })).toEqual(
      {
        name: 'when',
        label: 'When',
        type: 'text',
        required: false,
        default: '7',
      }
    );
  });

  it('turns a select without options into text and checks defaults against options', () => {
    expect(
      toFormField({ name: 'c', type: 'select', options: [] })
    ).toMatchObject({
      type: 'text',
    });
    expect(
      toFormField({ name: 'c', type: 'select', options: [] })
    ).not.toHaveProperty('options');
    expect(
      toFormField({
        name: 'genre',
        type: 'multiselect',
        options: [
          'rock',
          { value: 'jazz', label: 'Jazz' },
          { value: 'rock' },
          { label: 'x' },
        ],
        default: ['jazz', 'polka'],
      })
    ).toEqual({
      name: 'genre',
      label: 'Genre',
      type: 'multiselect',
      required: false,
      options: [
        { value: 'rock', label: 'rock' },
        { value: 'jazz', label: 'Jazz' },
      ],
      default: ['jazz'],
    });
    expect(
      toFormField({ name: 's', type: 'select', options: ['a'], default: 'b' })
    ).not.toHaveProperty('default');
    expect(
      toFormField({ name: 'b', type: 'boolean', default: 'true' })
    ).toMatchObject({ default: true });
    expect(
      toFormField({ name: 'b', type: 'boolean', default: 'maybe' })
    ).not.toHaveProperty('default');
  });

  it('rejects fields without a usable name', () => {
    expect(toFormField({ label: 'x' })).toBeNull();
    expect(toFormField('x')).toBeNull();
    expect(toFormField({ name: '!!!' })).toBeNull();
  });
});

describe('prepareSchema', () => {
  it('is tolerant except for tools', () => {
    expect(
      prepareSchema.parse({
        tools: ['a', 3, ' b '],
        login: 'maybe',
        loginReason: '',
        fields: [{ name: 'q' }, { name: 'q', label: 'dup' }, null],
      })
    ).toEqual({
      tools: ['a', 'b'],
      login: 'none',
      loginReason: null,
      unsupported: null,
      fields: [{ name: 'q', label: 'Q', type: 'text', required: false }],
    });
    expect(prepareSchema.safeParse({ login: 'none' }).success).toBe(false);
  });

  it('caps the fields at 8', () => {
    const fields = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}` }));
    expect(prepareSchema.parse({ tools: [], fields }).fields).toHaveLength(8);
  });
});

describe('planSchema', () => {
  it('accepts arguments as an object too', () => {
    expect(
      planSchema.parse({
        done: false,
        calls: [{ tool: 't', arguments: { q: 1 } }],
      })
    ).toEqual({ done: false, calls: [{ tool: 't', arguments: '{"q":1}' }] });
  });
});

describe('extractSchema', () => {
  it('drops bad items, defaults the rest, keeps refs', () => {
    const parsed = extractSchema.parse({
      items: [
        { title: '', summary: 'no title' },
        {
          title: 'Show',
          summary: 3,
          location: { latitude: 200, longitude: 0 },
          recipe: 'no',
          fields: [{ label: 'Price', value: 25 }, { label: 'bad' }],
          ref: { callId: 'c1', itemPath: 'entries[0]' },
        },
        { title: 'No ref', ref: { itemPath: 'x' } },
      ],
    });
    expect(parsed.items).toEqual([
      {
        title: 'Show',
        summary: '',
        imageUrl: '',
        sourceUrl: '',
        location: null,
        recipe: null,
        fields: [{ label: 'Price', value: '25' }],
        ref: { callId: 'c1', itemPath: 'entries[0]' },
      },
      {
        title: 'No ref',
        summary: '',
        imageUrl: '',
        sourceUrl: '',
        location: null,
        recipe: null,
        fields: [],
        ref: null,
      },
    ]);
  });

  it('caps at MAX_EXTRACTED items', () => {
    const items = Array.from({ length: MAX_EXTRACTED + 5 }, (_, i) => ({
      title: `t${i}`,
    }));
    expect(extractSchema.parse({ items }).items).toHaveLength(MAX_EXTRACTED);
  });
});

describe('agentIntentSchema', () => {
  it('accepts what toAgentIntent makes and refuses a v1 intent', () => {
    const intent = toAgentIntent(
      {
        intent: 'flight_booking',
        labels: ['travel'],
        who: { kind: 'party', partySize: 3 },
        where: {
          kind: 'places',
          places: [
            { name: 'SFO', role: 'origin' },
            { name: 'CDG', role: 'destination' },
          ],
        },
        selection: 'best',
      },
      'flights for 3'
    );
    expect(agentIntentSchema.parse(intent)).toEqual(intent);
    expect(
      agentIntentSchema.safeParse({
        location_needed: false,
        intent: 'recipe',
        labels: [],
        slots: [],
        resultKind: 'recipe',
        query: 'x',
      }).success
    ).toBe(false);
  });
});

describe('languageTag', () => {
  it('normalises BCP 47 tags and refuses anything else', () => {
    expect(languageTag('ja')).toBe('ja');
    expect(languageTag('ZH_hant')).toBe('zh-Hant');
    expect(languageTag('pt-br')).toBe('pt-BR');
    expect(languageTag('english')).toBeNull();
    expect(languageTag(7)).toBeNull();
  });

  it('is kept on the intent, and an old intent without it still validates', () => {
    const intent = toAgentIntent(
      { intent: 'recipe', language: 'de' },
      'Rezept für Pad Thai'
    );
    expect(intent.language).toBe('de');
    const { language: _language, ...old } = intent;
    expect(agentIntentSchema.safeParse(old).success).toBe(true);
    expect(agentIntentSchema.safeParse(intent).success).toBe(true);
  });
});

/**
 * The JSON Schemas of each step's ShapeShyft endpoint: what the agent sends
 * (`input`) and what the model must answer (`output`). raidr_agent_api's
 * `shapeshyft/endpoints/<name>.json` carry these verbatim (its tests check
 * that), and the zod schemas in `./schemas` parse the answers; the tests
 * here check that the two agree.
 *
 * ShapeShyft renders `output` into the prompt and into the provider's
 * `structured_response` tool, so every property has a description and
 * `type` is always a single string (nullable values say so in words).
 */
import type { AgentStep } from '@sudobility/raidr_agent_types';

type Json = Record<string, unknown>;

/** The hosted endpoint name of each step (raidr_agent_api can override them per env). */
export const STEP_ENDPOINTS: Record<AgentStep, string> = {
  understand: 'understand-intent',
  'plan-search': 'plan-search',
  'rank-sites': 'rank-sites',
  prepare: 'prepare-site',
  plan: 'plan-calls',
  extract: 'extract-results',
  'pick-best': 'pick-best',
  dedupe: 'dedupe-results',
  'site-regions': 'site-regions',
};

const str = (description: string, extra: Json = {}): Json => ({
  type: 'string',
  description,
  ...extra,
});

const location: Json = {
  type: 'object',
  description: 'Device position in decimal degrees.',
  properties: {
    latitude: { type: 'number', description: 'Latitude, -90 to 90.' },
    longitude: { type: 'number', description: 'Longitude, -180 to 180.' },
    accuracy: { type: 'number', description: 'Accuracy radius in meters.' },
  },
  required: ['latitude', 'longitude'],
};

const intentInput: Json = {
  type: 'object',
  description:
    'The understood request (output of understand-intent): intent, labels, slots, resultKind, query, what, who, how, when, where, why, selection, location_needed, language (write everything for the user in it).',
};

const site: Json = {
  type: 'object',
  description: 'The site being worked on.',
  properties: {
    apiHost: str('API host, e.g. api.example.com.'),
    title: str('Site name.'),
    description: str('What the site is.'),
  },
  required: ['apiHost', 'title'],
};

// =============================================================================
// understand-intent
// =============================================================================

const understandInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request, in their words."),
    vocabulary: {
      type: 'array',
      description:
        'Every site label in the catalog. Pick labels from this list only.',
      items: { type: 'string' },
    },
    country: str("ISO 3166-1 alpha-2 of the user's region, e.g. US."),
    locale: str("BCP 47 locale of the user's device, e.g. en-US."),
    timeZone: str(
      "IANA time zone of the user's device, e.g. America/New_York."
    ),
    now: str("The device's current date-time, ISO 8601 with offset."),
  },
  required: ['request', 'vocabulary'],
};

const understandOutput: Json = {
  type: 'object',
  properties: {
    intent: str(
      'Short lowercase slug of the task, e.g. recipe, event_search, flight_booking, apartment_rental, bank_transactions.',
      { maxLength: 60 }
    ),
    labels: {
      type: 'array',
      description:
        'Up to 6 labels from the vocabulary that a site able to answer this would carry, most relevant first.',
      items: { type: 'string' },
      maxItems: 6,
    },
    slots: {
      type: 'array',
      description:
        'Concrete values named in the request (dish, artist, budget, cuisine...). Empty when none.',
      items: {
        type: 'object',
        properties: {
          name: str('snake_case name, e.g. dish, price_max.'),
          value: str('The value as the user said it.'),
        },
        required: ['name', 'value'],
      },
      maxItems: 10,
    },
    resultKind: str('The shape of an answer; picks the result view.', {
      enum: [
        'recipe',
        'product',
        'article',
        'place',
        'media',
        'financial',
        'generic',
      ],
    }),
    query: str(
      'A short search query to send to the sites (keywords, no filler).',
      { maxLength: 300 }
    ),
    what: str('The action in a few words, e.g. find events, book a flight.', {
      maxLength: 200,
    }),
    who: {
      type: 'object',
      description:
        'Who it is for, or null when the request does not say or it does not matter.',
      properties: {
        kind: str('self: just the user; party: several people.', {
          enum: ['self', 'party'],
        }),
        partySize: {
          type: 'integer',
          description: 'Number of people including the user, when known.',
          minimum: 1,
          maximum: 100,
        },
        description: str('e.g. 2 adults, 1 child.'),
      },
      required: ['kind'],
    },
    how: str(
      'Constraints or preferences (cheapest, under $2000/month, vegetarian, 4+ stars), or null.'
    ),
    when: {
      type: 'object',
      description:
        'When, or null when the request has no time. Resolve start/end against now and timeZone.',
      properties: {
        text: str('The words the user used, e.g. tonight, next weekend.'),
        start: str('ISO 8601 date or date-time with offset.'),
        end: str('ISO 8601 date or date-time with offset.'),
      },
      required: ['text'],
    },
    where: {
      type: 'object',
      description:
        "Where, or null when place does not matter. current: near the user's device (near me, nearby, tonight in town); place: one named place; places: several (origin and destination).",
      properties: {
        kind: str('current, place or places.', {
          enum: ['current', 'place', 'places'],
        }),
        places: {
          type: 'array',
          description: 'Named places; empty for current.',
          items: {
            type: 'object',
            properties: {
              name: str('Place name as the user said it, e.g. Paris, SFO.'),
              role: str('Its role.', {
                enum: ['area', 'origin', 'destination', 'stop'],
              }),
            },
            required: ['name'],
          },
        },
      },
      required: ['kind', 'places'],
    },
    why: str(
      'The purpose when the user states it (a birthday dinner), or null.'
    ),
    selection: str(
      'single: one site, one answer; best: compare several sites and pick one; all: list everything from several sites.',
      { enum: ['single', 'best', 'all'] }
    ),
    location_needed: {
      type: 'boolean',
      description: 'true exactly when where.kind is current.',
    },
    language: str(
      'BCP 47 tag of the language the request is written in: en, de, es, fr, it, pt, sv, ru, uk, ja, ko, th, vi, zh-Hans (Simplified Chinese), zh-Hant (Traditional Chinese)… Everything shown to the user is written in it.'
    ),
  },
  required: [
    'language',
    'intent',
    'labels',
    'slots',
    'resultKind',
    'query',
    'what',
    'who',
    'how',
    'when',
    'where',
    'why',
    'selection',
    'location_needed',
  ],
};

// =============================================================================
// plan-search
// =============================================================================

const planSearchInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: intentInput,
    country: str("ISO 3166-1 alpha-2 of the user's region."),
    locale: str("BCP 47 locale of the user's device, e.g. en-US."),
  },
  required: ['request', 'intent'],
};

const planSearchOutput: Json = {
  type: 'object',
  properties: {
    search: {
      type: 'boolean',
      description:
        'true when a web search first would find the sites that have this specific thing (a named artist, team, show, product, place or brand); false for a generic request a site category answers (events near me, cheap flights, restaurants).',
    },
    country: str(
      "ISO 3166-1 alpha-2 of the region whose web to search, usually the user's country (CN searches Chinese sites); empty to search worldwide or when search is false."
    ),
    query: str(
      'The search query, short, in the language people in that region search in (e.g. "taylor swift tickets", "周杰伦 演唱会 门票" for CN). Empty when search is false.',
      { maxLength: 200 }
    ),
    reason: str('One short sentence: why searching first helps, or why not.', {
      maxLength: 300,
    }),
    sites: {
      type: 'array',
      description:
        "Domains of the best-known websites for this request in the user's region, most relevant first (e.g. lu.ma, eventbrite.com, meetup.com for tech events in San Francisco); at most 8. Empty for the user's own account data.",
      items: { type: 'string', maxLength: 100 },
      maxItems: 8,
    },
    target_country: str(
      'ISO 3166-1 alpha-2 of the country the request is about: the user\'s country, or the destination\'s when the request is about a place abroad ("Hamilton tickets in London" → GB); empty for something online or worldwide. Sites that do not serve it are left out.'
    ),
  },
  required: ['search', 'country', 'query', 'reason', 'sites', 'target_country'],
};

// =============================================================================
// rank-sites
// =============================================================================

const rankInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: intentInput,
    country: str("ISO 3166-1 alpha-2 of the user's region."),
    sites: {
      type: 'array',
      description: 'Candidate sites from the catalog.',
      items: {
        type: 'object',
        properties: {
          apiHost: str('API host; copy it exactly into the answer.'),
          title: str('Site name.'),
          description: str('What the site is.'),
          labels: { type: 'array', items: { type: 'string' } },
          toolCount: { type: 'integer', description: 'Number of API tools.' },
          searchHits: {
            type: 'array',
            description:
              'Web search results for the request that are on this site (title, URL, snippet). Present only when the request was searched first; a hit means the site has this specific thing.',
            items: {
              type: 'object',
              properties: {
                url: str('Result URL.'),
                title: str('Result title.'),
                snippet: str('Result snippet.'),
              },
              required: ['url', 'title'],
            },
          },
          canSearch: {
            type: 'boolean',
            description:
              "true when one of the site's tools takes keywords (q, query, search…), so it can search for exactly what was asked; false when it can only list or look up.",
          },
          tools: {
            type: 'array',
            description:
              "The site's API tools most relevant to the request: name, description and parameter names.",
            items: {
              type: 'object',
              properties: {
                name: str('Tool name.'),
                description: str('What it does.'),
                params: { type: 'array', items: { type: 'string' } },
              },
              required: ['name'],
            },
          },
        },
        required: ['apiHost', 'title'],
      },
    },
  },
  required: ['request', 'intent', 'sites'],
};

const rankOutput: Json = {
  type: 'object',
  properties: {
    sites: {
      type: 'array',
      description:
        'The sites that can really serve this request, best first. Leave unsuitable ones out.',
      items: {
        type: 'object',
        properties: {
          apiHost: str('Exactly as given in the input.'),
          reason: str(
            'One short sentence for the user: why this site fits the request.',
            { maxLength: 300 }
          ),
        },
        required: ['apiHost', 'reason'],
      },
      maxItems: 12,
    },
  },
  required: ['sites'],
};

// =============================================================================
// prepare-site
// =============================================================================

const prepareInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: intentInput,
    location,
    site,
    tools: {
      type: 'array',
      description: "The site's API tools, most likely useful first.",
      items: {
        type: 'object',
        properties: {
          name: str('Tool name.'),
          description: str('What it does.'),
          inputSchema: {
            type: 'object',
            description: 'JSON Schema of its arguments.',
          },
          auth: str(
            "none: works signed out; user: needs the user's account; api_key: needs a site key; unknown: not documented.",
            { enum: ['none', 'user', 'api_key', 'unknown'] }
          ),
        },
        required: ['name', 'description', 'auth'],
      },
    },
  },
  required: ['request', 'intent', 'site', 'tools'],
};

const formFieldOutput: Json = {
  type: 'object',
  properties: {
    name: str(
      'Canonical snake_case name: keyword, category, start_date, end_date, price_min, price_max, party_size, origin, destination, bedrooms...'
    ),
    label: str('Short label shown to the user.'),
    type: str('Input control.', {
      enum: [
        'text',
        'number',
        'date',
        'datetime',
        'select',
        'multiselect',
        'boolean',
      ],
    }),
    required: {
      type: 'boolean',
      description: 'true only when the tools cannot run without it.',
    },
    description: str('One line of help, optional.'),
    options: {
      type: 'array',
      description:
        'Choices for select/multiselect (from the tool schema enum).',
      items: {
        type: 'object',
        properties: {
          value: str('Value sent to the tool.'),
          label: str('Shown to the user.'),
        },
        required: ['value', 'label'],
      },
    },
    default: {
      description:
        'Prefilled value taken from the intent (string, number, boolean, or array of strings for multiselect).',
    },
  },
  required: ['name', 'label', 'type', 'required'],
};

const prepareOutput: Json = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      description:
        'Up to 6 tool names (exactly as listed) worth calling for this request, most useful first.',
      items: { type: 'string' },
      maxItems: 6,
    },
    login: str(
      "required: the request is about the user's own data/account, or every useful tool needs the user's account and is personal; fallback: tools are flagged user but the request is public, so try signed out first; none: no sign-in.",
      { enum: ['required', 'fallback', 'none'] }
    ),
    loginReason: str(
      'When login is not none: one short sentence for the user on why signing in helps.'
    ),
    unsupported: str(
      'Only when this site cannot serve the request at all: why, in one sentence. Otherwise omit it.'
    ),
    fields: {
      type: 'array',
      description:
        'Inputs to ask the user for: only what the chosen tools need that the intent does not already answer. Empty when nothing is missing.',
      items: formFieldOutput,
      maxItems: 8,
    },
  },
  required: ['tools', 'login', 'fields'],
};

// =============================================================================
// plan-calls
// =============================================================================

const planInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: str('Intent slug.'),
    query: str('Search query.'),
    what: str('The action.'),
    who: { type: 'object', description: 'Who it is for, or null.' },
    how: str('Constraints or preferences, or null.'),
    when: {
      type: 'object',
      description: 'When (text, start, end ISO 8601), or null.',
    },
    where: {
      type: 'object',
      description: 'Where (kind, places), or null.',
    },
    location,
    inputs: {
      type: 'object',
      description:
        "The user's answers to the prepared form, by field name. Use them as tool arguments.",
    },
    preferredTools: {
      type: 'array',
      description: 'Tools chosen for this request; prefer them.',
      items: { type: 'string' },
    },
    site,
    tools: {
      type: 'array',
      description: 'Every tool you may call (name, description, inputSchema).',
      items: { type: 'object' },
    },
    graphqlSchemas: {
      type: 'object',
      description:
        "For GraphQL tools: tool name → the site's schema as GraphQL SDL lines (root query fields with arguments, then the types and enums reachable from them). Write queries with exactly these field and argument names.",
      additionalProperties: { type: 'string' },
    },
    history: {
      type: 'array',
      description:
        'Calls made so far: tool, arguments, status (HTTP status or error), excerpt of the response.',
      items: { type: 'object' },
    },
  },
  required: ['request', 'intent', 'query', 'site', 'tools', 'history'],
};

const planOutput: Json = {
  type: 'object',
  properties: {
    done: {
      type: 'boolean',
      description:
        'true when the history already holds enough to answer (or nothing more can help).',
    },
    calls: {
      type: 'array',
      description: 'Up to 3 calls to make now; empty when done.',
      items: {
        type: 'object',
        properties: {
          tool: str('Tool name, exactly as listed.'),
          arguments: str(
            'The arguments as a JSON object encoded in a string, matching the tool inputSchema, e.g. {"q":"pad thai","limit":10}.'
          ),
          reason: str('Why this call, a few words.'),
        },
        required: ['tool', 'arguments'],
      },
      maxItems: 3,
    },
  },
  required: ['done', 'calls'],
};

// =============================================================================
// extract-results
// =============================================================================

const extractInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    resultKind: str('The kind of answer wanted.'),
    query: str('Search query.'),
    what: str('The action.'),
    how: str('Constraints or preferences, or null.'),
    when: {
      type: 'object',
      description: 'When (text, start, end ISO 8601), or null.',
    },
    where: {
      type: 'object',
      description: 'Where (kind, places), or null.',
    },
    inputs: {
      type: 'object',
      description: "The user's answers to the prepared form, by field name.",
    },
    location,
    site,
    language: str(
      "BCP 47 tag of the user's language (the request's): write summary, field labels and field values in it; keep titles and names as the site gives them."
    ),
    completeness: str(
      'How many items to return: every matching item, not a selection.'
    ),
    responses: {
      type: 'array',
      description: 'Successful API responses of this run.',
      items: {
        type: 'object',
        properties: {
          callId: str('Id of the call; copy it into ref.callId.'),
          tool: str('Tool that was called.'),
          endpoint: str('Its endpoint, e.g. GET /events/search.'),
          excerpt: str('The response body (JSON), possibly cut off.'),
        },
        required: ['callId', 'tool', 'endpoint', 'excerpt'],
      },
    },
  },
  required: ['request', 'resultKind', 'site', 'responses'],
};

const extractOutput: Json = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description:
        'Up to 10 results that answer the request, best first. Only things present in the responses.',
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          title: str('Name of the thing.'),
          summary: str('One or two sentences from the data.'),
          imageUrl: str(
            'An absolute image URL copied verbatim from the data, or empty.'
          ),
          sourceUrl: str(
            'An absolute URL copied verbatim from the data, or empty. Never build or guess one.'
          ),
          location: {
            type: 'object',
            description:
              'Coordinates when the data gives them for this result, else null.',
            properties: {
              latitude: { type: 'number', description: '-90 to 90.' },
              longitude: { type: 'number', description: '-180 to 180.' },
            },
            required: ['latitude', 'longitude'],
          },
          recipe: {
            type: 'object',
            description: 'For recipe results only; null otherwise.',
            properties: {
              ingredients: {
                type: 'array',
                description: 'With amounts, e.g. 200 g rice noodles.',
                items: { type: 'string' },
              },
              steps: {
                type: 'array',
                description: 'Steps in order.',
                items: { type: 'string' },
              },
              totalMinutes: {
                type: 'number',
                description: 'Total time in minutes, or null.',
              },
              servings: { type: 'number', description: 'Servings, or null.' },
            },
            required: ['ingredients', 'steps', 'totalMinutes', 'servings'],
          },
          fields: {
            type: 'array',
            description:
              'Key facts as label/value pairs (price, date, venue, rating...).',
            items: {
              type: 'object',
              properties: {
                label: str('e.g. Price.'),
                value: str('e.g. $25.'),
              },
              required: ['label', 'value'],
            },
          },
          ref: {
            type: 'object',
            description: 'Where this result is in the responses.',
            properties: {
              callId: str('callId of the response it came from.'),
              itemPath: str(
                'JSON path of the result object inside that body: dotted keys and [index] counted from 0, e.g. entries[3] or data.events[0]; empty string for the whole body.'
              ),
            },
            required: ['callId', 'itemPath'],
          },
        },
        required: [
          'title',
          'summary',
          'imageUrl',
          'sourceUrl',
          'location',
          'recipe',
          'fields',
          'ref',
        ],
      },
    },
  },
  required: ['items'],
};

// =============================================================================
// pick-best
// =============================================================================

const pickBestInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: intentInput,
    results: {
      type: 'array',
      description: 'Results from every site.',
      items: {
        type: 'object',
        properties: {
          id: str('Result id; copy it into bestId.'),
          siteTitle: str('Site it came from.'),
          title: str('Title.'),
          summary: str('Summary.'),
          fields: {
            type: 'array',
            items: { type: 'object' },
            description: 'label/value facts.',
          },
        },
        required: ['id', 'title'],
      },
    },
  },
  required: ['request', 'intent', 'results'],
};

const pickBestOutput: Json = {
  type: 'object',
  properties: {
    bestId: str('id of the single best result, exactly as given.'),
    reason: str(
      'One or two sentences for the user: why this one beats the others, citing the facts that decided it.'
    ),
  },
  required: ['bestId', 'reason'],
};

// =============================================================================
// dedupe-results
// =============================================================================

const dedupeInput: Json = {
  type: 'object',
  properties: {
    request: str("The user's request."),
    intent: intentInput,
    results: {
      type: 'array',
      description: 'Results from every site, in display order.',
      items: {
        type: 'object',
        properties: {
          id: str('Result id; copy it into members[].id.'),
          site: str('Site it came from.'),
          title: str('Title.'),
          summary: str('Summary.'),
          fields: {
            type: 'array',
            items: { type: 'object' },
            description: 'label/value facts.',
          },
        },
        required: ['id', 'title'],
      },
    },
  },
  required: ['request', 'intent', 'results'],
};

const dedupeOutput: Json = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      description:
        'Sets of results that are the same real-world thing. Only sets of two or more; results with no duplicate are left out.',
      items: {
        type: 'object',
        properties: {
          members: {
            type: 'array',
            description: 'The duplicates, each once.',
            items: {
              type: 'object',
              properties: {
                id: str('Result id, exactly as given.'),
                note: str(
                  'A few words that set this copy apart from the others (price, section, ticket type, seller, room), e.g. "$85 · GA". Empty when nothing differs.',
                  { maxLength: 120 }
                ),
              },
              required: ['id', 'note'],
            },
          },
        },
        required: ['members'],
      },
    },
  },
  required: ['groups'],
};

// =============================================================================
// site-regions
// =============================================================================

const siteRegionsInput: Json = {
  type: 'object',
  properties: {
    sites: {
      type: 'array',
      description: 'The websites to place, at most 40.',
      items: {
        type: 'object',
        properties: {
          domain: str('Registrable domain, e.g. africatickets.org.'),
          title: str("The site's name in the catalog."),
          description: str('What the site offers.'),
        },
        required: ['domain', 'title', 'description'],
      },
    },
  },
  required: ['sites'],
};

const siteRegionsOutput: Json = {
  type: 'object',
  properties: {
    sites: {
      type: 'array',
      description: 'One entry per input site, same domain.',
      items: {
        type: 'object',
        properties: {
          domain: str('The domain, copied exactly from the input.'),
          global: {
            type: 'boolean',
            description:
              'true when the site serves users in most countries (eventbrite.com, amazon.com, booking.com); false when it serves only some countries.',
          },
          countries: {
            type: 'array',
            description:
              'When global is false: ISO 3166-1 alpha-2 codes of the countries it serves (africatickets.org → ["NG","KE","GH","ZA",...]). Empty when global is true.',
            items: { type: 'string', maxLength: 2 },
          },
        },
        required: ['domain', 'global', 'countries'],
      },
    },
  },
  required: ['sites'],
};

/** Input and output JSON Schemas of every step's endpoint. */
export const STEP_SCHEMAS: Record<AgentStep, { input: Json; output: Json }> = {
  understand: { input: understandInput, output: understandOutput },
  'plan-search': { input: planSearchInput, output: planSearchOutput },
  'rank-sites': { input: rankInput, output: rankOutput },
  prepare: { input: prepareInput, output: prepareOutput },
  plan: { input: planInput, output: planOutput },
  extract: { input: extractInput, output: extractOutput },
  'pick-best': { input: pickBestInput, output: pickBestOutput },
  dedupe: { input: dedupeInput, output: dedupeOutput },
  'site-regions': { input: siteRegionsInput, output: siteRegionsOutput },
};

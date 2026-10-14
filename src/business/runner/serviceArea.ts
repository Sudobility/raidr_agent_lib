/**
 * Where a site serves people ({@link SiteServiceArea}), and the pure rules
 * around it: the domain a site is known by, what its country-code domain
 * already says, and whether it serves a given country.
 *
 * A site on a country-code domain (`ticketpro.co.za`, `sympla.com.br`) serves
 * that country; anything else (`africatickets.org`, `eventbrite.com`) is
 * classified once by the `site-regions` step and cached by the caller.
 */
import type {
  CandidateSite,
  SiteServiceArea,
} from '@sudobility/raidr_agent_types';

/**
 * Second-level labels under a country code that are a registry's own
 * (`co.uk`, `com.br`, `or.jp`): the registrable domain is one label deeper.
 */
const COUNTRY_SECOND_LEVELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gob',
  'gov',
  'gv',
  'ne',
  'net',
  'or',
  'org',
]);

/**
 * Country-code top-level domains used as generic ones: a `.io` or `.fm` site
 * says nothing about where it serves (`dice.fm` is not Micronesian).
 */
const GENERIC_COUNTRY_CODES = new Set([
  'ac',
  'ag',
  'ai',
  'am',
  'cc',
  'co',
  'fm',
  'gg',
  'gl',
  'im',
  'io',
  'is',
  'la',
  'ly',
  'me',
  'ms',
  'nu',
  'sh',
  'so',
  'st',
  'tk',
  'to',
  'tv',
  'vc',
  'ws',
]);

/** ccTLDs whose ISO 3166-1 code differs. */
const CCTLD_TO_ISO: Record<string, string> = { uk: 'GB' };

/**
 * The registrable domain of a host, lower-case and without `www.`:
 * `api.luma.com` → `luma.com`, `www.ticketpro.co.za` → `ticketpro.co.za`.
 * Approximate (no public-suffix list): two labels, or three under a
 * country's own second level (`co.za`, `com.br`).
 */
export function registrableDomain(host: string): string {
  const labels = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/:\d+$/, '')
    .split('.')
    .filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [second = '', tld = ''] = labels.slice(-2);
  const depth = tld.length === 2 && COUNTRY_SECOND_LEVELS.has(second) ? 3 : 2;
  return labels.slice(-depth).join('.');
}

/** The registrable domain a site is known by: its first origin's, else its API host's. */
export function siteRegistrableDomain(
  site: Pick<CandidateSite, 'apiHost' | 'siteOrigins'>
): string {
  for (const origin of site.siteOrigins) {
    try {
      return registrableDomain(new URL(origin).hostname);
    } catch {
      // Not a URL; try the next one.
    }
  }
  return registrableDomain(site.apiHost);
}

/**
 * The country a domain's country-code TLD says it serves (`co.za` → `ZA`,
 * `co.uk` → `GB`), or null for a generic or generic-use TLD (`.com`, `.io`).
 */
export function countryOfDomain(domain: string): string | null {
  const tld = domain.toLowerCase().split('.').pop() ?? '';
  if (!/^[a-z]{2}$/.test(tld) || GENERIC_COUNTRY_CODES.has(tld)) return null;
  if (tld === 'eu') return null;
  return CCTLD_TO_ISO[tld] ?? tld.toUpperCase();
}

/** The service area the domain alone tells, or null when only a classifier can. */
export function serviceAreaFromDomain(domain: string): SiteServiceArea | null {
  const country = countryOfDomain(domain);
  return country ? { domain, global: false, countries: [country] } : null;
}

/** Whether a site with `area` serves people in `country` (ISO alpha-2). */
export function servesCountry(area: SiteServiceArea, country: string): boolean {
  return area.global || area.countries.includes(country.toUpperCase());
}

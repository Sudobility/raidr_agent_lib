import { describe, expect, it } from 'vitest';
import {
  countryOfDomain,
  registrableDomain,
  serviceAreaFromDomain,
  servesCountry,
  siteRegistrableDomain,
} from './serviceArea';

describe('registrableDomain', () => {
  it('keeps two labels, or three under a country registry', () => {
    expect(registrableDomain('api.luma.com')).toBe('luma.com');
    expect(registrableDomain('WWW.ticketpro.co.za')).toBe('ticketpro.co.za');
    expect(registrableDomain('growthbook-cache.svc.sympla.com.br')).toBe(
      'sympla.com.br'
    );
    expect(registrableDomain('dice.fm')).toBe('dice.fm');
    expect(registrableDomain('api.example.com:8443')).toBe('example.com');
  });

  it('takes a site by its first origin, else its API host', () => {
    expect(
      siteRegistrableDomain({
        apiHost: 'api.luma.com',
        siteOrigins: ['https://www.luma.com'],
      })
    ).toBe('luma.com');
    expect(
      siteRegistrableDomain({ apiHost: 'api.kkday.com', siteOrigins: [] })
    ).toBe('kkday.com');
  });
});

describe('countryOfDomain / serviceAreaFromDomain', () => {
  it('reads a country-code domain, not a generic one', () => {
    expect(countryOfDomain('ticketpro.co.za')).toBe('ZA');
    expect(countryOfDomain('sympla.com.br')).toBe('BR');
    expect(countryOfDomain('billetto.co.uk')).toBe('GB');
    expect(countryOfDomain('eventbrite.com')).toBeNull();
    expect(countryOfDomain('dice.fm')).toBeNull();
    expect(countryOfDomain('lu.ma')).toBe('MA');
    expect(countryOfDomain('europa.eu')).toBeNull();
    expect(serviceAreaFromDomain('kktix.tw')).toEqual({
      domain: 'kktix.tw',
      global: false,
      countries: ['TW'],
    });
    expect(serviceAreaFromDomain('africatickets.org')).toBeNull();
  });
});

describe('servesCountry', () => {
  it('serves everywhere when global, else only its countries', () => {
    const za = { domain: 'ticketpro.co.za', global: false, countries: ['ZA'] };
    expect(servesCountry(za, 'za')).toBe(true);
    expect(servesCountry(za, 'US')).toBe(false);
    expect(
      servesCountry(
        { domain: 'eventbrite.com', global: true, countries: [] },
        'US'
      )
    ).toBe(true);
  });
});

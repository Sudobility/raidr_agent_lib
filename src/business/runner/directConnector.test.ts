import { describe, expect, it } from 'vitest';
import type { McpManifest } from '@sudobility/raidr_types';
import { DirectSiteConnector, type FetchLike } from './index';

const manifest: McpManifest = {
  schemaVersion: 1,
  apiHost: 'api.example.com',
  baseUrl: 'https://api.example.com/v1',
  siteOrigins: ['https://www.example.com'],
  title: 'Example',
  description: 'd',
  auth: { style: 'bearer' },
  tools: [
    {
      name: 'get_user',
      description: 'Fetch one user',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string' } },
      },
      request: { method: 'GET', pathTemplate: '/users/{userId}' },
    },
    {
      name: 'create_user',
      description: 'Create',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      request: { method: 'POST', pathTemplate: '/users', body: 'json' },
    },
  ],
  version: '1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: { bundleName: 'b', crawlerVersion: '1' },
};

type Seen = Parameters<FetchLike>;

function fakeFetch(
  respond: (url: string) => {
    status: number;
    body?: string;
    url?: string;
    location?: string;
  }
) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push([url, init]);
    const r = respond(url);
    return {
      status: r.status,
      ...(r.url ? { url: r.url } : {}),
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'location' ? (r.location ?? null) : null,
      },
      text: async () => r.body ?? '',
    };
  };
  return { fetch, seen };
}

const connector = (
  fetch: FetchLike,
  m: McpManifest = manifest,
  maxBytes?: number
) =>
  new DirectSiteConnector({
    catalog: { manifest: async () => m },
    fetch,
    ...(maxBytes ? { maxBytes } : {}),
  });

describe('DirectSiteConnector', () => {
  it('maps the call, sends the token to the site and returns the body', async () => {
    const { fetch, seen } = fakeFetch(() => ({
      status: 200,
      body: '{"id":7}',
    }));
    const session = await connector(fetch).open('api.example.com', 'tok');
    const result = await session.callTool('get_user', { userId: '7' });
    expect(result).toEqual({ ok: true, httpStatus: 200, text: '{"id":7}' });
    const [url, init] = seen[0]!;
    expect(url).toBe('https://api.example.com/v1/users/7');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.redirect).toBe('manual');
    await session.close();
  });

  it('sends a JSON body and reports non-2xx as not ok', async () => {
    const { fetch, seen } = fakeFetch(() => ({ status: 422, body: 'bad' }));
    const session = await connector(fetch).open('api.example.com');
    const result = await session.callTool('create_user', { name: 'A' });
    expect(result).toEqual({ ok: false, httpStatus: 422, text: 'bad' });
    expect(seen[0]![1].body).toBe('{"name":"A"}');
    expect(seen[0]![1].headers.Authorization).toBeUndefined();
  });

  it('truncates the body', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: 'x'.repeat(50) }));
    const session = await connector(fetch, manifest, 10).open(
      'api.example.com'
    );
    expect((await session.callTool('get_user', { userId: '1' })).text).toBe(
      'x'.repeat(10)
    );
  });

  it('never fetches for unknown tools, bad input or refused hosts', async () => {
    const { fetch, seen } = fakeFetch(() => ({ status: 200 }));
    const session = await connector(fetch).open('api.example.com', 'tok');
    expect(await session.callTool('nope', {})).toMatchObject({ ok: false });
    expect(await session.callTool('get_user', {})).toMatchObject({
      ok: false,
      text: expect.stringContaining('userId'),
    });
    const internal = {
      ...manifest,
      apiHost: '169.254.169.254',
      baseUrl: 'https://169.254.169.254',
    };
    const s2 = await connector(fetch, internal).open('169.254.169.254', 'tok');
    expect(await s2.callTool('get_user', { userId: '1' })).toMatchObject({
      ok: false,
      text: expect.stringContaining('private'),
    });
    const http = { ...manifest, baseUrl: 'http://api.example.com' };
    const s3 = await connector(fetch, http).open('api.example.com', 'tok');
    expect(await s3.callTool('get_user', { userId: '1' })).toMatchObject({
      ok: false,
    });
    expect(seen).toHaveLength(0);
  });

  it('refuses a manifest for another host', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200 }));
    await expect(connector(fetch).open('other.example.com')).rejects.toThrow(
      /other.example.com/
    );
  });

  it('does not follow or use redirects', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 302,
      location: 'https://evil.example/',
    }));
    const session = await connector(fetch).open('api.example.com', 'tok');
    expect(await session.callTool('get_user', { userId: '1' })).toMatchObject({
      ok: false,
      httpStatus: 302,
      text: expect.stringContaining('evil.example'),
    });
    const followed = fakeFetch(() => ({
      status: 200,
      body: 'secret',
      url: 'https://evil.example/x',
    }));
    const s2 = await connector(followed.fetch).open('api.example.com', 'tok');
    expect(await s2.callTool('get_user', { userId: '1' })).toMatchObject({
      ok: false,
    });
  });

  it('follows a GET redirect within the same site', async () => {
    const { fetch, seen } = fakeFetch(url =>
      url.startsWith('https://api.example.com/')
        ? { status: 301, location: 'https://www.example.com/api/users/1' }
        : { status: 200, body: '{"id":"1"}' }
    );
    const session = await connector(fetch).open('api.example.com', 'tok');
    expect(await session.callTool('get_user', { userId: '1' })).toMatchObject({
      ok: true,
      httpStatus: 200,
    });
    expect(seen.map(s => s[0])).toEqual([
      'https://api.example.com/v1/users/1',
      'https://www.example.com/api/users/1',
    ]);
  });

  it('turns a network error into a failed call', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('offline');
    };
    const session = await connector(fetch).open('api.example.com');
    expect(await session.callTool('get_user', { userId: '1' })).toEqual({
      ok: false,
      text: 'Upstream request failed: offline',
    });
  });
});

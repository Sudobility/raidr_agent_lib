/**
 * Calls a site's API straight from the device, for local runs: the user's
 * site token goes from the device to the site and nowhere else (not through
 * raidr_api's hosted MCP proxy, not through raidr_agent_api).
 *
 * Same mapping and refusals as the hosted proxy, from raidr_types:
 * `buildUpstreamRequest` maps the tool call, `assertSafeUpstream` refuses the
 * URL before the token is attached to a request, redirects are not followed,
 * and the body is cut at `MAX_UPSTREAM_BYTES`. Every failure is returned as
 * `{ ok: false, text }` (never thrown), so the planner sees the reason.
 */
import {
  assertSafeUpstream,
  buildUpstreamRequest,
  MAX_UPSTREAM_BYTES,
  parseHttpUrl,
} from '@sudobility/raidr_types';
import type {
  SiteCatalog,
  SiteConnector,
  ToolCallResult,
  ToolSession,
} from './runner';

/** The part of a `fetch` response this connector reads. */
export interface FetchResponseLike {
  status: number;
  /** The final URL, when the runtime reports it. */
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * The `fetch` this connector needs: the platform `fetch`, `expo/fetch`, or a
 * test fake. Typed loosely so any of them fits without a cast.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: 'manual';
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface DirectSiteConnectorOptions {
  /** Manifests (from `GET /sites/:apiHost/manifest`, cached by the caller). */
  catalog: SiteCatalog;
  fetch: FetchLike;
  /** Development only: allow plain http to localhost. Never in a release build. */
  allowLocalhost?: boolean;
  /** Per call (default 30 s). */
  timeoutMs?: number;
  /** Body cap in characters (default `MAX_UPSTREAM_BYTES`). */
  maxBytes?: number;
}

export class DirectSiteConnector implements SiteConnector {
  constructor(private readonly options: DirectSiteConnectorOptions) {}

  async open(apiHost: string, token?: string): Promise<ToolSession> {
    const manifest = await this.options.catalog.manifest(apiHost);
    if (manifest.apiHost.toLowerCase() !== apiHost.toLowerCase()) {
      throw new Error(`Manifest for ${apiHost} names ${manifest.apiHost}`);
    }
    const toolByName = new Map(manifest.tools.map(t => [t.name, t]));
    const {
      fetch,
      allowLocalhost = false,
      timeoutMs = 30_000,
      maxBytes = MAX_UPSTREAM_BYTES,
    } = this.options;
    const fail = (text: string, httpStatus?: number): ToolCallResult => ({
      ok: false,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      text,
    });

    return {
      async callTool(name, args) {
        const tool = toolByName.get(name);
        if (!tool) return fail(`Unknown tool ${name}`);
        let request;
        try {
          request = buildUpstreamRequest(manifest, tool, args, token);
          // Checked before fetch so the token is never sent to a refused host.
          assertSafeUpstream(request.url, manifest, { allowLocalhost });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }

        const controller =
          typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
        try {
          let url = request.url;
          let response: FetchResponseLike | null = null;
          for (let hop = 0; ; hop++) {
            response = await fetch(url, {
              method: request.method,
              headers: request.headers,
              ...(request.body !== undefined ? { body: request.body } : {}),
              // Followed by hand, and only within the same site: a 3xx
              // elsewhere could carry the token to a host the manifest
              // never named.
              redirect: 'manual',
              ...(controller ? { signal: controller.signal } : {}),
            });
            const { status } = response;
            if (status !== 0 && (status < 300 || status >= 400)) break;
            const location = response.headers.get('location');
            const next = location ? resolveLocation(url, location) : null;
            let safe = false;
            if (
              next &&
              request.method === 'GET' &&
              hop < MAX_REDIRECTS &&
              sameSite(url, next)
            ) {
              try {
                // Every other check still applies; the host may be the
                // site's other name (apex ↔ www), which sameSite confirmed.
                const target = parseHttpUrl(next);
                const host = target?.host ?? '';
                assertSafeUpstream(
                  next,
                  {
                    apiHost: host,
                    baseUrl: target ? `${target.protocol}://${host}` : '',
                  },
                  { allowLocalhost }
                );
                safe = true;
              } catch {
                safe = false;
              }
            }
            if (!safe || !next) {
              return fail(
                `HTTP ${status}: upstream redirected to ${location ?? '(no location)'}. Redirects to another site are not followed.`,
                status || undefined
              );
            }
            url = next;
          }
          if (!response) return fail('No response from the site');
          const { status } = response;
          // A runtime that followed a redirect anyway: only within the site.
          if (response.url && !sameSite(request.url, response.url)) {
            return fail(
              `HTTP ${status}: upstream redirected to ${parseHttpUrl(response.url)?.host ?? response.url}. Redirects to another site are not followed.`
            );
          }
          const body = await response.text();
          const text = body.length > maxBytes ? body.slice(0, maxBytes) : body;
          return {
            ok: status >= 200 && status < 300,
            httpStatus: status,
            text,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return fail(`Upstream request failed: ${message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      close: async () => undefined,
    };
  }
}

/** Most same-site redirects followed for one call. */
const MAX_REDIRECTS = 3;

/** A `Location` header resolved against the URL that answered with it (RN-safe: no `URL`). */
function resolveLocation(from: string, location: string): string | null {
  const value = location.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const base = parseHttpUrl(from);
  if (!base) return null;
  if (value.startsWith('//')) return `${base.protocol}:${value}`;
  if (value.startsWith('/')) return `${base.protocol}://${base.host}${value}`;
  return null;
}

/** `example.com`, `www.example.com` and their subdomains are one site; http may become https. */
function sameSite(from: string, to: string): boolean {
  const a = parseHttpUrl(from);
  const b = parseHttpUrl(to);
  if (!a || !b || b.hasCredentials) return false;
  if (b.protocol !== 'https' && b.protocol !== a.protocol) return false;
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');
  const x = bare(a.host);
  const y = bare(b.host);
  return x === y || y.endsWith(`.${x}`) || x.endsWith(`.${y}`);
}

/**
 * Decides, from the requests the WebView reports, when the user is signed in
 * and what their token is. Same rule as the raidr CLI and extension: a token
 * counts once a request carrying it to a signed-in-only endpoint answers 2xx;
 * with no such endpoints known, any 2xx will do. This keeps a guest token
 * (sent before sign-in) from being mistaken for a real one.
 *
 * It uses `extractCredential` and `matchesPathTemplate` from raidr_types, so
 * the "what is the token" logic lives in one place across all three callers.
 */
import {
  type CapturedCredential,
  type CredentialAuth,
  extractCredential,
  matchesPathTemplate,
} from '@sudobility/raidr_types';
import type { SiteAuthInfo } from '@sudobility/raidr_agent_types';
import type { ObservedRequest } from './captureScript';

export class TokenWatcher {
  /** Last token seen on any request to the host. */
  private last: string | null = null;
  private readonly auth: CredentialAuth;

  constructor(
    private readonly apiHost: string,
    auth: SiteAuthInfo['auth'],
    private readonly userPaths: string[]
  ) {
    // `extractCredential` reads the token off the request's headers/cookies.
    // A `query`-style site carries it in the URL query instead, which this
    // header/cookie watcher cannot observe, so it narrows to `none` here —
    // keeping `CredentialAuth` within the styles extractCredential supports
    // and making a query-style site a no-op for header extraction.
    const style = auth.style === 'query' ? 'none' : auth.style;
    this.auth = {
      style,
      ...(auth.headerName ? { headerName: auth.headerName } : {}),
      ...(auth.cookieName ? { cookieName: auth.cookieName } : {}),
      ...(auth.tokenPrefix ? { tokenPrefix: auth.tokenPrefix } : {}),
    };
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  private pathOf(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  }

  /**
   * Feed one observed request. Returns the credential when this request
   * proves the user is signed in, else null.
   */
  observe(request: ObservedRequest): CapturedCredential | null {
    if (this.hostOf(request.url) !== this.apiHost) return null;
    const token = extractCredential(request.headers, this.auth);
    if (!token) return null;
    this.last = token;
    if (request.status < 200 || request.status >= 300) return null;
    const path = this.pathOf(request.url);
    const signedInOnly =
      this.userPaths.length === 0 ||
      this.userPaths.some(template => matchesPathTemplate(template, path));
    return signedInOnly ? { token, verified: true } : null;
  }

  /**
   * A cookie-style site keeps its token in a cookie the page never sends as a
   * header, so it is read natively and offered here. Accepted only once a
   * signed-in-only request to the host has succeeded (`sawSignedInCall`).
   */
  observeCookieToken(
    token: string,
    sawSignedInCall: boolean
  ): CapturedCredential | null {
    if (!token) return null;
    this.last = token;
    return sawSignedInCall ? { token, verified: true } : null;
  }

  /**
   * The user closed the sign-in window. Returns the last token seen,
   * unverified, only when there is nothing to verify against (no known
   * signed-in-only endpoints); otherwise null, so a guest token is dropped.
   */
  onClosed(): CapturedCredential | null {
    return this.userPaths.length === 0 && this.last
      ? { token: this.last, verified: false }
      : null;
  }
}

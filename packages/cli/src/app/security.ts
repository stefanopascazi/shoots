/**
 * Request checks for the local app server.
 *
 * The server binds 127.0.0.1, but that alone does not stop a web page in the
 * same browser from talking to it: DNS rebinding points a foreign hostname at
 * 127.0.0.1, and any page can fire requests at localhost. Three checks close it:
 *
 * - the Host header must name this server (defeats rebinding),
 * - an Origin, when the browser sends one, must be this server (defeats CSRF),
 * - every API call carries the per-session token, as a cookie set when the
 *   browser opened the launch URL, or as a header for the plug-in.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'shoots_session';
export const TOKEN_HEADER = 'x-shoots-token';

export function createToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Loopback names the browser may legitimately use for this server. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.some((h) => host.toLowerCase() === `${h}:${port}`);
}

/** A missing Origin is fine (same-origin GETs, the plug-in); a present one must be ours. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return LOOPBACK_HOSTS.some((h) => origin.toLowerCase() === `http://${h}:${port}`);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Constant-time comparison, so the token cannot be guessed byte by byte. */
export function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

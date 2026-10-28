import { describe, expect, test } from 'bun:test';
import {
  createToken,
  isAllowedHost,
  isAllowedOrigin,
  readCookie,
  sessionCookie,
  tokenMatches,
} from '../../src/app/security.js';

describe('app security', () => {
  test('tokens are long and distinct', () => {
    const a = createToken();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(createToken());
  });

  test('only loopback names on our port pass the Host check', () => {
    expect(isAllowedHost('127.0.0.1:4000', 4000)).toBe(true);
    expect(isAllowedHost('localhost:4000', 4000)).toBe(true);
    expect(isAllowedHost('LOCALHOST:4000', 4000)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4001', 4000)).toBe(false);
    expect(isAllowedHost('evil.example:4000', 4000)).toBe(false);
    expect(isAllowedHost(undefined, 4000)).toBe(false);
  });

  test('a missing Origin passes, a foreign one does not', () => {
    expect(isAllowedOrigin(undefined, 4000)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4000', 4000)).toBe(true);
    expect(isAllowedOrigin('http://evil.example', 4000)).toBe(false);
    expect(isAllowedOrigin('null', 4000)).toBe(false);
  });

  test('reads one cookie among several', () => {
    expect(readCookie('a=1; shoots_session=abc%3D; b=2', 'shoots_session')).toBe('abc=');
    expect(readCookie('a=1', 'shoots_session')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
  });

  test('token comparison', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  test('the session cookie is HttpOnly and SameSite=Strict', () => {
    const c = sessionCookie('t');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
  });
});

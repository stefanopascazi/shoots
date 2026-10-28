/**
 * The page `shoots app` serves, resolved the way the CLI resolves it. Runs after
 * the build (npm test), since the page only exists in packages/app/dist.
 *
 * Through the bare `@shoots/app` Bun followed the tsconfig path to source, where
 * the page is only declared: the binary served an empty body, a blank window.
 */
import { describe, expect, test } from 'bun:test';

describe('@shoots/app/page', () => {
  test('is the built page, not an empty declaration', async () => {
    const { APP_HTML } = await import('@shoots/app/page');
    expect(typeof APP_HTML).toBe('string');
    expect(APP_HTML.length).toBeGreaterThan(10_000);
    expect(APP_HTML).toContain('<div id="root"></div>');
  });
});

/**
 * Single source of truth for the shoots version shown to users.
 *
 * The value is injected at build time from the root package.json — replaced as
 * a literal by both the tsup build (tsup.config.ts `define`) and the standalone
 * binary build (scripts/build-binary.ts `define`). Bump it with `npm version`,
 * which updates package.json, commits and tags in one step. The fallback only
 * applies when running straight from un-built sources.
 */
export const VERSION: string = process.env.SHOOTS_VERSION ?? '0.0.0-dev';

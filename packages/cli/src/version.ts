/**
 * Single source of truth for the build-time metadata shown to users.
 *
 * Both values are injected at build time from the root package.json — replaced
 * as literals by the tsup build (tsup.config.ts `define`) and the standalone
 * binary build (scripts/build-binary.ts `define`). Bump the version with
 * `npm version`, which updates package.json, commits and tags in one step. The
 * fallbacks only apply when running straight from un-built sources.
 */
export const VERSION: string = process.env.SHOOTS_VERSION ?? '0.0.0-dev';

/**
 * Author display name, parsed from the package.json `author` field
 * (`"Name <email> (url)"` → `"Name"`).
 */
export const AUTHOR: string = (process.env.SHOOTS_AUTHOR ?? '').replace(/\s*[<(].*$/, '').trim();

# webapp

The `shoots` marketing site and documentation portal — Next.js 16 (App Router,
Turbopack) + Tailwind CSS 4.

## Content is not authored here

The documentation rendered by this site **is** the repository documentation.
`scripts/sync-content.mjs` mirrors, into gitignored folders:

| Source | Destination |
| --- | --- |
| `../docs/**/*.md` | `content/docs/` |
| `../assets/` (PNG captures, logo) | `public/assets/` |
| `../package.json` version | `content/meta.json` |

It runs automatically on `predev`, `prebuild` and `pretypecheck`. **Never edit
`content/` or `public/assets/`** — change the markdown in `../docs/` instead, and
the next build rewrites them. Nothing is duplicated in git: a docs edit is one
diff, in `docs/`.

## Deploying

The build reads the monorepo root, so the deployment must expose it.

On **Vercel**: Root Directory `webapp`, and the Root Directory setting *Include
source files outside of the Root Directory in the Build Step* left **on** — it is
enabled by default for every project created after 2020-08-27. With it off,
`sync-content` fails immediately with an explicit message rather than building a
site with no documentation.

**Root Directory `webapp` is load-bearing, not cosmetic.** Vercel reads
`vercel.json` from the Root Directory and nowhere else, so with the setting left
empty this file is silently ignored — framework preset, ignore command and all —
and the deployment is whatever the dashboard overrides happen to say. Leave
*Build Command* and *Output Directory* on their defaults: with the Root Directory
correct, Vercel runs the `build` script of `webapp/package.json` and the Next.js
builder owns the output.

Two failure modes worth recognising, because neither is obvious from the log:

- Output Directory pointed at `webapp/public` — `next build` runs, the log prints
  the full route table, and Vercel then publishes `public/` as a static site. The
  deployment serves `/assets/*` and answers every real page with a plain-text
  platform 404 (`x-vercel-error: NOT_FOUND`), never the app's `not-found.tsx`.
- Root Directory empty with the Next.js preset — the build dies on
  `ENOENT … /vercel/path0/.next/package.json`, because Next writes `webapp/.next`
  while Vercel looks for `.next` at the repo root.

The framework is pinned here (`"framework": "nextjs"`) so the preset cannot drift
back once the Root Directory is right.

### When a deployment actually happens

`vercel.json` sets `ignoreCommand` to `scripts/vercel-ignore-build.mjs`, so a
push only redeploys the site when it touched something the site is built from:

| Path | Why |
| --- | --- |
| `webapp/` | the site itself |
| `docs/` | every documentation page |
| `assets/` | logo and terminal captures |
| `package.json` | the shoots version shown in the header and the sidebar |

Anything else — `packages/`, `scripts/`, `test/`, `.github/`, the installers —
skips the build. The script diffs `VERCEL_GIT_PREVIOUS_SHA` (the last
*successful* deployment for the branch, exposed only when an ignore command is
configured) against the pushed commit, and **fails safe**: no previous SHA, a
base outside Vercel's `--depth=10` clone, or any error at all means build. It
never stays silent when it cannot tell.

**Previews only.** A skipped build does not mean "keep serving the previous
deployment": Vercel creates the deployment anyway and collects whatever output is
on disk, which without `next build` is nothing. Promoted to production that is a
site where every route answers with a platform 404 — and with the Next.js preset
the collection step fails outright on `ENOENT … .next/package.json`. The script
therefore always builds when `VERCEL_ENV` is `production`, and always builds when
`VERCEL_GIT_PREVIOUS_SHA` equals the pushed commit, which is what a dashboard
redeploy looks like and would otherwise diff to nothing.

Two notes. Exit codes are inverted by Vercel's convention — `1` builds, `0`
skips. And a skipped build still counts against deployment quota and concurrent
build slots, because the ignore command runs inside the build step; Vercel's own
*Skip deployment* toggle (Root Directory settings, on by default) runs earlier
and does not, so leaving both enabled is the cheaper combination.

Every markdown file under `docs/` must also appear in `lib/docs/nav.ts`; the docs
layout asserts this and fails the build otherwise, so a new page can never end up
unreachable.

## Commands

```sh
npm run dev         # sync content, then next dev
npm run build       # sync content, then next build
npm run typecheck   # sync content, then tsc --noEmit
```

## Layout

```
app/
  page.tsx                    landing page
  docs/[...slug]/page.tsx     one static route per markdown file
  search-index.json/route.ts  static search corpus, fetched by ⌘K
components/
  home/      landing-page sections
  docs/      sidebar, table of contents, pager
  layout/    header, footer
  search/    ⌘K dialog and its provider
  ui/        shared primitives
lib/
  docs/      markdown pipeline, nav config, link rewriting
  search.ts  ranking used by the ⌘K dialog
```

Markdown is rendered at build time with unified (remark/rehype) and highlighted
by Shiki, so no markdown or highlighting code ships to the browser.

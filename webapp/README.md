# webapp

The `shoots` marketing site and documentation portal — Next.js 16 (App Router,
Turbopack) + Tailwind CSS 4.

## Content is not authored here

The documentation rendered by this site **is** the repository documentation.
`scripts/sync-content.mjs` mirrors, into gitignored folders:

| Source | Destination |
| --- | --- |
| `../docs/**/*.md` | `content/docs/` |
| `../README.md` | `content/README.md` |
| `../assets/` (PNG captures, logo) | `public/assets/` |
| `../package.json` version | `content/meta.json` |

It runs automatically on `predev`, `prebuild` and `pretypecheck`. **Never edit
`content/` or `public/assets/`** — change the markdown in `../docs/` instead, and
the next build rewrites them. Nothing is duplicated in git: a docs edit is one
diff, in `docs/`.

## Deploying

The build reads the monorepo root, so the deployment must expose it.

On **Vercel**: Root Directory `webapp`, framework Next.js, and the Root Directory
setting *Include source files outside of the Root Directory in the Build Step*
left **on** — it is enabled by default for every project created after
2020-08-27. With it off, `sync-content` fails immediately with an explicit
message rather than building a site with no documentation.

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

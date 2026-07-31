# webapp

The `shoots` marketing site and documentation portal — Next.js 16 (App Router,
Turbopack) + Tailwind CSS 4.

## Content is not authored here

The documentation rendered by this site **is** the repository documentation.
`scripts/sync-content.mjs` mirrors:

| Source | Destination |
| --- | --- |
| `../docs/**/*.md` | `content/docs/` |
| `../README.md` | `content/README.md` |
| `../assets/` (PNG captures, logo) | `public/assets/` |
| `../package.json` version | `content/meta.json` |

It runs automatically on `predev`, `prebuild` and `pretypecheck`. **Never edit
`content/` or `public/assets/`** — change the markdown in `../docs/` instead, and
the next build rewrites them.

### Why the snapshot is committed

Both folders are generated *and* committed. A Vercel project with a Root
Directory of `webapp` cannot rely on the parent: the Root Directory docs state
the app "will not be able to access files outside of that directory" and that
`..` cannot be used, and access to the rest of the monorepo is a dashboard
toggle (*Include source files outside of the Root Directory in the Build Step*).
Committing the snapshot means the site builds from `webapp/` alone, whatever that
toggle says. When the parent *is* available the prebuild sync just rewrites it
identically; when it is not, the script logs that it is using the snapshot and
carries on.

`npm run check-content` re-syncs and fails if the snapshot is stale — CI runs it,
so a docs edit can never ship without the site picking it up.

Every markdown file under `docs/` must also appear in `lib/docs/nav.ts`; the docs
layout asserts this and fails the build otherwise, so a new page can never end up
unreachable.

## Commands

```sh
npm run dev            # sync content, then next dev
npm run build          # sync content, then next build
npm run typecheck      # sync content, then tsc --noEmit
npm run check-content  # fail if the committed snapshot is stale (CI)
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

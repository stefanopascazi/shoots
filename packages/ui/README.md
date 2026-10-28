# @shoots/ui

The shoots design system: tokens, base styles and Preact components shared by
every shoots web app.

- **Dark by default**, light when the OS asks; force either with
  `data-theme="dark" | "light"` on `<html>` (`useTheme()` does it and remembers).
- **Tokens** are CSS custom properties prefixed `--sh-`; classes are prefixed
  `sh-`. Text/background pairings are checked against WCAG AA in both themes by
  `test/tokens.test.ts`.
- **No network**: no web fonts, no CDN, icons drawn in-house. Everything can be
  inlined into a page served by the single binary.

## Use

```ts
import { UI_CSS, Button, Slider } from '@shoots/ui';
// Inline UI_CSS in a <style>, or link dist/shoots-ui.css (`@shoots/ui/styles.css`).
```

Apps that are not Preact (e.g. the public site) can use the stylesheet and the
`sh-*` classes alone.

## Showcase

```sh
bun packages/ui/showcase/build.ts   # → packages/ui/dist/showcase.html
```

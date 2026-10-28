/** @jsxImportSource preact */
import { Section, Specimen } from '../Section.js';

const COLOR_GROUPS: Array<{ label: string; tokens: string[] }> = [
  { label: 'Surfaces', tokens: ['bg', 'surface', 'surface-2', 'surface-3', 'border', 'border-strong'] },
  { label: 'Text', tokens: ['fg', 'fg-muted', 'fg-subtle', 'accent-text'] },
  { label: 'Accent', tokens: ['accent', 'accent-hover', 'accent-soft', 'accent-fg'] },
  { label: 'Status', tokens: ['success', 'warning', 'danger', 'info'] },
];

const TYPE_SCALE = [
  ['3xl', 'Thirty-four, for one number'],
  ['2xl', 'Page titles'],
  ['xl', 'Section titles'],
  ['lg', 'Card and dialog titles'],
  ['md', 'Body text and controls — the default'],
  ['sm', 'Labels, captions, secondary text'],
  ['xs', 'Meta, badges, table headers'],
] as const;

const SPACE = [1, 2, 3, 4, 5, 6, 8, 10, 12];
const RADII = ['sm', 'md', 'lg', 'xl', 'full'];

export function Foundations() {
  return (
    <>
      <Section
        id="color"
        title="Colour"
        description="Near-grey neutrals so the interface never tints the photographs, and one warm accent from the logo. Every text pairing is checked against WCAG AA in both themes by the test suite."
      >
        <div class="sc-color-groups">
          {COLOR_GROUPS.map((g) => (
            <Specimen label={g.label}>
              <div class="sc-swatches">
                {g.tokens.map((t) => (
                  <div class="sc-swatch">
                    <div class="sc-swatch__chip" style={{ background: `var(--sh-${t})` }} />
                    <code>--sh-{t}</code>
                  </div>
                ))}
              </div>
            </Specimen>
          ))}
        </div>
      </Section>

      <Section id="type" title="Typography" description="System font stack: nothing to license or download. Numbers use tabular figures wherever they line up.">
        <div class="sc-type">
          {TYPE_SCALE.map(([size, text]) => (
            <div class="sc-type__row">
              <code class="sh-subtle">{size}</code>
              <span style={{ fontSize: `var(--sh-text-${size})`, fontWeight: size.includes('xl') ? 600 : 400 }}>{text}</span>
            </div>
          ))}
          <div class="sc-type__row">
            <code class="sh-subtle">mono</code>
            <span class="sh-mono sh-num">−1.35 EV · 5600 K · +12</span>
          </div>
        </div>
      </Section>

      <Section id="space" title="Space & shape" description="A 4px grid, four radii and a pill.">
        <div class="sc-split">
          <Specimen label="Spacing">
            <div class="sc-space">
              {SPACE.map((n) => (
                <div class="sc-space__row">
                  <code class="sh-subtle">{n}</code>
                  <span style={{ width: `var(--sh-space-${n})` }} />
                </div>
              ))}
            </div>
          </Specimen>
          <Specimen label="Radius">
            <div class="sh-row" style={{ '--sh-gap': '16px' }}>
              {RADII.map((r) => (
                <div class="sc-radius">
                  <span style={{ borderRadius: `var(--sh-radius-${r})` }} />
                  <code class="sh-subtle">{r}</code>
                </div>
              ))}
            </div>
          </Specimen>
        </div>
      </Section>
    </>
  );
}

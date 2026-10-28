/** @jsxImportSource preact */
import { LogoMark, Segmented, useTheme, type ThemePreference } from '../src/index.js';
import { AppPreview } from './sections/AppPreview.js';
import { Actions, Feedback, Forms } from './sections/Components.js';
import { Foundations } from './sections/Foundations.js';

const TOC = [
  ['app', 'In context'],
  ['color', 'Colour'],
  ['type', 'Type'],
  ['space', 'Space'],
  ['buttons', 'Buttons'],
  ['forms', 'Inputs'],
  ['feedback', 'Feedback'],
  ['data', 'Data'],
  ['nav', 'Navigation'],
] as const;

export function Showcase() {
  const [theme, setTheme] = useTheme();
  return (
    <div class="sc-page">
      <header class="sc-header">
        <div class="sc-header__inner">
          <LogoMark size={26} />
          <div>
            <div class="sc-header__title">shoots design system</div>
            <div class="sh-subtle" style={{ fontSize: 'var(--sh-text-xs)' }}>
              @shoots/ui · tokens, base styles, Preact components
            </div>
          </div>
          <span class="sh-spacer" />
          <Segmented<ThemePreference>
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
              { value: 'light', label: 'Light', icon: 'sun' },
            ]}
          />
        </div>
        <nav class="sc-toc" aria-label="Sections">
          {TOC.map(([id, label]) => (
            <a href={`#${id}`}>{label}</a>
          ))}
        </nav>
      </header>
      <main class="sc-main">
        <div class="sc-intro">
          <h1>Quiet interface, loud photographs.</h1>
          <p class="sh-muted">
            Dark by default because photographs are judged on a dark surround; light when the system asks. Near-grey
            neutrals, one amber accent from the mark, and nothing that competes with the picture.
          </p>
        </div>
        <AppPreview />
        <Foundations />
        <Actions />
        <Forms />
        <Feedback />
      </main>
    </div>
  );
}

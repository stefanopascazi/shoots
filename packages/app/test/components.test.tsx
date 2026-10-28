/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import { JobPanel } from '../src/library/JobPanel.js';
import { thumbUrl } from '../src/api/client.js';

describe('JobPanel', () => {
  test('shows counted progress', () => {
    const html = render(
      <JobPanel
        job={{ id: 'j', kind: 'rate', state: 'running', startedAt: 0, progress: { label: 'Rating', done: 3, total: 12 } }}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Rating photos');
    expect(html).toContain('3 of 12');
    expect(html).toContain('aria-valuenow="25"');
  });

  test('is indeterminate before the first progress line', () => {
    const html = render(<JobPanel job={{ id: 'j', kind: 'cull', state: 'running', startedAt: 0 }} onCancel={() => {}} />);
    expect(html).toContain('Starting');
    expect(html).toContain('sh-progress--indeterminate');
  });
});

describe('thumbUrl', () => {
  test('encodes Windows paths', () => {
    expect(thumbUrl('C:\\a b\\x.CR3', 400)).toBe('/api/thumb?path=C%3A%5Ca+b%5Cx.CR3&w=400');
  });
});

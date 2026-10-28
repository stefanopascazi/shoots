/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import { UI_CSS } from '../src/css.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  IconButton,
  LabelPicker,
  NavItem,
  PhotoTile,
  Progress,
  Segmented,
  Slider,
  StarRating,
  Switch,
  Tabs,
  clampFraction,
  clampStars,
  fillPercent,
} from '../src/index.js';

describe('Button', () => {
  test('secondary md carries only the base class', () => {
    expect(render(<Button>Go</Button>)).toContain('class="sh-btn"');
  });

  test('variant, size and block map to modifiers', () => {
    const html = render(<Button variant="primary" size="lg" block>Go</Button>);
    expect(html).toContain('sh-btn sh-btn--primary sh-btn--lg sh-btn--block');
  });

  test('loading disables and marks busy', () => {
    const html = render(<Button loading>Go</Button>);
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('sh-spinner');
  });

  test('defaults to type=button so it never submits a form by accident', () => {
    expect(render(<Button>Go</Button>)).toContain('type="button"');
  });

  test('IconButton is named by its label', () => {
    const html = render(<IconButton icon="x" label="Close" />);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('sh-btn--icon');
  });
});

describe('Slider', () => {
  test('fillPercent clamps and handles a degenerate range', () => {
    expect(fillPercent(5, 0, 10)).toBe('50%');
    expect(fillPercent(-3, 0, 10)).toBe('0%');
    expect(fillPercent(30, 0, 10)).toBe('100%');
    expect(fillPercent(1, 2, 2)).toBe('0%');
  });

  test('shows the formatted value and the ends', () => {
    const html = render(<Slider id="ev" label="Exposure" value={0.5} min={-2} max={2} format={(v) => `${v} EV`} />);
    expect(html).toContain('0.5 EV');
    expect(html).toContain('-2 EV');
    expect(html).toContain('--sh-fill:62.5%');
  });
});

describe('StarRating', () => {
  test('clampStars rounds into 0..5', () => {
    expect(clampStars(3.6)).toBe(4);
    expect(clampStars(9)).toBe(5);
    expect(clampStars(-1)).toBe(0);
    expect(clampStars(Number.NaN)).toBe(0);
  });

  test('read-only rating is one labelled image', () => {
    const html = render(<StarRating value={3} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('3 of 5 stars');
    expect(html.match(/sh-stars__star--off/g)?.length).toBe(2);
  });

  test('editable rating renders five buttons', () => {
    const html = render(<StarRating value={2} onChange={() => {}} />);
    expect(html.match(/<button/g)?.length).toBe(5);
  });
});

describe('Progress', () => {
  test('clampFraction', () => {
    expect(clampFraction(1.4)).toBe(1);
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('determinate bar reports its percentage', () => {
    const html = render(<Progress value={0.42} label="Rating" />);
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('42%');
  });

  test('indeterminate bar has no value', () => {
    const html = render(<Progress />);
    expect(html).toContain('sh-progress--indeterminate');
    expect(html).not.toContain('aria-valuenow');
  });
});

describe('stateful controls expose their state to assistive tech', () => {
  test('Switch', () => {
    expect(render(<Switch checked />)).toContain('aria-checked="true"');
    expect(render(<Switch checked={false} />)).toContain('aria-checked="false"');
  });

  test('Segmented marks exactly one option', () => {
    const html = render(
      <Segmented
        label="View"
        value="grid"
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
      />,
    );
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
  });

  test('Tabs marks the selected tab', () => {
    const html = render(
      <Tabs
        label="Sections"
        value="b"
        items={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>B</);
  });

  test('NavItem marks the current page', () => {
    expect(render(<NavItem active>Home</NavItem>)).toContain('aria-current="page"');
    expect(render(<NavItem href="/x">X</NavItem>)).toContain('href="/x"');
  });
});

describe('content components', () => {
  test('Badge tone', () => {
    expect(render(<Badge tone="success">ok</Badge>)).toContain('sh-badge sh-badge--success');
  });

  test('a danger Alert interrupts, others do not', () => {
    expect(render(<Alert tone="danger">x</Alert>)).toContain('role="alert"');
    expect(render(<Alert tone="info">x</Alert>)).toContain('role="status"');
  });

  test('Card wraps children in a body unless flush', () => {
    expect(render(<Card title="T">x</Card>)).toContain('sh-card__body');
    expect(render(<Card flush>x</Card>)).not.toContain('sh-card__body');
  });

  test('PhotoTile shows flag, rating and selection', () => {
    const html = render(<PhotoTile name="a.cr3" flag="rejected" rating={4} selected />);
    expect(html).toContain('sh-photo--rejected');
    expect(html).toContain('Rejected');
    expect(html).toContain('4 of 5 stars');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('sh-photo__placeholder');
  });

  test('PhotoTile marks a frame awaiting review', () => {
    const html = render(<PhotoTile name="a.cr3" flag="review" />);
    expect(html).toContain('sh-badge--warning');
    expect(html).toContain('Review');
  });
});

describe('photo marks', () => {
  test('LabelPicker marks the chosen label and names every swatch', () => {
    const html = render(<LabelPicker value="green" onChange={() => {}} keys={{ red: '6' }} />);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Purple"');
    expect(html).toContain('title="Red (6)"');
  });

  test('PhotoTile shows the colour label as a strip', () => {
    expect(render(<PhotoTile name="a" label="red" />)).toContain('sh-photo__label--red');
    expect(render(<PhotoTile name="a" />)).not.toContain('sh-photo__label');
  });

  test('Checkbox is a native, labelled checkbox', () => {
    const html = render(<Checkbox checked hint="why">Blur check</Checkbox>);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('why');
  });
});

describe('every class a component renders is styled', () => {
  const samples = [
    <Button variant="danger" size="sm" icon="trash" loading>
      x
    </Button>,
    <IconButton icon="x" label="x" size="lg" />,
    <Alert tone="warning" title="t" action={<span />}>
      b
    </Alert>,
    <Badge tone="info" dot>
      x
    </Badge>,
    <Progress value={0.5} label="x" />,
    <Progress />,
    <Slider label="x" value={1} min={0} max={2} />,
    <Switch checked>x</Switch>,
    <Segmented label="x" value="a" options={[{ value: 'a', label: 'A', icon: 'grid' }]} />,
    <Tabs label="x" value="a" items={[{ value: 'a', label: 'A' }]} />,
    <Card title="t" description="d" actions={<span />} footer={<span />}>
      x
    </Card>,
    <NavItem icon="image" count={3}>
      x
    </NavItem>,
    <PhotoTile name="x" src="/a.jpg" flag="pick" rating={2} />,
    <StarRating value={2} onChange={() => {}} />,
    <LabelPicker value="red" onChange={() => {}} />,
    <PhotoTile name="x" label="purple" />,
    <Checkbox checked={false} hint="h" disabled>
      x
    </Checkbox>,
  ];

  test('no orphan sh-* class', () => {
    const used = new Set(
      samples.flatMap((s) => [...render(s).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(' '))),
    );
    const missing = [...used].filter((c) => c.startsWith('sh-') && !UI_CSS.includes(`.${c}`));
    expect(missing).toEqual([]);
  });
});

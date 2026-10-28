/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Progress,
  Segmented,
  Select,
  Slider,
  Stat,
  Switch,
  Tabs,
  Textarea,
} from '../../src/index.js';
import { Section, Specimen } from '../Section.js';

const signed = (v: number, digits: number, unit: string) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}${unit}`;

export function Actions() {
  const [busy, setBusy] = useState(false);
  return (
    <Section id="buttons" title="Buttons" description="One primary action per view. Secondary for the rest, ghost inside toolbars.">
      <div class="sc-grid-2">
        <Specimen label="Variants">
          <div class="sh-row">
            <Button variant="primary" icon="sparkle">Rate selection</Button>
            <Button icon="download">Export</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger" icon="trash">Delete profile</Button>
          </div>
        </Specimen>
        <Specimen label="Sizes, icon-only, loading">
          <div class="sh-row">
            <Button size="sm">Small</Button>
            <Button>Medium</Button>
            <Button size="lg">Large</Button>
            <IconButton icon="settings" label="Settings" />
            <IconButton icon="more" label="More" variant="secondary" />
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1600);
              }}
            >
              {busy ? 'Training…' : 'Train'}
            </Button>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}

export function Forms() {
  const [ev, setEv] = useState(-0.35);
  const [temp, setTemp] = useState(5400);
  const [bold, setBold] = useState(1);
  const [keywords, setKeywords] = useState(true);
  const [flag, setFlag] = useState(false);
  const [treatment, setTreatment] = useState<'color' | 'bw'>('color');
  return (
    <Section id="forms" title="Inputs" description="Sliders read in the parameter's own units — what will land in Lightroom, not a multiplier.">
      <div class="sc-grid-2">
        <Card title="Calibrate" description="Exposure correction for this profile">
          <div class="sh-stack" style={{ '--sh-gap': '22px' }}>
            <Segmented
              label="Treatment"
              value={treatment}
              onChange={setTreatment}
              options={[
                { value: 'color', label: 'Colour' },
                { value: 'bw', label: 'Black & white' },
              ]}
            />
            <Slider id="ev" label="Exposure" value={ev} min={-2} max={2} step={0.05} onChange={setEv} format={(v) => signed(v, 2, ' EV')} />
            <Slider id="temp" label="Temperature" value={temp} min={2500} max={9000} step={50} onChange={setTemp} format={(v) => `${v} K`} />
            <Slider id="bold" label="Boldness" value={bold} min={0} max={2} step={0.1} onChange={setBold} format={(v) => v.toFixed(1)} />
          </div>
        </Card>
        <Card title="Rate settings">
          <div class="sh-stack">
            <Field label="Profile" htmlFor="profile" hint="Trained on 553 photographs from 32 shoots.">
              <Select id="profile">
                <option>My style — 2026</option>
                <option>Weddings</option>
              </Select>
            </Field>
            <Field label="Keyword prefix" htmlFor="kw">
              <Input id="kw" placeholder="shoots/" />
            </Field>
            <Field label="Output folder" htmlFor="out" error="This folder does not exist.">
              <Input id="out" value="D:\Exports\missing" invalid />
            </Field>
            <Field label="Notes" htmlFor="notes">
              <Textarea id="notes" placeholder="Anything worth remembering about this shoot" />
            </Field>
            <Switch checked={keywords} onChange={setKeywords}>
              Write keywords into the catalog
            </Switch>
            <Switch checked={flag} onChange={setFlag}>
              Flag keepers as picks
            </Switch>
          </div>
        </Card>
      </div>
    </Section>
  );
}

export function Feedback() {
  const [tab, setTab] = useState('overview');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Section id="feedback" title="Status & feedback">
        <div class="sc-grid-2">
          <Specimen label="Badges">
            <div class="sh-row">
              <Badge>Draft</Badge>
              <Badge tone="accent">Predicted</Badge>
              <Badge tone="success" dot>Running</Badge>
              <Badge tone="warning">Leveled</Badge>
              <Badge tone="danger">Rejected</Badge>
              <Badge tone="info">Beta</Badge>
            </div>
          </Specimen>
          <Specimen label="Progress">
            <div class="sh-stack">
              <Progress value={0.62} label="Rating 412 of 664" />
              <Progress label="Decoding RAW files" detail="estimating…" />
            </div>
          </Specimen>
        </div>
        <div class="sh-stack" style={{ marginTop: '16px', '--sh-gap': '10px' }}>
          <Alert tone="info" title="Lightroom is connected">Changes are applied through the plug-in as one undo step.</Alert>
          <Alert tone="success" title="Profile trained">18 parameters predicted, 3 leveled, 56 kept at your average.</Alert>
          <Alert tone="warning" title="Small sample" action={<Button size="sm">Learn more</Button>}>
            Only 11 black-and-white shoots carry four frames or more.
          </Alert>
          <Alert tone="danger" title="Server stopped">The plug-in did not answer for 5 minutes.</Alert>
        </div>
      </Section>

      <Section id="data" title="Data display">
        <Card flush>
          <div class="sc-stats">
            <Stat label="Photos" value="664" hint="12 shoots" />
            <Stat label="Kept" value="71" unit="%" hint="+4 vs last shoot" hintTone="success" />
            <Stat label="Blurry" value="38" hint="rejected" />
            <Stat label="Within-shoot skill" value="9.3" unit="%" hint="Exposure" />
          </div>
        </Card>
        <div class="sc-grid-2" style={{ marginTop: '16px' }}>
          <Card title="Parameters" description="What the profile does with each slider" flush>
            <table class="sh-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>State</th>
                  <th class="sh-num">Skill</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Exposure</td>
                  <td><Badge tone="accent">Predicted</Badge></td>
                  <td class="sh-num">9.3%</td>
                </tr>
                <tr>
                  <td>Highlights</td>
                  <td><Badge tone="accent">Predicted</Badge></td>
                  <td class="sh-num">3.3%</td>
                </tr>
                <tr>
                  <td>Contrast</td>
                  <td><Badge tone="warning">Leveled</Badge></td>
                  <td class="sh-num">−0.9%</td>
                </tr>
                <tr>
                  <td>Vibrance</td>
                  <td><Badge>Constant</Badge></td>
                  <td class="sh-num">—</td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Card>
            <EmptyState
              icon="folder"
              title="No catalog export yet"
              description="Export from Lightroom with File › Plug-in Extras › Export for shoots, then come back here."
              actions={<Button icon="refresh">Check again</Button>}
            />
          </Card>
        </div>
      </Section>

      <Section id="nav" title="Navigation & overlays">
        <div class="sc-grid-2">
          <Specimen label="Tabs">
            <Tabs
              label="Profile sections"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'overview', label: 'Overview' },
                { value: 'params', label: 'Parameters' },
                { value: 'history', label: 'History' },
              ]}
            />
          </Specimen>
          <Specimen label="Dialog, tooltip, keys">
            <div class="sh-row">
              <Button onClick={() => setOpen(true)}>Open dialog</Button>
              <span data-sh-tip="Kept at your average" tabIndex={0}>
                <Badge>Hover me</Badge>
              </span>
              <span class="sh-muted sh-row" style={{ '--sh-gap': '4px' }}>
                <Kbd>←</Kbd>
                <Kbd>→</Kbd> move · <Kbd>0</Kbd>–<Kbd>5</Kbd> rate · <Kbd>X</Kbd> reject
              </span>
            </div>
          </Specimen>
        </div>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Retrain the profile?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Retrain
              </Button>
            </>
          }
        >
          Training reads the latest catalog export. It takes about 25 seconds and replaces the calibration.
        </Dialog>
      </Section>
    </>
  );
}

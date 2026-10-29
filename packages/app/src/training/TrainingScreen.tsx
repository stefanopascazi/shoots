/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { Alert, Button, Card, Checkbox, PageHeader } from '@shoots/ui';
import type { CatalogInspection } from '../contract.js';
import type { SettingsHandle } from '../hooks/useSettings.js';
import { FolderPicker } from '../library/FolderPicker.js';
import { CatalogReportCard } from './CatalogReportCard.js';
import { outcome, profileSummary } from './model.js';
import { PendingShootsCard } from './PendingShootsCard.js';
import { ProfileCard } from './ProfileCard.js';
import { TrainingJobCard } from './TrainingJobCard.js';
import { useTraining } from './useTraining.js';

/**
 * Learning the photographer's develop style, and setting how strongly it corrects.
 * Both run detached on the server: closing Lightroom does not stop them.
 */
export function TrainingScreen({ prefs }: { prefs: SettingsHandle }) {
  const { job, status, pending, run } = useTraining();
  const [folder, setFolder] = useState<string | null>(prefs.settings.lastFolder);
  const [recursive, setRecursive] = useState(prefs.settings.recursive);
  const [picking, setPicking] = useState(false);

  const profile = profileSummary(status);
  const current = job.job;
  const running = current?.state === 'running';
  const ended = outcome(current);
  const report = current?.kind === 'catalog' && current.state === 'done' ? (current.result as CatalogInspection) : undefined;

  return (
    <>
      <PageHeader title="Training" description="Teach shoots how you develop, from photos you have already edited in Lightroom." />
      {running && current && <TrainingJobCard job={current} onCancel={job.cancel} />}
      {ended && !running && (
        <Alert tone={ended.tone} title={ended.title}>
          {ended.text}
        </Alert>
      )}
      {report && <CatalogReportCard report={report} />}
      <PendingShootsCard shoots={pending} disabled={!profile || running} onImprove={(f) => run({ kind: 'refine', folder: f })} />
      <div class="app-health">
        <div class="app-side">
          <Card
            title="Learn from a folder"
            description="Your develop settings are read from the Lightroom catalog. Training runs on this computer and can take hours; it carries on if you close Lightroom."
            footer={
              <div class="app-training__actions">
                <Button
                  variant="primary"
                  icon="sparkle"
                  disabled={!folder || running}
                  onClick={() => folder && run({ kind: 'train', folder, recursive })}
                >
                  Start training
                </Button>
                {/* Field test: what Lightroom returns, checked against the engine, without training. */}
                <Button variant="ghost" icon="download" disabled={!folder || running} onClick={() => folder && run({ kind: 'catalog', folder, recursive })}>
                  Export only
                </Button>
              </div>
            }
          >
            <div class="app-training__folder">
              <code class="app-training__path">{folder ?? 'No folder chosen'}</code>
              <Button size="sm" icon="folder" onClick={() => setPicking(true)} disabled={running}>
                Choose…
              </Button>
            </div>
            <Checkbox checked={recursive} onChange={setRecursive} disabled={running}>
              Include subfolders
            </Checkbox>
          </Card>
          <Card
            title="Improve from a developed shoot"
            description="After Develop Selection and your own finishing touches in Lightroom, shoots compares what you kept with what it predicted and learns from the difference. Uses the folder above."
            footer={
              <Button icon="refresh" disabled={!profile || !folder || running} onClick={() => folder && run({ kind: 'refine', folder })}>
                Improve profile
              </Button>
            }
          />
          <Card
            title="Calibrate"
            description="Set by eye how strongly the profile corrects exposure and tone. Opens a page with a few of your photos."
            footer={
              <Button icon="sliders" disabled={!profile || running} onClick={() => run({ kind: 'calibrate' })}>
                Calibrate
              </Button>
            }
          />
        </div>
        <ProfileCard profile={profile} />
      </div>
      <FolderPicker
        open={picking}
        start={folder}
        onClose={() => setPicking(false)}
        onPick={(f) => {
          setPicking(false);
          setFolder(f);
        }}
      />
    </>
  );
}

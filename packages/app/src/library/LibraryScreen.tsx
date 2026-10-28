/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  PhotoGrid,
  PhotoTile,
  Segmented,
  Select,
  Spinner,
  Stat,
  Switch,
} from '@shoots/ui';
import { api, thumbUrl } from '../api/client.js';
import type { CullReport, RateReport, RatingProfile } from '../contract.js';
import { useJob } from '../hooks/useJob.js';
import { FolderPicker } from './FolderPicker.js';
import { JobPanel } from './JobPanel.js';
import { folderName, totals, visible, type Filter, type Sort } from './model.js';
import { PhotoViewer } from './PhotoViewer.js';
import { useLibrary } from './useLibrary.js';

export function LibraryScreen({ windows }: { windows: boolean }) {
  const lib = useLibrary(windows);
  const job = useJob();
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [viewing, setViewing] = useState<number>();
  const [profiles, setProfiles] = useState<RatingProfile[]>([]);
  const [profile, setProfile] = useState<string>();

  useEffect(() => {
    api.profiles().then(
      (list) => {
        setProfiles(list);
        setProfile((p) => p ?? list.find((x) => x.learned)?.name ?? list[0]?.name);
      },
      () => {},
    );
  }, []);

  const shown = useMemo(() => visible(lib.photos, filter, sort), [lib.photos, filter, sort]);
  const sum = useMemo(() => totals(lib.photos), [lib.photos]);

  const run = async (kind: 'cull' | 'rate') => {
    if (!lib.listing) return;
    const done = await job.start({ kind, folder: lib.listing.folder, recursive: lib.recursive, profile });
    if (done?.state !== 'done') return;
    if (kind === 'cull') lib.setCull(done.result as CullReport);
    else {
      lib.setRate(done.result as RateReport);
      setSort('rating');
    }
  };

  const picker = (
    <FolderPicker
      open={picking}
      start={lib.listing?.folder ?? null}
      onClose={() => setPicking(false)}
      onPick={(f) => {
        setPicking(false);
        setFilter('all');
        lib.open(f);
      }}
    />
  );

  if (!lib.folder) {
    return (
      <>
        <Card>
          <EmptyState
            icon="folder"
            title="Open a folder of photographs"
            description="shoots looks for blurry frames and rates the rest. Nothing is written to your photos; results go back to Lightroom through the plug-in."
            actions={
              <Button variant="primary" icon="folder" onClick={() => setPicking(true)}>
                Choose a folder
              </Button>
            }
          />
        </Card>
        {picker}
      </>
    );
  }

  const busy = job.running || lib.loading;
  return (
    <>
      <PageHeader
        eyebrow={lib.listing ? `${lib.listing.folder}` : lib.folder}
        title={folderName(lib.listing?.folder ?? lib.folder)}
        actions={
          <>
            <Button icon="folder" onClick={() => setPicking(true)} disabled={job.running}>
              Change folder
            </Button>
            <Button icon="eye" onClick={() => run('cull')} disabled={busy || !sum.total}>
              Find blurry
            </Button>
            <Button variant="primary" icon="star" onClick={() => run('rate')} disabled={busy || !sum.total}>
              Rate
            </Button>
          </>
        }
      />

      <div class="app-toolbar">
        <Switch checked={lib.recursive} onChange={lib.setRecursive} disabled={busy}>
          Include subfolders
        </Switch>
        {profiles.length > 0 && (
          <label class="app-inline-field">
            <span class="sh-muted">Rating profile</span>
            <Select id="profile" value={profile} onChange={(e) => setProfile((e.currentTarget as HTMLSelectElement).value)} disabled={busy}>
              {profiles.map((p) => (
                <option value={p.name}>
                  {p.name}
                  {p.learned ? ' (yours)' : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        {lib.recent.length > 1 && (
          <label class="app-inline-field">
            <span class="sh-muted">Recent</span>
            <Select
              id="recent"
              value=""
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                if (v) lib.open(v);
              }}
              disabled={busy}
            >
              <option value="">Open a recent folder…</option>
              {lib.recent.slice(1).map((f) => (
                <option value={f}>{f}</option>
              ))}
            </Select>
          </label>
        )}
      </div>

      {lib.error && <Alert tone="danger" title="Could not open this folder">{lib.error}</Alert>}
      {job.error && !job.running && <Alert tone="danger" title="The job did not finish">{job.error}</Alert>}
      {job.running && job.job && <JobPanel job={job.job} onCancel={job.cancel} />}

      {lib.loading && !lib.listing ? (
        <div class="app-center">
          <Spinner size={22} label="Loading photos" />
        </div>
      ) : lib.listing && sum.total === 0 ? (
        <Card>
          <EmptyState
            icon="image"
            title="No photographs in this folder"
            description={lib.recursive ? 'Neither here nor in any subfolder.' : 'Try including subfolders, or choose another folder.'}
          />
        </Card>
      ) : (
        lib.listing && (
          <>
            <Card flush class="app-summary">
              <Stat label="Photos" value={sum.total} hint={lib.recursive ? 'with subfolders' : 'in this folder'} />
              <Stat
                label="Blurry"
                value={sum.checked ? sum.blurry : '—'}
                hint={sum.checked ? `of ${sum.checked} checked` : 'not checked yet'}
                hintTone={sum.blurry ? 'danger' : 'neutral'}
              />
              <Stat label="Rated" value={sum.rated || '—'} hint={sum.rated ? `profile ${profile ?? ''}` : 'not rated yet'} />
              <Stat label="Average" value={sum.meanStars === undefined ? '—' : sum.meanStars.toFixed(1)} unit={sum.meanStars === undefined ? undefined : '★'} hint="stars" />
            </Card>

            <div class="app-toolbar">
              <Segmented
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `All ${sum.total}` },
                  { value: 'keepers', label: `Keepers ${sum.total - sum.blurry}` },
                  { value: 'blurry', label: `Blurry ${sum.blurry}` },
                ]}
              />
              <span class="sh-spacer" />
              <Segmented
                label="Sort"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'name', label: 'Name' },
                  { value: 'rating', label: 'Rating' },
                ]}
              />
            </div>

            {shown.length === 0 ? (
              <p class="sh-muted app-center">Nothing matches this filter.</p>
            ) : (
              <PhotoGrid thumb={190}>
                {shown.map((p, i) => (
                  <PhotoTile
                    key={p.path}
                    src={thumbUrl(p.path, 400)}
                    name={p.name}
                    rating={p.stars}
                    flag={p.blur ? (p.blur.verdict === 'blurry' ? 'rejected' : undefined) : undefined}
                    onClick={() => setViewing(i)}
                  />
                ))}
              </PhotoGrid>
            )}
          </>
        )
      )}

      {viewing !== undefined && <PhotoViewer photos={shown} index={viewing} onIndex={setViewing} onClose={() => setViewing(undefined)} />}
      {picker}
    </>
  );
}

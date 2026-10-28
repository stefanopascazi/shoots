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
import type { SettingsHandle } from '../hooks/useSettings.js';
import { FolderPicker } from './FolderPicker.js';
import { JobPanel } from './JobPanel.js';
import { awaitsReview, flagFor, folderName, sendSummary, totals, visible, type Filter, type Sort } from './model.js';
import { PhotoViewer } from './PhotoViewer.js';
import { useLibrary, type LibraryStart } from './useLibrary.js';

export interface LibraryScreenProps {
  windows: boolean;
  start: LibraryStart;
  prefs: SettingsHandle;
}

export function LibraryScreen({ windows, start, prefs }: LibraryScreenProps) {
  const lib = useLibrary(windows, start);
  const job = useJob();
  const [picking, setPicking] = useState(false);
  const { filter, sort } = prefs.settings;
  const setFilter = (v: Filter) => prefs.update({ filter: v });
  const setSort = (v: Sort) => prefs.update({ sort: v });
  // The viewer walks a fixed list of paths, so deciding a frame never reshuffles what comes next.
  const [viewer, setViewer] = useState<{ paths: string[]; index: number; review: boolean }>();
  const [profiles, setProfiles] = useState<RatingProfile[]>([]);
  const [defaultProfile, setDefaultProfile] = useState<string>();
  // A remembered profile that no longer exists falls back to the default.
  const profile = profiles.some((p) => p.name === prefs.settings.profile) ? prefs.settings.profile! : defaultProfile;
  const setProfile = (name: string) => prefs.update({ profile: name });

  useEffect(() => {
    api.profiles().then(
      (list) => {
        setProfiles(list);
        setDefaultProfile(list.find((x) => x.learned)?.name ?? list[0]?.name);
      },
      () => {},
    );
  }, []);

  const sum = useMemo(() => totals(lib.photos), [lib.photos]);
  // A remembered "To review" with nothing left to review shows everything instead.
  const activeFilter: Filter = filter === 'review' && sum.toReview === 0 ? 'all' : filter;
  const shown = useMemo(() => visible(lib.photos, activeFilter, sort), [lib.photos, activeFilter, sort]);
  const byPath = useMemo(() => new Map(lib.photos.map((p) => [p.path, p])), [lib.photos]);
  const viewerPhotos = useMemo(() => viewer?.paths.map((p) => byPath.get(p)!).filter(Boolean) ?? [], [viewer, byPath]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const sendAll = async () => {
    setSending(true);
    setSendError(undefined);
    try {
      await lib.send();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  const summary = sendSummary(sum);

  const startReview = () => {
    const paths = lib.photos.filter(awaitsReview).map((p) => p.path);
    if (paths.length) setViewer({ paths, index: 0, review: true });
  };

  const run = async (kind: 'cull' | 'rate') => {
    if (!lib.listing) return;
    const done = await job.start({ kind, folder: lib.listing.folder, recursive: lib.recursive, profile });
    if (done?.state !== 'done') return;
    if (kind === 'cull') {
      lib.setCull((done.result as CullReport).results);
      setFilter('all');
    }
    else {
      const report = done.result as RateReport;
      lib.setRate(report.results, report.profile);
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
            <Button variant={sum.toSend ? 'secondary' : 'primary'} icon="star" onClick={() => run('rate')} disabled={busy || !sum.total}>
              Rate
            </Button>
            {/* Once there is something to hand over, sending it is the next step. */}
            <Button
              variant={sum.toSend ? 'primary' : 'secondary'}
              icon="upload"
              onClick={sendAll}
              loading={sending}
              disabled={busy || sum.toSend === 0}
            >
              {sum.toSend ? `Send ${sum.toSend} to Lightroom` : 'Send to Lightroom'}
            </Button>
          </>
        }
      />

      <div class="app-toolbar">
        <Switch
          checked={lib.recursive}
          onChange={(v) => {
            lib.setRecursive(v);
            prefs.update({ recursive: v });
          }}
          disabled={busy}
        >
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
                label="Rejected"
                value={sum.checked ? sum.rejected : '—'}
                hint={!sum.checked ? 'not checked yet' : sum.toReview ? `${sum.toReview} to review` : sum.decided ? `${sum.decided} decided by you` : `of ${sum.checked} checked`}
                hintTone={sum.toReview ? 'danger' : 'neutral'}
              />
              <Stat label="Rated" value={sum.rated || '—'} hint={sum.rated ? `profile ${lib.ratedWith ?? profile ?? ''}` : 'not rated yet'} />
              <Stat label="Average" value={sum.meanStars === undefined ? '—' : sum.meanStars.toFixed(1)} unit={sum.meanStars === undefined ? undefined : '★'} hint="stars" />
            </Card>

            {sum.toReview > 0 && !job.running && (
              <Alert
                tone="warning"
                title={`${sum.toReview} frame${sum.toReview === 1 ? ' needs' : 's need'} your eye`}
                action={
                  <Button size="sm" variant="primary" onClick={startReview}>
                    Review
                  </Button>
                }
              >
                Soft overall but sharp in one area, as with a wide aperture. shoots kept them; you decide. Any other verdict can be changed from the photo too.
              </Alert>
            )}

            <div class="app-toolbar">
              <Segmented
                label="Show"
                value={activeFilter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `All ${sum.total}` },
                  { value: 'keepers', label: `Keepers ${sum.total - sum.rejected}` },
                  { value: 'rejected', label: `Rejected ${sum.rejected}` },
                  ...(sum.toReview ? [{ value: 'review' as const, label: `To review ${sum.toReview}` }] : []),
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

            {sendError && <Alert tone="danger" title="Could not send to Lightroom">{sendError}</Alert>}
            {(summary || sum.decided > 0) && (
              <p class="app-note sh-muted">
                {[sum.decided ? `${sum.decided} decision${sum.decided === 1 ? '' : 's'} by you` : undefined, summary].filter(Boolean).join(' · ')}
                {sum.waiting > 0 && '. Keep Lightroom open with the shoots plug-in: it collects them within a few seconds.'}
                {sum.notInCatalog > 0 && sum.waiting === 0 && '. Import the missing photos into Lightroom, then send again.'}
              </p>
            )}

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
                    flag={flagFor(p)}
                    onClick={() => setViewer({ paths: shown.map((x) => x.path), index: i, review: false })}
                  />
                ))}
              </PhotoGrid>
            )}
          </>
        )
      )}

      {viewer && viewerPhotos.length > 0 && (
        <PhotoViewer
          photos={viewerPhotos}
          index={Math.min(viewer.index, viewerPhotos.length - 1)}
          review={viewer.review}
          onIndex={(index) => setViewer((v) => v && { ...v, index })}
          onClose={() => setViewer(undefined)}
          onDecide={lib.decide}
        />
      )}
      {picker}
    </>
  );
}

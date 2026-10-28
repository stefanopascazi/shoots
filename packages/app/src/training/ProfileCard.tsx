/** @jsxImportSource preact */
import { Badge, Card, EmptyState } from '@shoots/ui';
import type { ProfileSummary } from './model.js';

const CALIBRATION: Record<ProfileSummary['calibration'], { tone: 'success' | 'warning' | 'neutral'; text: string }> = {
  current: { tone: 'success', text: 'Calibrated' },
  stale: { tone: 'warning', text: 'Calibrated before the last training' },
  none: { tone: 'neutral', text: 'Not calibrated' },
};

/** The develop profile training produced, or what to do when there is none. */
export function ProfileCard({ profile }: { profile: ProfileSummary | undefined }) {
  if (!profile) {
    return (
      <Card title="Your style profile">
        <EmptyState
          icon="sparkle"
          title="No profile yet"
          description="Train on a folder you have edited in Lightroom: shoots learns how you develop, then proposes it for new shoots."
        />
      </Card>
    );
  }
  const c = CALIBRATION[profile.calibration];
  return (
    <Card title="Your style profile" actions={<Badge tone={c.tone}>{c.text}</Badge>}>
      <dl class="app-facts">
        <dt>Name</dt>
        <dd>{profile.name}</dd>
        <dt>Trained</dt>
        <dd>{new Date(profile.trainedAt).toLocaleString()}</dd>
        <dt>Learned from</dt>
        <dd class="sh-num">
          {profile.edited} edited photos ({profile.color} colour, {profile.bw} black and white)
        </dd>
      </dl>
    </Card>
  );
}

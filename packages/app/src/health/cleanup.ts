/** What the clean-up card offers, part by part, kept apart from how it shows it. */
import type { CleanupItem, CleanupPart } from '../contract.js';

export interface PartInfo {
  part: CleanupPart;
  label: string;
  hint: string;
  /** Ticked when the card opens. */
  preselected: boolean;
  /** Cannot be rebuilt: said so, and never preselected. */
  irreplaceable?: boolean;
}

export const PARTS: readonly PartInfo[] = [
  { part: 'dataset', label: 'Training dataset', hint: 'What training read from your photos. Rebuilt by the next training.', preselected: true },
  { part: 'profile', label: 'Style profile', hint: 'The trained profile, calibration included. Train again to get one back.', preselected: true },
  { part: 'calibration', label: 'Calibration only', hint: 'Keeps the profile, forgets how strongly you set it to correct.', preselected: false },
  { part: 'shoots', label: 'Shoot working files', hint: 'Per-shoot files from developing shoots. Rebuilt when needed.', preselected: true },
  {
    part: 'journal',
    label: 'Feedback journal',
    hint: 'Every correction you made after a prediction. It cannot be rebuilt.',
    preselected: false,
    irreplaceable: true,
  },
  { part: 'jobs', label: 'Job history', hint: 'Logs and results of trainings and calibrations that ended.', preselected: true },
  { part: 'exports', label: 'Catalog exports', hint: 'Files kept by Export only.', preselected: true },
];

/** "1.2 GB", "340 kB", "nothing". */
export function size(bytes: number, count: number): string {
  if (count === 0) return 'nothing';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : 'present';
}

/** The item for a part; parts with nothing on disk come back empty. */
export function itemFor(items: readonly CleanupItem[], part: CleanupPart): CleanupItem {
  return items.find((i) => i.part === part) ?? { part, count: 0, bytes: 0 };
}

/** Preselected parts that hold something: what the card ticks on open. */
export function initialSelection(items: readonly CleanupItem[]): Set<CleanupPart> {
  return new Set(PARTS.filter((p) => p.preselected && itemFor(items, p.part).count > 0).map((p) => p.part));
}

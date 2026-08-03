/**
 * Semantic label → the name an editor expects to see.
 *
 * `xmp:Label` is a standard *field* (XMP Basic schema) carrying a non-standard
 * *value*: it is free text, and Lightroom and Bridge colour it only when the
 * string matches an entry in the user's label set — which is localized, so an
 * Italian install wants "Rosso" where an English one wants "Red". Darktable
 * ignores names entirely and keeps five numbered slots.
 *
 * So the built-in sets here are a sensible default, not a truth, and the
 * photographer overrides them per editor in `~/.shoots/labels/<editor>.json`:
 *
 *     { "reject": "Rosso", "select": "Verde", "review": "Giallo" }
 *
 * Partial overrides are merged over the built-in set, so remapping one label
 * does not mean restating the rest.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { labelSetsDir } from '@shoots/core';
import { isSemanticLabel, SEMANTIC_LABELS, type SemanticLabel } from './schema.js';

export type LabelSet = Record<SemanticLabel, string>;

/**
 * Adobe's default English label set, which is what a stock Lightroom / Bridge
 * install matches. `second-pass` has no natural home in the five Adobe colours;
 * Purple is the one photographers most often leave unassigned.
 */
const ACR_LABELS: LabelSet = {
  reject: 'Red',
  select: 'Green',
  review: 'Yellow',
  'second-pass': 'Purple',
};

const BUILTIN: Record<string, LabelSet> = {
  acr: ACR_LABELS,
};

export class LabelSetError extends Error {}

/** The built-in set for an editor, or the ACR one when it has no opinion. */
export function builtinLabelSet(editorId: string): LabelSet {
  return BUILTIN[editorId] ?? ACR_LABELS;
}

/**
 * Resolve the label set for an editor: the built-in defaults with any user
 * override merged over them. Throws on a malformed override rather than
 * silently writing the wrong label into a shoot.
 */
export async function resolveLabelSet(editorId: string): Promise<LabelSet> {
  const base = builtinLabelSet(editorId);
  const file = path.join(labelSetsDir(), `${editorId}.json`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return base; // no override — the common case
  }

  let raw: unknown;
  try {
    // This file is hand-edited, and on Windows that means Notepad or PowerShell
    // `Out-File -Encoding utf8`, both of which prepend a BOM that JSON.parse
    // rejects. Failing on it would be technically correct and useless.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new LabelSetError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LabelSetError(`${file} must be an object mapping ${SEMANTIC_LABELS.join(' / ')} to label names`);
  }

  const override: Partial<LabelSet> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSemanticLabel(key)) {
      throw new LabelSetError(`${file}: unknown label '${key}' (expected one of: ${SEMANTIC_LABELS.join(', ')})`);
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new LabelSetError(`${file}: label '${key}' must be a non-empty string`);
    }
    override[key] = value;
  }
  return { ...base, ...override };
}

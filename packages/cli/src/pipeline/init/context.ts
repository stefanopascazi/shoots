/**
 * The choice lists the wizard offers, taken from what the commands actually
 * accept — rating profiles (including the learned ones in ~/.shoots), the
 * registered develop adapters, the triage label vocabulary.
 *
 * Building this here rather than in @shoots/core is the point: core stays free
 * of the CLI's registries, and a profile added on this machine shows up in the
 * wizard without anything being re-declared.
 */
import { allProfileNames, DEFAULT_PROFILE_NAME, PROFILE_NAMES } from '@shoots/inference';
import { makeContext, type CatalogContext } from '@shoots/core';
import { EDITOR_IDS, DEFAULT_EDITOR } from '../../develop/adapters/registry.js';
import { SEMANTIC_LABELS } from '../../triage/schema.js';

/** The default first, so "press enter" picks what the command would have. */
const preferred = (values: readonly string[], first: string): string[] => {
  const rest = values.filter((value) => value !== first);
  return values.includes(first) ? [first, ...rest] : [...values];
};

export async function buildCatalogContext(): Promise<CatalogContext> {
  // A broken profiles directory must not stop somebody writing a pipeline file.
  let profiles: string[];
  try {
    profiles = await allProfileNames();
  } catch {
    profiles = [...PROFILE_NAMES];
  }

  return makeContext({
    profiles: preferred(profiles, DEFAULT_PROFILE_NAME),
    editors: preferred(EDITOR_IDS, DEFAULT_EDITOR),
    labels: preferred(SEMANTIC_LABELS, 'reject'),
  });
}

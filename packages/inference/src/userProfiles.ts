/**
 * Loading and validating user-supplied rating profiles from
 * `~/.shoots/profiles/*.json` (the deliverable emitted by tools/match).
 *
 * These are `type: "linear-embedding"` profiles: a linear head over the CLIP
 * embedding. Because they are external JSON, every field is validated before use
 * — a malformed profile fails loudly rather than producing silent garbage stars.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { profilesDir } from '@shoots/core';
import {
  BUILTIN_PROFILES,
  PROFILE_NAMES,
  getProfile,
  type LinearEmbeddingProfile,
  type RatingProfile,
} from './profiles.js';
import type { StarRating } from './QualityModel.js';

class ProfileError extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStar = (v: unknown): v is StarRating => isNum(v) && Number.isInteger(v) && v >= 0 && v <= 5;

/** Validate a parsed JSON object into a LinearEmbeddingProfile, or throw. */
export function parseLinearEmbeddingProfile(raw: unknown, source: string): LinearEmbeddingProfile {
  const o = raw as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new ProfileError(`invalid profile ${source}: ${msg}`);
  };

  if (!o || typeof o !== 'object') fail('not a JSON object');
  if (o.type !== 'linear-embedding') fail(`unsupported type '${String(o.type)}' (expected 'linear-embedding')`);
  if (typeof o.name !== 'string' || o.name.length === 0) fail('missing name');
  if (typeof o.embeddingModel !== 'string' || o.embeddingModel.length === 0) fail('missing embeddingModel');
  if (!isNum(o.dim) || !Number.isInteger(o.dim) || o.dim <= 0) fail('dim must be a positive integer');
  if (!Array.isArray(o.weights) || o.weights.length !== o.dim || !o.weights.every(isNum)) {
    fail(`weights must be ${String(o.dim)} finite numbers`);
  }
  if (!isNum(o.bias)) fail('bias must be a number');
  const norm = o.scoreNormalization as Record<string, unknown> | undefined;
  if (!norm || !isNum(norm.mean) || !isNum(norm.std)) fail('scoreNormalization must have numeric mean/std');
  if (!isNum(o.focusReject) || !isNum(o.focusSoft)) fail('focusReject/focusSoft must be numbers');
  if (!isStar(o.focusSoftCap)) fail('focusSoftCap must be an integer 0–5');
  if (
    !Array.isArray(o.aestheticStars) ||
    o.aestheticStars.length === 0 ||
    !o.aestheticStars.every((t) => t && isNum((t as { min: unknown }).min) && isStar((t as { stars: unknown }).stars))
  ) {
    fail('aestheticStars must be a non-empty list of { min:number, stars:0–5 }');
  }

  return {
    type: 'linear-embedding',
    name: o.name as string,
    description: typeof o.description === 'string' ? o.description : 'Learned linear-embedding profile',
    calibrated: true,
    embeddingModel: o.embeddingModel as string,
    dim: o.dim as number,
    weights: o.weights as number[],
    bias: o.bias as number,
    scoreNormalization: { mean: norm!.mean as number, std: norm!.std as number },
    focusReject: o.focusReject as number,
    focusSoft: o.focusSoft as number,
    focusSoftCap: o.focusSoftCap as StarRating,
    aestheticStars: (o.aestheticStars as { min: number; stars: StarRating }[]).map((t) => ({
      min: t.min,
      stars: t.stars,
    })),
  };
}

/** Load a single user profile file by absolute path. */
export async function loadProfileFile(file: string): Promise<LinearEmbeddingProfile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ProfileError(`cannot read profile ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseLinearEmbeddingProfile(raw, path.basename(file));
}

/** Names of user profiles in ~/.shoots/profiles (files, sans .json). */
export async function listUserProfileNames(): Promise<string[]> {
  try {
    const entries = await readdir(profilesDir());
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
  } catch {
    return []; // no profiles dir yet
  }
}

/**
 * Resolve a profile by name: a built-in wins; otherwise
 * `~/.shoots/profiles/<name>.json` is loaded and validated. Returns undefined
 * when neither exists (so callers can print a helpful list).
 */
export async function resolveProfile(name: string): Promise<RatingProfile | undefined> {
  const builtin = getProfile(name);
  if (builtin) return builtin;
  const file = path.join(profilesDir(), `${name}.json`);
  try {
    await readFile(file); // existence check kept cheap; loadProfileFile re-reads
  } catch {
    return undefined;
  }
  return loadProfileFile(file);
}

/** All selectable profile names (built-in + user), for help and error text. */
export async function allProfileNames(): Promise<string[]> {
  const user = await listUserProfileNames();
  return [...PROFILE_NAMES, ...user.filter((n) => !BUILTIN_PROFILES.has(n))];
}

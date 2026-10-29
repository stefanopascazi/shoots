/**
 * Folders and photographs for the app: browsing directories, listing a folder's
 * photos, and serving thumbnails.
 *
 * Only files inside a folder the page has listed can be read back as a
 * thumbnail, so the server never becomes a general file reader.
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowseResult, LibraryListing, LibraryPhoto, PhotoExif } from '@shoots/app';

/** A folder's photographs, before anything known about them is added. */
export type FolderListing = Pick<LibraryListing, 'folder' | 'recursive' | 'photos'>;
import { classifyExtension, scanFiles } from '@shoots/core';
import { generateThumbnail, isRawFile, readMetadata, type ExifRecord } from '@shoots/imaging';
import { EXIF_TAGS, summarizeExif } from './exif.js';

/** Roots to offer when no folder is chosen yet: drives on Windows, / elsewhere. */
export function fsRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

/** Directory names a photographer never wants to browse into. */
export const isHiddenDir = (name: string): boolean => name.startsWith('.') || name.startsWith('$') || name === 'System Volume Information';

export async function browse(dir: string | null): Promise<BrowseResult> {
  if (dir === null) {
    return { path: null, parent: null, dirs: fsRoots().map((r) => ({ name: r, path: r })), images: 0 };
  }
  const resolved = path.resolve(dir);
  const entries = await readdir(resolved, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !isHiddenDir(e.name))
    .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const images = entries.filter((e) => e.isFile() && classifyExtension(path.extname(e.name).slice(1).toLowerCase())).length;
  const up = path.dirname(resolved);
  return { path: resolved, parent: up === resolved ? null : up, dirs, images };
}

export class Library {
  /** Folders listed this session; thumbnails are served only from inside them. */
  private readonly roots = new Map<string, boolean>();
  private readonly thumbs = new Map<string, Buffer>();
  private readonly exifs = new Map<string, PhotoExif>();
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly ensureRawSupport: () => Promise<boolean> = async () => true,
    private readonly maxThumbs = 600,
    private readonly concurrency = 4,
    private readonly readExif: (file: string) => Promise<ExifRecord | undefined> = async (file) =>
      (await readMetadata([file], { tags: EXIF_TAGS }))[0],
  ) {}

  async list(folder: string, recursive: boolean): Promise<FolderListing> {
    const resolved = path.resolve(folder);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`${resolved} is not a folder.`);
    const files = await scanFiles(resolved, { recursive });
    this.roots.set(resolved, recursive || this.roots.get(resolved) === true);
    return {
      folder: resolved,
      recursive,
      photos: files
        .map((f) => ({ path: f.path, name: f.name, kind: f.kind, size: f.size, mtime: f.mtime.getTime() }))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    };
  }

  /** The listed photos of `folder`, for handing to a job. */
  async photosOf(folder: string, recursive: boolean): Promise<LibraryPhoto[]> {
    return (await this.list(folder, recursive)).photos;
  }

  isServable(file: string): boolean {
    const resolved = path.resolve(file);
    if (!classifyExtension(path.extname(resolved).slice(1).toLowerCase())) return false;
    for (const [root, recursive] of this.roots) {
      const rel = path.relative(root, resolved);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (recursive || !rel.includes(path.sep)) return true;
    }
    return false;
  }

  async thumbnail(file: string, width: number): Promise<Buffer> {
    const resolved = path.resolve(file);
    const { mtimeMs } = await stat(resolved);
    const key = `${resolved}|${mtimeMs}|${width}`;
    const hit = this.thumbs.get(key);
    if (hit) return hit;
    if (isRawFile(resolved) && !(await this.ensureRawSupport())) {
      throw new Error('RAW previews need exiftool, which could not be set up.');
    }
    await this.acquire();
    try {
      const buf = await generateThumbnail(resolved, { width, height: width, format: 'jpeg', quality: 80 });
      this.thumbs.set(key, buf);
      // Map keeps insertion order: dropping the first key is least-recently-added.
      if (this.thumbs.size > this.maxThumbs) this.thumbs.delete(this.thumbs.keys().next().value!);
      return buf;
    } finally {
      this.release();
    }
  }

  /** The photo's capture data. Needs exiftool for every format; cached until the file changes. */
  async exif(file: string): Promise<PhotoExif> {
    const resolved = path.resolve(file);
    const { mtimeMs } = await stat(resolved);
    const key = `${resolved}|${mtimeMs}`;
    const hit = this.exifs.get(key);
    if (hit) return hit;
    if (!(await this.ensureRawSupport())) throw new Error('Capture data needs exiftool, which could not be set up.');
    const record = await this.readExif(resolved);
    const summary = record ? summarizeExif(record) : {};
    this.exifs.set(key, summary);
    if (this.exifs.size > this.maxThumbs) this.exifs.delete(this.exifs.keys().next().value!);
    return summary;
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => (this.inFlight++, resolve())));
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}

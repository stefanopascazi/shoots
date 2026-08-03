/**
 * Command catalog for the interactive shell: drives `/` autocomplete,
 * the usage hint under the input, and `/help`.
 */
import type { Command } from 'commander';

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  /** Handled inside the shell itself instead of spawning the CLI. */
  builtin?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'import',
    summary: 'Offload a card: copy into date folders, checksum-verify',
    usage: '/import <source> --dest <path> [--rename | --pattern <tpl>] [--dir <tpl> | --flat] [--move] [--dry-run]',
  },
  {
    name: 'rename',
    summary: 'Batch-rename in place with the same template engine',
    usage: '/rename <path> --pattern <tpl> [--recursive] [--dry-run] [--json]',
  },
  {
    name: 'exif',
    summary: 'Read/write EXIF-IPTC metadata in batch (exiftool)',
    usage: '/exif <path> [--set-artist <name>] [--set-copyright <text>] [--set-keywords a,b] [--dry-run]',
  },
  {
    name: 'cull',
    summary: 'Blur detection (Laplacian, focus-aware): report, relocate rejects, or review interactively',
    usage: '/cull <path> [--review] [--mark] [--mark-label reject] [--mark-keepers select] [--dest <dir>] [--copy] [--threshold 100] [--focus-threshold 250] [--no-focus-rescue] [--format csv] [--out <report>] [--dry-run]',
  },
  {
    name: 'rate',
    summary: 'Strict 0–5 star ratings + keyword suggestions via the ONNX model',
    usage: '/rate <path> [--profile street|generic|portrait|wildlife|wedding] [--mark] [--write-xmp] [--dry-run] [--json]',
  },
  {
    name: 'triage',
    summary: 'The marks cull/rate recorded, before they reach a sidecar: list, apply, clean',
    usage: '/triage list [<path>] · apply <path> [--editor acr] [--redo] [--dry-run] · clean [--orphans] [--dry-run]',
  },
  {
    name: 'embeddings',
    summary: 'Export raw CLIP embeddings (profile-neutral) for preference-learning tooling',
    usage: '/embeddings <path> [--out <dir>] [--previews auto|always|never] [--preview-size 1024] [--preview-quality 82] [--json]',
  },
  {
    name: 'match',
    summary: 'Learn your eye from pairwise duels → a rating profile that generalizes it',
    usage:
      '/match import --data <embeddings.json> [--name my-eye] · serve [--name my-eye] [--port 4576] · train [--name my-eye] [--lambda 1]',
  },
  {
    name: 'develop',
    summary: 'Personal develop-setting predictor (local "Lightroom AI", global look): export → train → predict',
    usage: '/develop export <path> --out <f> [--edited-only] · train --data <f> --name <n> --out <f> · predict --data <f> --profile <f> [--xmp <dir>] · diagnose --data <f>',
  },
  {
    name: 'schedule',
    summary: 'Run `develop refine` daily and unattended, via the OS scheduler (cron / Task Scheduler)',
    usage: '/schedule install [--at 03:00] [--dry-run] · status · uninstall · run [--force] [--dry-run] [--json]',
  },
  {
    name: 'setup',
    summary: 'Download & verify external tools (exiftool, libraw) and the inference model into ~/.shoots',
    usage: '/setup [--json]',
  },
  {
    name: 'doctor',
    summary: 'Check the environment: home, tools, imaging stack',
    usage: '/doctor [--json]',
  },
  {
    name: 'update',
    summary: 'Update the standalone binary to the latest release',
    usage: '/update [--check]',
  },
  {
    name: 'release-notes',
    summary: 'Migration steps this release needs, checked against what is stored in ~/.shoots',
    usage: '/release-notes [--all] [--json]',
  },
  { name: 'cd', builtin: true, summary: 'Change the shell working directory', usage: '/cd <path>' },
  { name: 'pwd', builtin: true, summary: 'Print the shell working directory', usage: '/pwd' },
  { name: 'clear', builtin: true, summary: 'Clear the screen', usage: '/clear' },
  { name: 'mouse', builtin: true, summary: 'Toggle mouse capture (off = select/copy text; on = wheel scroll)', usage: '/mouse' },
  { name: 'help', builtin: true, summary: 'Show commands and shell tips', usage: '/help' },
  { name: 'version', builtin: true, summary: 'Show the shoots version', usage: '/version' },
  { name: 'exit', builtin: true, summary: 'Leave the shell', usage: '/exit' },
];

/** Look up a spawnable (non-builtin) CLI command by name. */
export function findCliCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name && !c.builtin);
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/**
 * Commander commands that intentionally have no shell catalog entry: `shell`
 * launches the shell (running it from inside the shell is meaningless) and
 * `help` is commander's own implicit command.
 */
const NON_CATALOG_COMMANDS = new Set(['shell', 'help']);

/**
 * Enforce the convention "every CLI command also lives in the Ink shell".
 *
 * The commander `program` is the single source of truth; this asserts that the
 * spawnable entries in {@link COMMANDS} match its top-level commands exactly
 * (minus {@link NON_CATALOG_COMMANDS}). Called at startup so drift fails loudly
 * with a precise diff instead of a command silently vanishing from the shell's
 * `/` autocomplete, `/help` and dispatch. Builtins (cd/pwd/help/…) live only in
 * the shell and are ignored here.
 */
export function assertShellCatalogInSync(program: Command): void {
  const registered = program.commands.map((c) => c.name()).filter((n) => !NON_CATALOG_COMMANDS.has(n));
  const cataloged = COMMANDS.filter((c) => !c.builtin).map((c) => c.name);

  const registeredSet = new Set(registered);
  const catalogedSet = new Set(cataloged);
  const missing = registered.filter((n) => !catalogedSet.has(n)); // on the CLI, absent from the shell
  const extra = cataloged.filter((n) => !registeredSet.has(n)); // in the shell, not a real CLI command

  if (missing.length === 0 && extra.length === 0) return;

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`missing from the shell catalog (add to COMMANDS in shell/catalog.ts): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`present in the shell catalog but not registered on the CLI: ${extra.join(', ')}`);
  }
  throw new Error(`shell command catalog out of sync — ${problems.join('; ')}`);
}

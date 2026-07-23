/**
 * Command catalog for the interactive shell: drives `/` autocomplete,
 * the usage hint under the input, and `/help`.
 */

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
    summary: 'Offload a card: copy, rename from EXIF, checksum-verify',
    usage: '/import <source> --dest <path> [--pattern <tpl>] [--move] [--dry-run] [--json]',
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
    summary: 'Blur detection (Laplacian): report + sharp/blurry split',
    usage: '/cull <path> [--threshold 100] [--separate] [--format csv] [--out <report>] [--dry-run]',
  },
  {
    name: 'rate',
    summary: 'Star ratings + keyword suggestions via the inference model',
    usage: '/rate <path> [--write-xmp] [--dry-run] [--json]',
  },
  { name: 'cd', builtin: true, summary: 'Change the shell working directory', usage: '/cd <path>' },
  { name: 'pwd', builtin: true, summary: 'Print the shell working directory', usage: '/pwd' },
  { name: 'clear', builtin: true, summary: 'Clear the screen', usage: '/clear' },
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

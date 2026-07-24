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
    summary: 'Blur detection (Laplacian, focus-aware): report, split, or review interactively',
    usage: '/cull <path> [--review] [--threshold 100] [--focus-threshold 250] [--no-focus-rescue] [--separate] [--dest <dir>] [--format csv] [--out <report>] [--dry-run]',
  },
  {
    name: 'rate',
    summary: 'Star ratings + keyword suggestions via the inference model',
    usage: '/rate <path> [--write-xmp] [--dry-run] [--json]',
  },
  {
    name: 'setup',
    summary: 'Download & verify external tools (exiftool) into ~/.shoots',
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

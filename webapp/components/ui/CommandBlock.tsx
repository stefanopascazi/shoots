import { CopyButton } from "@/components/ui/CopyButton";

export interface CommandLine {
  comment?: string;
  command: string;
}

interface CommandBlockProps {
  title?: string;
  lines: CommandLine[];
}

/**
 * A short shell transcript. Kept out of the markdown pipeline on purpose: these
 * snippets are part of the page layout, not of the documentation body.
 */
export function CommandBlock({ title, lines }: CommandBlockProps) {
  const plain = lines
    .map((line) => (line.comment ? `# ${line.comment}\n${line.command}` : line.command))
    .join("\n\n");

  return (
    <div className="overflow-hidden rounded-2xl border border-terminal-border bg-terminal">
      <div className="flex items-center justify-between border-b border-terminal-border px-4 py-2.5">
        <span className="font-mono text-[11px] text-slate-500">{title ?? "sh"}</span>
        <CopyButton
          value={plain}
          label="Copy commands"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-terminal-soft hover:text-terminal-fg"
        />
      </div>

      <div className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">
        {lines.map((line) => (
          <div key={line.command} className="[&:not(:first-child)]:mt-4">
            {line.comment && <div className="text-slate-500"># {line.comment}</div>}
            <div className="flex items-start gap-2">
              <span className="select-none text-terminal-accent" aria-hidden>
                $
              </span>
              <code className="text-terminal-fg">{line.command}</code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

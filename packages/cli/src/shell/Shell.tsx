/**
 * Interactive shell — launched by running `shoots` with no arguments.
 *
 * Runs fullscreen inside the terminal's alternate screen buffer (entered by
 * cli.tsx before render, restored on exit — the vim/less experience: your
 * previous terminal content reappears untouched when you leave).
 *
 * Layout: own scrollback (history lines, tail-sliced to fit the viewport)
 * on top, input pinned to the bottom of the screen.
 *
 *   /        command palette with autocomplete
 *   @        mention files/folders with filesystem autocomplete
 *   ↑ ↓      navigate suggestions (or command history)
 *   Tab      accept the highlighted suggestion
 *   Enter    run · Esc clears input / cancels a running command
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { exiftoolVersion } from '@shoots/imaging';
import { COMMANDS, findCliCommand } from './catalog.js';
import { runCli, type OutputStream, type RunningCommand } from './runner.js';
import { getSuggestions, type Suggestion } from './suggestions.js';
import { expandMentions, tokenize } from './tokenize.js';
import { VERSION } from '../version.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_HISTORY_LINES = 1000;
const RUNNING_TAIL = 10;
/** How many suggestions are visible at once; the rest scroll into view. */
const SUGGEST_WINDOW = 5;

// ---------------------------------------------------------------------------
// History line model: one visual row = one Line = a list of styled spans.
// Keeping rows flat (wrap="truncate-end") makes viewport math exact.
// ---------------------------------------------------------------------------

interface Span {
  t: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

type Line = Span[];

const span = (t: string, style: Omit<Span, 't'> = {}): Span => ({ t, ...style });
const BLANK: Line = [span('')];

// ---------------------------------------------------------------------------
// Logo — ANSI-shadow "SHOOTS" wordmark with a cyan→violet gradient, plus an
// aperture mark. Falls back to a compact one-liner on narrow terminals.
// ---------------------------------------------------------------------------

const LOGO_ROWS = [
  '███████╗██╗  ██╗ ██████╗  ██████╗ ████████╗███████╗',
  '██╔════╝██║  ██║██╔═══██╗██╔═══██╗╚══██╔══╝██╔════╝',
  '███████╗███████║██║   ██║██║   ██║   ██║   ███████╗',
  '╚════██║██╔══██║██║   ██║██║   ██║   ██║   ╚════██║',
  '███████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████║',
  '╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝',
];

const LOGO_GRADIENT = ['#67e8f9', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc'];

function logoLines(columns: number): Line[] {
  const lines: Line[] = [BLANK];
  if (columns >= LOGO_ROWS[0].length + 4) {
    for (let i = 0; i < LOGO_ROWS.length; i++) {
      lines.push([span('  '), span(LOGO_ROWS[i], { color: LOGO_GRADIENT[i] })]);
    }
  } else {
    lines.push([span('  '), span('◉ S H O O T S', { color: '#38bdf8', bold: true })]);
  }
  lines.push([
    span('  '),
    span('◉ ', { color: '#c084fc' }),
    span(`v${VERSION} — batch automation for photographers`, { dim: true }),
  ]);
  lines.push([span('    not an editor, not a DAM — the pipeline glue in between', { dim: true })]);
  lines.push(BLANK);
  lines.push([
    span('  Type '),
    span('/', { color: 'cyan', bold: true }),
    span(' for commands · '),
    span('@', { color: 'magenta', bold: true }),
    span(' to mention files & folders · '),
    span('/help', { color: 'cyan' }),
    span(' for a tour'),
  ]);
  lines.push(BLANK);
  return lines;
}

function helpLines(): Line[] {
  const lines: Line[] = [];
  for (const c of COMMANDS) {
    lines.push([
      span('  '),
      span(`/${c.name}`.padEnd(10), { color: 'cyan', bold: true }),
      span(c.summary),
    ]);
    lines.push([span(`             ${c.usage}`, { dim: true })]);
  }
  lines.push(BLANK);
  lines.push([span('  Tips:', { bold: true })]);
  lines.push([span('    @ mentions expand to paths:   /cull @raw/ --threshold 120', { dim: true })]);
  lines.push([span('    every command supports --dry-run — try things safely', { dim: true })]);
  lines.push([span('    --json prints machine-readable output for scripting', { dim: true })]);
  return lines;
}

function useTerminalSize(): { rows: number; columns: number } {
  const [size, setSize] = useState({
    rows: process.stdout.rows ?? 30,
    columns: process.stdout.columns ?? 80,
  });
  useEffect(() => {
    const onResize = (): void =>
      setSize({ rows: process.stdout.rows ?? 30, columns: process.stdout.columns ?? 80 });
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}

// ---------------------------------------------------------------------------

export function Shell() {
  const { exit } = useApp();
  const { rows, columns } = useTerminalSize();

  const [lines, setLines] = useState<Line[]>(() => logoLines(process.stdout.columns ?? 80));
  const [cwd, setCwd] = useState(process.cwd());
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [selIndex, setSelIndex] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [running, setRunning] = useState<{ command: string; startedAt: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [exiftool, setExiftool] = useState<string | null | undefined>(undefined);
  // Scrollback: how many lines the viewport is scrolled up from the bottom.
  // 0 = pinned to the latest output (live). Driven by PgUp/PgDn/Home/End since
  // the alt screen buffer disables the terminal's own scroll.
  const [scrollOffset, setScrollOffset] = useState(0);

  const runningRef = useRef<RunningCommand | null>(null);
  // Current history viewport height, kept in a ref so key handlers can page by
  // a real screenful without recomputing the layout math.
  const viewportRef = useRef(10);
  const outputRef = useRef<{ text: string; stream: OutputStream }[]>([]);
  const killedRef = useRef(false);

  // ---- one-time environment probe ----
  useEffect(() => {
    let alive = true;
    exiftoolVersion().then((v) => {
      if (alive) setExiftool(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ---- kill a stray child if the shell unmounts ----
  useEffect(() => () => runningRef.current?.kill(), []);

  // ---- spinner / elapsed ticker while a command runs ----
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, [running]);

  // ---- autocomplete ----
  useEffect(() => {
    if (running) {
      setSuggestions([]);
      setHiddenCount(0);
      return;
    }
    let alive = true;
    getSuggestions(input, cwd).then((result) => {
      if (alive) {
        setSuggestions(result.items);
        setHiddenCount(result.hiddenCount);
        setSelIndex(0);
        setNavigated(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [input, cwd, running]);

  const pushLines = (added: Line[]): void => {
    setLines((prev) => [...prev, ...added].slice(-MAX_HISTORY_LINES));
  };

  const pushEcho = (command: string): void => {
    pushLines([[span('❯ ', { color: 'cyan', bold: true }), span(command, { bold: true })]]);
  };

  const applySuggestion = (s: Suggestion): void => {
    setInput(s.apply);
    setCursor(s.apply.length);
    setNavigated(false);
  };

  const submit = (): void => {
    const line = input.trim();
    if (line.length === 0) return;
    setHistory((h) => (h[h.length - 1] === line ? h : [...h, line]));
    setHistoryIndex(-1);
    setInput('');
    setCursor(0);
    setSuggestions([]);
    setHiddenCount(0);
    setScrollOffset(0); // running/echoing a command snaps the view back to live

    const rawTokens = tokenize(line);
    let name = rawTokens[0] ?? '';
    if (name.startsWith('/')) name = name.slice(1);
    name = name.toLowerCase();
    const args = expandMentions(rawTokens.slice(1));

    // ---- builtins ----
    switch (name) {
      case 'exit':
      case 'quit':
        exit();
        return;
      case 'clear':
        setLines(logoLines(columns));
        setScrollOffset(0);
        return;
      case 'pwd':
        pushEcho('/pwd');
        pushLines([[span(`  ${cwd}`, { dim: true })], BLANK]);
        return;
      case 'help':
        pushEcho('/help');
        pushLines([...helpLines(), BLANK]);
        return;
      case 'version':
        pushEcho('/version');
        pushLines([[span(`  shoots v${VERSION}`, { dim: true })], BLANK]);
        return;
      case 'cd': {
        const target = path.resolve(cwd, args[0] ?? '.');
        pushEcho(`/cd ${args[0] ?? ''}`);
        try {
          if (!statSync(target).isDirectory()) throw new Error('not a directory');
          setCwd(target);
          pushLines([[span(`  cwd → ${target}`, { dim: true })], BLANK]);
        } catch {
          pushLines([[span(`  ✗ not a directory: ${target}`, { color: 'red' })], BLANK]);
        }
        return;
      }
    }

    // ---- CLI commands, spawned out-of-process ----
    const spec = findCliCommand(name);
    if (!spec) {
      pushEcho(line);
      pushLines([
        [span(`  ✗ unknown command: /${name} — type `, { color: 'red' }), span('/help', { color: 'cyan' })],
        BLANK,
      ]);
      return;
    }

    outputRef.current = [];
    killedRef.current = false;
    const startedAt = Date.now();
    setRunning({ command: line, startedAt });

    const handle = runCli([spec.name, ...args], cwd, (text, stream) => {
      if (outputRef.current.length >= MAX_HISTORY_LINES) outputRef.current.shift();
      outputRef.current.push({ text, stream });
      setFrame((f) => f + 1); // re-render the live tail
    });
    runningRef.current = handle;

    handle.wait.then((code) => {
      runningRef.current = null;
      const finished: Line[] = [
        [span('❯ ', { color: 'cyan', bold: true }), span(line, { bold: true })],
        ...outputRef.current.map((l): Line => [
          span(`  ${l.text}`, l.stream === 'err' ? { color: 'yellow', dim: true } : {}),
        ]),
        [
          killedRef.current
            ? span('  ✗ cancelled', { color: 'red' })
            : code === 0
              ? span(`  ✓ done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`, { color: 'green' })
              : span(`  ✗ exit code ${code}`, { color: 'red' }),
        ],
        BLANK,
      ];
      pushLines(finished);
      setScrollOffset(0); // reveal the tail of the fresh output; PgUp to review
      setRunning(null);
    });
  };

  useInput((ch, key) => {
    // Scrollback — works in every state since the alt buffer has no native
    // scroll. A page overlaps by one line so nothing is skipped between pages.
    const page = Math.max(1, viewportRef.current - 1);
    if (key.pageUp) {
      setScrollOffset((o) => o + page);
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - page));
      return;
    }
    if (key.home) {
      setScrollOffset(() => lines.length); // clamped to the top in render
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }

    if (running) {
      if (key.escape) {
        killedRef.current = true;
        runningRef.current?.kill();
      }
      return;
    }

    if (key.return) {
      if (navigated && suggestions[selIndex]) applySuggestion(suggestions[selIndex]);
      else submit();
    } else if (key.tab && suggestions.length > 0) {
      applySuggestion(suggestions[selIndex] ?? suggestions[0]);
    } else if (key.upArrow) {
      if (suggestions.length > 0) {
        setSelIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        setNavigated(true);
      } else if (history.length > 0) {
        const idx = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(idx);
        setInput(history[idx]);
        setCursor(history[idx].length);
      }
    } else if (key.downArrow) {
      if (suggestions.length > 0) {
        setSelIndex((i) => (i + 1) % suggestions.length);
        setNavigated(true);
      } else if (historyIndex >= 0) {
        const idx = historyIndex + 1;
        if (idx >= history.length) {
          setHistoryIndex(-1);
          setInput('');
          setCursor(0);
        } else {
          setHistoryIndex(idx);
          setInput(history[idx]);
          setCursor(history[idx].length);
        }
      }
    } else if (key.escape) {
      setInput('');
      setCursor(0);
    } else if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.rightArrow) {
      setCursor((c) => Math.min(input.length, c + 1));
    } else if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
      }
    } else if (ch && !key.ctrl && !key.meta) {
      setInput(input.slice(0, cursor) + ch + input.slice(cursor));
      setCursor(cursor + ch.length);
    }
  });

  // Usage hint for the command currently being typed (after the name).
  const firstToken = input.startsWith('/') ? input.slice(1).split(/\s/, 1)[0] : '';
  const activeSpec =
    input.includes(' ') && firstToken ? COMMANDS.find((c) => c.name === firstToken) : undefined;

  const shortCwd = cwd.length > 46 ? `…${cwd.slice(-45)}` : cwd;
  const runningTail = outputRef.current.slice(-RUNNING_TAIL);
  const elapsed = running ? ((Date.now() - running.startedAt) / 1000).toFixed(0) : '0';

  // ---- suggestion window: show SUGGEST_WINDOW rows, scroll to keep the
  // selection in view; overflow is summarized as "↑/↓ N more". ----
  const total = suggestions.length;
  const winStart =
    total <= SUGGEST_WINDOW ? 0 : Math.max(0, Math.min(selIndex - 2, total - SUGGEST_WINDOW));
  const windowed = suggestions.slice(winStart, winStart + SUGGEST_WINDOW);
  const moreAbove = winStart;
  const moreBelow = total - (winStart + windowed.length) + hiddenCount;

  // ---- viewport math: history gets whatever the bottom area doesn't need ----
  const suggestionRows =
    total > 0 ? windowed.length + (moreAbove > 0 ? 1 : 0) + (moreBelow > 0 ? 1 : 0) : 0;
  const usageRows = activeSpec && suggestions.length === 0 ? 1 : 0;
  const bottomRows = running
    ? 1 + runningTail.length
    : 3 /* bordered input */ + suggestionRows + usageRows + 1; /* status bar */
  const rawVisible = Math.max(3, rows - bottomRows - 1);
  const maxOffset = Math.max(0, lines.length - rawVisible);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const scrolled = clampedOffset > 0;
  // Reserve one row for the scroll indicator while scrolled up.
  const visibleCount = scrolled ? Math.max(3, rawVisible - 1) : rawVisible;
  viewportRef.current = visibleCount;
  const end = lines.length - clampedOffset;
  const visibleLines = lines.slice(Math.max(0, end - visibleCount), end);
  const linesBelow = lines.length - end; // === clampedOffset, kept explicit

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1}>
        {scrolled && (
          <Text wrap="truncate-end" color="cyan" dimColor>
            {'  '}↓ {linesBelow} more line{linesBelow === 1 ? '' : 's'} below · PgDn / End to catch up
          </Text>
        )}
        {visibleLines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l.map((s, j) => (
              <Text key={j} color={s.color} dimColor={s.dim} bold={s.bold}>
                {s.t}
              </Text>
            ))}
          </Text>
        ))}
      </Box>

      {running ? (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>{' '}
            <Text bold>{running.command}</Text>{' '}
            <Text dimColor>{elapsed}s · Esc to cancel</Text>
          </Text>
          {runningTail.map((l, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {'  '}
              {l.text}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {suggestions.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {moreAbove > 0 && (
                <Text dimColor wrap="truncate-end">
                  {'  '}↑ {moreAbove} more
                </Text>
              )}
              {windowed.map((s, i) => {
                const idx = winStart + i;
                return (
                  <Text key={s.apply + s.label} wrap="truncate-end">
                    {idx === selIndex ? <Text color="cyan">❯ </Text> : '  '}
                    <Text color={idx === selIndex ? 'cyan' : undefined} bold={idx === selIndex}>
                      {s.kind === 'path' && <Text color="magenta">@</Text>}
                      {s.label}
                    </Text>
                    {s.hint && <Text dimColor> {s.hint}</Text>}
                  </Text>
                );
              })}
              {moreBelow > 0 && (
                <Text dimColor wrap="truncate-end">
                  {'  '}↓ {moreBelow} more — ↑↓ to scroll
                </Text>
              )}
            </Box>
          )}

          {activeSpec && suggestions.length === 0 && (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {activeSpec.usage}
            </Text>
          )}

          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text color="cyan" bold>
              ❯{' '}
            </Text>
            {input.length === 0 ? (
              <Text dimColor>Type / for commands, @ for files…</Text>
            ) : (
              <Text wrap="truncate-end">
                {input.slice(0, cursor)}
                <Text inverse>{cursor < input.length ? input[cursor] : ' '}</Text>
                {cursor < input.length ? input.slice(cursor + 1) : ''}
              </Text>
            )}
          </Box>

          <Text dimColor wrap="truncate-end">
            {'  '}
            {shortCwd} · exiftool{' '}
            {exiftool === undefined ? '…' : exiftool ? `✓ ${exiftool}` : '– not found'} · Tab
            completes · ↑↓ navigate · PgUp/PgDn scroll · Esc clears
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Mouse-wheel scrollback for the interactive shell.
 *
 * The shell lives in the terminal's alternate screen buffer, where the wheel
 * is normally translated into arrow-key sequences — which the shell reads as
 * command-history navigation, not as scrolling. To get the real wheel we turn
 * on SGR mouse reporting (`?1000h` button events + `?1006h` extended
 * coordinates) and parse the reports ourselves.
 *
 * Those reports would otherwise be handed to Ink's keypress parser and injected
 * as junk into the input box, so we splice a filtering stream between the real
 * stdin and Ink: mouse sequences are stripped out (and turned into scroll
 * events) while every keystroke passes straight through untouched.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** SGR mouse report: ESC [ < button ; col ; row (M press | m release). */
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
/** A mouse report split across chunk boundaries — held until the rest arrives. */
const PARTIAL_MOUSE = /\x1b\[<[\d;]*$/;
/** Lines moved per wheel notch. */
const LINES_PER_NOTCH = 3;

export interface MouseWheel {
  /** Emits `'scroll'` with a signed line delta: negative = up/back, positive = down. */
  readonly events: EventEmitter;
  /** stdin to hand to Ink's `render()` — a clone of the real one with mouse reports removed. */
  readonly stdin: NodeJS.ReadStream;
  /** Turn on mouse reporting and start filtering. Call after entering the alt buffer. */
  enable(): void;
  /** Turn off mouse reporting and detach. Safe to call more than once. */
  disable(): void;
}

/**
 * Bridge the real stdin to a mouse-aware, Ink-friendly stream.
 * `source` is normally `process.stdin`.
 */
export function createMouseWheel(source: NodeJS.ReadStream): MouseWheel {
  const events = new EventEmitter();

  // Ink reads keystrokes from this stream and drives raw-mode/ref through it;
  // present it as a TTY and forward the control calls to the real stdin.
  const filtered = new PassThrough();
  const proxy = filtered as unknown as NodeJS.ReadStream;
  proxy.isTTY = true;
  proxy.setRawMode = (mode: boolean): NodeJS.ReadStream => {
    source.setRawMode?.(mode);
    return proxy;
  };
  proxy.ref = (): NodeJS.ReadStream => {
    source.ref();
    return proxy;
  };
  proxy.unref = (): NodeJS.ReadStream => {
    source.unref();
    return proxy;
  };

  let carry = '';
  const onData = (chunk: Buffer | string): void => {
    let text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    carry = '';

    // Hold back a mouse report that got cut at the chunk boundary; it will be
    // completed by the next chunk. (Only mouse starts — never a lone ESC, so
    // the Escape key stays responsive.)
    const partial = PARTIAL_MOUSE.exec(text);
    if (partial) {
      carry = partial[0];
      text = text.slice(0, partial.index);
    }

    // Strip every mouse report and turn wheel reports into scroll events.
    const cleaned = text.replace(SGR_MOUSE, (_full, button: string): string => {
      const code = Number(button);
      if ((code & 64) !== 0) {
        const direction = code & 3; // 0 up · 1 down · 2/3 horizontal (ignored)
        if (direction === 0) events.emit('scroll', -LINES_PER_NOTCH);
        else if (direction === 1) events.emit('scroll', LINES_PER_NOTCH);
      }
      return '';
    });

    if (cleaned.length > 0) filtered.write(cleaned);
  };

  let enabled = false;
  return {
    events,
    stdin: proxy,
    enable(): void {
      if (enabled) return;
      enabled = true;
      process.stdout.write('\x1b[?1000h\x1b[?1006h');
      source.on('data', onData);
    },
    disable(): void {
      if (!enabled) return;
      enabled = false;
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
      source.off('data', onData);
    },
  };
}

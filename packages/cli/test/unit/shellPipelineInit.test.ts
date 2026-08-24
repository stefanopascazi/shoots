/**
 * `/pipeline init` inside the shell — the argument half.
 *
 * The shell has to decide, before anything is spawned, whether a line has
 * questions to ask (run the wizard in-process, because a child gets no stdin)
 * or not (`--template` and friends spawn as usual). Getting that wrong is not a
 * cosmetic bug: the child would print "needs a terminal" and exit 2, which is
 * exactly the failure this path exists to remove.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { Shell } from '../../src/shell/Shell.js';
import { ENTER, ESC, fakeTerminal, pressUntil, renderOptions, waitForScreen } from './inkTerminal.js';
import { InitArgumentError, isInteractiveInit, parseInitArgs } from '../../src/shell/pipelineInit.js';
import { DEFAULT_INIT_FILE } from '../../src/pipeline/init/run.js';

const CWD = path.resolve('/shoots/work');

describe('which lines the shell takes over', () => {
  test('a bare init, and one that only pre-answers, are interactive', () => {
    expect(isInteractiveInit(['init'])).toBe(true);
    expect(isInteractiveInit(['init', 'my.yaml', '--var', 'shoot=D:/x'])).toBe(true);
  });

  test('the unattended forms are left to a child process', () => {
    expect(isInteractiveInit(['init', '--template', 'ingest'])).toBe(false);
    expect(isInteractiveInit(['init', '--stdout'])).toBe(false);
    expect(isInteractiveInit(['init', '--plain'])).toBe(false);
  });

  test('running a pipeline is not init', () => {
    expect(isInteractiveInit(['my.yaml', '--dry-run'])).toBe(false);
    expect(isInteractiveInit([])).toBe(false);
  });
});

describe('argument parsing', () => {
  test('the file is resolved against the shell working directory', () => {
    expect(parseInitArgs(['wedding.yaml'], CWD).file).toBe(path.join(CWD, 'wedding.yaml'));
    expect(parseInitArgs([], CWD).file).toBe(path.join(CWD, DEFAULT_INIT_FILE));
  });

  test('--var and --name become pre-answered questions', () => {
    const { initial } = parseInitArgs(['--var', 'shoot=D:/Shoots/smith', '--var', 'studio=Jane', '--name', 'ingest'], CWD);
    expect(initial['vars.shoot']).toBe('D:/Shoots/smith');
    expect(initial['vars.studio']).toBe('Jane');
    expect(initial.name).toBe('ingest');
  });

  test('a value containing = keeps everything after the first one', () => {
    expect(parseInitArgs(['--var', 'raw=D:/a=b'], CWD).initial['vars.raw']).toBe('D:/a=b');
  });

  test('--force is accepted and ignored: the wizard asks before replacing', () => {
    expect(() => parseInitArgs(['--force'], CWD)).not.toThrow();
  });

  test('malformed arguments are reported, not guessed at', () => {
    expect(() => parseInitArgs(['--var', 'shoot'], CWD)).toThrow(InitArgumentError);
    expect(() => parseInitArgs(['--name'], CWD)).toThrow(InitArgumentError);
    expect(() => parseInitArgs(['--nope'], CWD)).toThrow(/unknown option/);
    expect(() => parseInitArgs(['a.yaml', 'b.yaml'], CWD)).toThrow(/only one file/);
  });
});


describe('the shell opens the wizard in-process', () => {
  test('typing /pipeline init shows the first question, not "needs a terminal"', async () => {
    const terminal = fakeTerminal(110, 40);
    const app = render(createElement(Shell), renderOptions(terminal));
    const shows = (text: string) => (): boolean => terminal.screen().includes(text);
    try {
      await waitForScreen(terminal, 'Type / for commands');
      terminal.stdin.write('/pipeline init wizard-test.yaml');
      await waitForScreen(terminal, '/pipeline init wizard-test.yaml');

      // Enter is safe to repeat here: on the prompt an empty line does nothing,
      // and once the wizard is up this stops pressing. Asserting on the header
      // rather than on the first question keeps a repeat from failing the test.
      await pressUntil(terminal, ENTER, shows('◉ shoots pipeline init'));
      expect(terminal.screen()).not.toContain('needs a terminal');

      // Esc abandons the wizard and hands the prompt back.
      await pressUntil(terminal, ESC, shows('nothing written'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

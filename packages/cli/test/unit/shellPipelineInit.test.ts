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
import { ENTER, ESC, fakeTerminal, renderOptions, sleep, waitForScreen } from './inkTerminal.js';
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
    try {
      await waitForScreen(terminal, 'Type / for commands');
      terminal.stdin.write('/pipeline init wizard-test.yaml');
      await sleep(50);
      terminal.stdin.write(ENTER);

      await waitForScreen(terminal, 'What are you setting up?');
      expect(terminal.screen()).not.toContain('needs a terminal');

      // Esc on the first question abandons it and hands the prompt back.
      terminal.stdin.write(ESC);
      await waitForScreen(terminal, 'nothing written');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

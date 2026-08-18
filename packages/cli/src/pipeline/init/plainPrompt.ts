/**
 * The line-by-line front-end for `pipeline init`.
 *
 * It exists for the places the Ink screen cannot go — a pipe, a terminal that
 * cannot do raw mode, `--plain` because somebody prefers it — and it asks the
 * exact same questions, because both drivers read them from the same wizard.
 * Everything it prints goes to stderr, so `pipeline init --stdout > file.yaml`
 * stays a usable line.
 */
import { createInterface } from 'node:readline/promises';
import {
  AnswerError,
  describeDefault,
  nextQuestion,
  parseAnswer,
  validateAnswer,
  type Answers,
  type CatalogContext,
  type Question,
} from '@shoots/core';

/** A source of typed lines. `null` means the input ended: the user gave up. */
export interface LineReader {
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

export function createLineReader(): LineReader {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  let ended = false;
  rl.on('close', () => {
    ended = true;
  });
  return {
    async ask(prompt: string): Promise<string | null> {
      if (ended) return null;
      try {
        return await rl.question(prompt);
      } catch {
        return null; // the interface closed under us (EOF, Ctrl-C)
      }
    },
    close: () => rl.close(),
  };
}

/** Where the wizard talks. Injectable so tests can run it silently. */
export type Writer = (line: string) => void;

const stderrWriter: Writer = (line) => {
  process.stderr.write(`${line}\n`);
};

function printQuestion(out: Writer, question: Question): void {
  out('');
  out(`▸ ${question.label}`);
  if (question.hint) out(`  ${question.hint}`);
  if (question.kind === 'select' || question.kind === 'multiselect') {
    question.choices.forEach((choice, index) => {
      const hint = choice.hint ? `  — ${choice.hint}` : '';
      out(`   ${String(index + 1).padStart(2)}) ${choice.label}${hint}`);
    });
  }
}

function promptFor(question: Question): string {
  const fallback = describeDefault(question);
  switch (question.kind) {
    case 'confirm':
      return `  [${question.default ? 'Y/n' : 'y/N'}] `;
    case 'multiselect':
      return `  numbers or names, comma-separated${fallback ? ` [${fallback}]` : ''} ('-' for none): `;
    case 'select':
      return `  number or name${fallback ? ` [${fallback}]` : ''}: `;
    case 'text':
      return fallback ? `  [${fallback}] ` : '  ';
  }
}

/**
 * Ask everything the wizard has left. Returns null when the user abandons it —
 * an ended stdin is an answer too, and it is not "write the file anyway".
 */
export async function runPlainWizard(
  context: CatalogContext,
  reader: LineReader,
  initial: Answers = {},
  out: Writer = stderrWriter,
): Promise<Answers | null> {
  const answers: Answers = { ...initial };

  out('shoots pipeline init — a few questions, then a file you can edit and re-run.');
  out("Press enter to take the default shown in brackets, Ctrl-C to stop.");

  for (;;) {
    const question = nextQuestion(answers, context);
    if (!question) return answers;

    printQuestion(out, question);
    for (;;) {
      const raw = await reader.ask(promptFor(question));
      if (raw === null) return null;
      let value;
      try {
        value = parseAnswer(question, raw);
      } catch (err) {
        out(`  ! ${err instanceof AnswerError ? err.message : String(err)}`);
        continue;
      }
      const problem = validateAnswer(question, value);
      if (problem) {
        out(`  ! ${problem}`);
        continue;
      }
      answers[question.id] = value;
      break;
    }
  }
}

/** Final yes/no, used before writing over anything or at the end of the wizard. */
export async function confirm(reader: LineReader, label: string, fallback = true): Promise<boolean> {
  const value = await reader.ask(`${label} [${fallback ? 'Y/n' : 'y/N'}] `);
  if (value === null) return false;
  const text = value.trim().toLowerCase();
  if (text.length === 0) return fallback;
  return ['y', 'yes', 'true', '1'].includes(text);
}

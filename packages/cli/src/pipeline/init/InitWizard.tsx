/**
 * The Ink front-end for `pipeline init`: one question on screen at a time, with
 * the file it is building shown before anything is written.
 *
 * It renders whatever `nextQuestion` hands it — there is no per-question code
 * here — so the plain prompt and this screen can never ask different things.
 * Answering backwards is the reason the asked-question stack exists: dropping
 * the last answer is enough to make the wizard ask it again, because which
 * questions exist is derived from the answers, never stored.
 */
import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  buildDraft,
  defaultOf,
  draftHeader,
  nextQuestion,
  renderPipelineYaml,
  validateAnswer,
  wizardQuestions,
  type AnswerValue,
  type Answers,
  type CatalogContext,
  type Question,
} from '@shoots/core';

interface InitWizardProps {
  context: CatalogContext;
  initial: Answers;
  /** Shown on the review screen, and in the `--dry-run`-style command hints. */
  fileName: string;
  /** True when the target file is already there: the review screen says so. */
  exists: boolean;
  onDone(answers: Answers | null): void;
}

const PREVIEW_LINES = 24;

/** How an already-given answer reads in the recap column. */
function summarize(value: AnswerValue): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  return value.length > 0 ? value : '—';
}

export function InitWizard({ context, initial, fileName, exists, onDone }: InitWizardProps): React.JSX.Element {
  const { exit } = useApp();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [asked, setAsked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [primed, setPrimed] = useState<string | null>(null);

  const question = nextQuestion(answers, context);
  const total = wizardQuestions(answers, context).length;
  const position = Math.min(asked.length + 1, total);

  // Entering a question: seed the editing state from its default.
  if (question && primed !== question.id) {
    const fallback = defaultOf(question);
    setPrimed(question.id);
    setError(null);
    setText(typeof fallback === 'string' ? fallback : '');
    setPicked(Array.isArray(fallback) ? [...fallback] : []);
    setCursor(
      question.kind === 'select'
        ? Math.max(0, question.choices.findIndex((choice) => choice.value === question.default))
        : 0,
    );
  }

  const yaml = useMemo(() => {
    if (question) return '';
    try {
      return renderPipelineYaml(buildDraft(answers, context), { header: draftHeader(fileName) });
    } catch (err) {
      return `# could not render: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, [question, answers, context, fileName]);

  const commit = (value: AnswerValue): void => {
    const problem = question ? validateAnswer(question, value) : 'no question';
    if (problem) {
      setError(problem);
      return;
    }
    if (!question) return;
    setAnswers({ ...answers, [question.id]: value });
    setAsked([...asked, question.id]);
    setPrimed(null);
  };

  const back = (): void => {
    const previous = asked[asked.length - 1];
    if (!previous) return;
    const next = { ...answers };
    delete next[previous];
    setAnswers(next);
    setAsked(asked.slice(0, -1));
    setPrimed(null);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (asked.length === 0) {
        onDone(null);
        exit();
        return;
      }
      back();
      return;
    }

    if (!question) {
      // Review screen: write it, go back one answer, or leave with nothing.
      if (key.return || input.toLowerCase() === 'y') {
        onDone(answers);
        exit();
      } else if (input.toLowerCase() === 'n' || input.toLowerCase() === 'q') {
        onDone(null);
        exit();
      } else if (input.toLowerCase() === 'b') {
        back();
      }
      return;
    }

    switch (question.kind) {
      case 'text': {
        if (key.return) {
          commit(text.trim().length > 0 ? text : (defaultOf(question) as string));
          return;
        }
        if (key.backspace || key.delete) {
          setText(text.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) setText(text + input);
        return;
      }
      case 'confirm': {
        if (key.return) {
          commit(question.default);
          return;
        }
        const lower = input.toLowerCase();
        if (lower === 'y') commit(true);
        else if (lower === 'n') commit(false);
        return;
      }
      case 'select': {
        if (key.upArrow) setCursor((cursor + question.choices.length - 1) % question.choices.length);
        else if (key.downArrow) setCursor((cursor + 1) % question.choices.length);
        else if (key.return) commit(question.choices[cursor]!.value);
        return;
      }
      case 'multiselect': {
        if (key.upArrow) setCursor((cursor + question.choices.length - 1) % question.choices.length);
        else if (key.downArrow) setCursor((cursor + 1) % question.choices.length);
        else if (input === ' ') {
          const value = question.choices[cursor]!.value;
          setPicked(picked.includes(value) ? picked.filter((item) => item !== value) : [...picked, value]);
        } else if (key.return) commit(picked);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan">◉ shoots pipeline init</Text>
        <Text dimColor>{question ? `question ${position}/${total}` : `review — ${fileName}`}</Text>
      </Box>

      {question ? (
        <QuestionView
          question={question}
          text={text}
          cursor={cursor}
          picked={picked}
          error={error}
          canGoBack={asked.length > 0}
        />
      ) : (
        <ReviewView yaml={yaml} fileName={fileName} exists={exists} />
      )}

      {asked.length > 0 && question ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>answered</Text>
          {asked.slice(-4).map((id) => (
            <Text key={id} dimColor>
              {`  ${id}: ${summarize(answers[id]!)}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function QuestionView({
  question,
  text,
  cursor,
  picked,
  error,
  canGoBack,
}: {
  question: Question;
  text: string;
  cursor: number;
  picked: string[];
  error: string | null;
  canGoBack: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{question.label}</Text>
      {question.hint ? <Text dimColor>{question.hint}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        {question.kind === 'text' ? (
          <Text>
            {'> '}
            <Text color="green">{text}</Text>
            <Text inverse> </Text>
          </Text>
        ) : null}

        {question.kind === 'confirm' ? (
          <Text>{question.default ? 'Y / n' : 'y / N'}</Text>
        ) : null}

        {question.kind === 'select' || question.kind === 'multiselect'
          ? question.choices.map((choice, index) => {
              const active = index === cursor;
              const box =
                question.kind === 'multiselect' ? (picked.includes(choice.value) ? '[x] ' : '[ ] ') : '';
              return (
                <Text key={choice.value} color={active ? 'cyan' : undefined}>
                  {`${active ? '❯ ' : '  '}${box}${choice.label}`}
                  {choice.hint ? <Text dimColor>{`  ${choice.hint}`}</Text> : null}
                </Text>
              );
            })
          : null}
      </Box>

      {error ? <Text color="red">{`! ${error}`}</Text> : null}

      <Box marginTop={1}>
        <Text dimColor>
          {question.kind === 'multiselect'
            ? 'space toggle · ↑↓ move · enter accept'
            : question.kind === 'select'
              ? '↑↓ move · enter accept'
              : question.kind === 'confirm'
                ? 'y / n · enter takes the default'
                : 'enter accept (empty keeps the default)'}
          {canGoBack ? ' · esc back' : ' · esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}

function ReviewView({
  yaml,
  fileName,
  exists,
}: {
  yaml: string;
  fileName: string;
  exists: boolean;
}): React.JSX.Element {
  const lines = yaml.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`This is ${fileName}:`}</Text>
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        {shown.map((line, index) => (
          <Text key={index} color={line.trimStart().startsWith('#') ? 'gray' : undefined}>
            {line.length > 0 ? line : ' '}
          </Text>
        ))}
        {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} more line(s)`}</Text> : null}
      </Box>
      {exists ? <Text color="yellow">{`${fileName} already exists — writing replaces it.`}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>enter / y write · b back one answer · n cancel</Text>
      </Box>
    </Box>
  );
}

/**
 * The question language the `pipeline init` wizard is written in.
 *
 * Both front-ends — the Ink screen and the plain readline prompt — consume this
 * same declarative shape, so a question is added once and both modes get it.
 * Nothing here renders or reads anything: it declares what to ask, validates an
 * answer, and turns typed text into a value.
 */

export type AnswerValue = string | boolean | string[];
export type Answers = Record<string, AnswerValue>;

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

interface BaseQuestion {
  /** Key this answer is stored under. */
  id: string;
  label: string;
  hint?: string;
}

export interface TextQuestion extends BaseQuestion {
  kind: 'text';
  default?: string;
  /** An empty answer is allowed (the flag is simply left out). */
  optional?: boolean;
}

export interface SelectQuestion extends BaseQuestion {
  kind: 'select';
  choices: Choice[];
  default: string;
}

export interface MultiSelectQuestion extends BaseQuestion {
  kind: 'multiselect';
  choices: Choice[];
  default: string[];
  /** Refuse an empty selection (the steps list cannot be empty). */
  minimum?: number;
}

export interface ConfirmQuestion extends BaseQuestion {
  kind: 'confirm';
  default: boolean;
}

export type Question = TextQuestion | SelectQuestion | MultiSelectQuestion | ConfirmQuestion;

/** The value a question starts on, used by both the UI and `--template`. */
export function defaultOf(question: Question): AnswerValue {
  switch (question.kind) {
    case 'text':
      return question.default ?? '';
    case 'select':
      return question.default;
    case 'multiselect':
      return [...question.default];
    case 'confirm':
      return question.default;
  }
}

/** Null when the value is usable, otherwise the reason it is not. */
export function validateAnswer(question: Question, value: AnswerValue): string | null {
  switch (question.kind) {
    case 'text': {
      if (typeof value !== 'string') return 'expected text';
      if (!question.optional && value.trim().length === 0) return 'a value is required';
      return null;
    }
    case 'select': {
      if (typeof value !== 'string') return 'expected one of the choices';
      return question.choices.some((c) => c.value === value)
        ? null
        : `unknown choice '${value}' (expected: ${question.choices.map((c) => c.value).join(', ')})`;
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return 'expected a list of choices';
      const unknown = value.filter((v) => !question.choices.some((c) => c.value === v));
      if (unknown.length > 0) return `unknown choice(s): ${unknown.join(', ')}`;
      const min = question.minimum ?? 0;
      if (value.length < min) return `pick at least ${min}`;
      return null;
    }
    case 'confirm':
      return typeof value === 'boolean' ? null : 'expected yes or no';
  }
}

const YES = new Set(['y', 'yes', 'true', '1', 'on']);
const NO = new Set(['n', 'no', 'false', '0', 'off']);

/** Resolve one token of a (multi)select answer: a choice value, or its 1-based position. */
function resolveChoice(question: SelectQuestion | MultiSelectQuestion, token: string): string | null {
  const exact = question.choices.find((c) => c.value === token);
  if (exact) return exact.value;
  const index = Number.parseInt(token, 10);
  if (Number.isInteger(index) && index >= 1 && index <= question.choices.length) {
    return question.choices[index - 1]!.value;
  }
  return null;
}

export class AnswerError extends Error {}

/**
 * Typed line → value, for the plain prompt. Empty input takes the default,
 * which is what makes "press enter through the whole wizard" a usable path.
 */
export function parseAnswer(question: Question, raw: string): AnswerValue {
  const text = raw.trim();
  if (text.length === 0) return defaultOf(question);

  switch (question.kind) {
    case 'text':
      return text;
    case 'confirm': {
      const lower = text.toLowerCase();
      if (YES.has(lower)) return true;
      if (NO.has(lower)) return false;
      throw new AnswerError(`answer yes or no, not '${text}'`);
    }
    case 'select': {
      const value = resolveChoice(question, text);
      if (!value) throw new AnswerError(`unknown choice '${text}'`);
      return value;
    }
    case 'multiselect': {
      if (text === '-') return [];
      const tokens = text
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const values: string[] = [];
      for (const token of tokens) {
        const value = resolveChoice(question, token);
        if (!value) throw new AnswerError(`unknown choice '${token}'`);
        if (!values.includes(value)) values.push(value);
      }
      return values;
    }
  }
}

/** A one-line rendering of the default, for the prompt's `[…]` hint. */
export function describeDefault(question: Question): string {
  const value = defaultOf(question);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  return value.length > 0 ? value : '';
}

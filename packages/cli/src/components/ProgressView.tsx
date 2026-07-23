/**
 * Ink component rendering batch job progress:
 *
 *   Culling photos  [██████████░░░░░░░░░░]  12/40  _MG_4021.CR3
 */
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ProgressTracker } from '../progress.js';

export interface ProgressViewProps {
  tracker: ProgressTracker;
  title: string;
  /** Bar width in characters. Default: 24. */
  barWidth?: number;
}

interface ProgressState {
  completed: number;
  total: number;
  label: string;
}

export function ProgressView({ tracker, title, barWidth = 24 }: ProgressViewProps) {
  const [state, setState] = useState<ProgressState>({
    completed: tracker.completed,
    total: tracker.total,
    label: tracker.label,
  });

  useEffect(() => {
    const onProgress = () => {
      setState({ completed: tracker.completed, total: tracker.total, label: tracker.label });
    };
    tracker.on('progress', onProgress);
    return () => {
      tracker.off('progress', onProgress);
    };
  }, [tracker]);

  const ratio = state.total > 0 ? state.completed / state.total : 0;
  const filled = Math.round(ratio * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const done = state.total > 0 && state.completed >= state.total;

  return (
    <Box gap={1}>
      <Text bold>{title}</Text>
      <Text color={done ? 'green' : 'cyan'}>[{bar}]</Text>
      <Text>
        {state.completed}/{state.total}
      </Text>
      {state.label !== '' && <Text dimColor>{state.label}</Text>}
    </Box>
  );
}

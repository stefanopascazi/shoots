/**
 * Presentational review card for one uncertain (rescued) frame. Input is owned
 * by the shell's single `useInput`, so this component only draws: the scores,
 * the aperture, and a focus heatmap showing where the sharp region landed.
 */
import { Box, Text } from 'ink';
import { focusHeatmap, HEATMAP_BLOCKS, HEATMAP_COLORS } from './heatmap.js';
import type { ReviewItem } from './triageService.js';

export interface ReviewOverlayProps {
  item: ReviewItem;
  index: number;
  total: number;
  kept: number;
  discarded: number;
  dryRun: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function ReviewOverlay({ item, index, total, kept, discarded, dryRun }: ReviewOverlayProps) {
  const grid = focusHeatmap(item.focusMap);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text>
        <Text color="magenta" bold>
          Review {index + 1}/{total}
        </Text>
        <Text dimColor> · uncertain — subject in focus but frame is soft (shallow DoF)</Text>
        {dryRun && <Text color="cyan"> · dry run</Text>}
      </Text>

      <Box marginTop={1}>
        <Box flexDirection="column" marginRight={2}>
          {grid.map((row, r) => (
            <Text key={r}>
              {row.map((lvl, c) => (
                <Text key={c} color={HEATMAP_COLORS[lvl]}>
                  {HEATMAP_BLOCKS[lvl]}
                  {HEATMAP_BLOCKS[lvl]}
                </Text>
              ))}
            </Text>
          ))}
          <Text dimColor>focus map · each cell = a region</Text>
          <Text>
            <Text dimColor>soft </Text>
            {HEATMAP_BLOCKS.map((block, lvl) => (
              <Text key={lvl} color={HEATMAP_COLORS[lvl]}>
                {block}
              </Text>
            ))}
            <Text dimColor> sharp</Text>
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold wrap="truncate-middle">
            {item.name}
          </Text>
          <Text dimColor>
            score <Text color="white">{round1(item.score)}</Text> · focus{' '}
            <Text color="white">{round1(item.focusPeak)}</Text>
            {item.aperture ? (
              <Text>
                {' '}
                · <Text color="white">f/{item.aperture}</Text>
              </Text>
            ) : null}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              kept <Text color="green">{kept}</Text> · discarded <Text color="yellow">{discarded}</Text>
            </Text>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text color="green" bold>
            K
          </Text>
          <Text dimColor>eep · </Text>
          <Text color="yellow" bold>
            D
          </Text>
          <Text dimColor>iscard · </Text>
          <Text color="cyan" bold>
            P
          </Text>
          <Text dimColor>review · </Text>
          <Text bold>S</Text>
          <Text dimColor>kip · </Text>
          <Text bold>Esc</Text>
          <Text dimColor> finish</Text>
        </Text>
      </Box>
    </Box>
  );
}

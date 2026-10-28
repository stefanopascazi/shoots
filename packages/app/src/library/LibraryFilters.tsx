/** @jsxImportSource preact */
import { Segmented, Select } from '@shoots/ui';
import type { Filter, LabelFilter, Sort, Totals } from './model.js';

const LABEL_OPTIONS: { value: LabelFilter; label: string }[] = [
  { value: 'any', label: 'Any label' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'none', label: 'No label' },
];

export interface LibraryFiltersProps {
  sum: Totals;
  filter: Filter;
  label: LabelFilter;
  sort: Sort;
  onFilter: (f: Filter) => void;
  onLabel: (l: LabelFilter) => void;
  onSort: (s: Sort) => void;
}

/** Which photos the grid shows, by flag and colour label, and in what order. */
export function LibraryFilters({ sum, filter, label, sort, onFilter, onLabel, onSort }: LibraryFiltersProps) {
  return (
    <div class="app-toolbar">
      <Segmented<Filter>
        label="Show"
        value={filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: `All ${sum.total}` },
          { value: 'picks', label: `Picks ${sum.picks}` },
          { value: 'keepers', label: `Not rejected ${sum.total - sum.rejected}` },
          { value: 'rejected', label: `Rejected ${sum.rejected}` },
          ...(sum.toReview ? [{ value: 'review' as const, label: `To review ${sum.toReview}` }] : []),
        ]}
      />
      <Select
        id="label-filter"
        class="app-label-filter"
        aria-label="Colour label"
        value={label}
        onChange={(e) => onLabel((e.currentTarget as HTMLSelectElement).value as LabelFilter)}
      >
        {LABEL_OPTIONS.map((o) => (
          <option value={o.value}>{o.label}</option>
        ))}
      </Select>
      <span class="sh-spacer" />
      <Segmented<Sort>
        label="Sort"
        value={sort}
        onChange={onSort}
        options={[
          { value: 'name', label: 'Name' },
          { value: 'rating', label: 'Rating' },
        ]}
      />
    </div>
  );
}

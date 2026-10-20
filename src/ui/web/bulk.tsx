import { useState } from 'react';
import type { Category } from '../../model/category.ts';
import { Problem, useSend, type OnView } from './actions.tsx';
import { repoKey, type Item } from './model.ts';

// PLAN.md Phase 5 bulk actions, on the flows the filters show now.
export function Bulk({ items, categories, onView }: { items: readonly Item[]; categories: readonly Category[]; onView: OnView }) {
  const { busy, error, send } = useSend(onView);
  const [category, setCategory] = useState('');
  const flows = items.map((item) => ({ repo: repoKey(item.repo), flow: item.flow.id }));
  const apply = (change: object) => send('/api/bulk', { flows, ...change });
  const off = items.length === 0 || busy;
  return (
    <div className="bulk" role="group" aria-label={`Change the ${items.length} flows shown`}>
      <span className="muted">The {items.length} shown:</span>
      <button type="button" disabled={off} onClick={() => apply({ patch: { enabled: true } })}>
        Enable
      </button>
      <button type="button" disabled={off} onClick={() => apply({ patch: { enabled: false } })}>
        Disable
      </button>
      <button type="button" disabled={off} onClick={() => apply({ verdict: 'correct' })}>
        Mark correct
      </button>
      <button type="button" disabled={off} onClick={() => apply({ verdict: 'wrong' })}>
        Mark wrong
      </button>
      <select id="bulk-category" aria-label="Move the shown flows to a category" value={category} disabled={off} onChange={(event) => setCategory(event.target.value)}>
        <option value="">Move to category…</option>
        {categories.map((own) => (
          <option key={own.id} value={own.id}>
            {own.name}
          </option>
        ))}
      </select>
      <button type="button" disabled={off || category === ''} onClick={() => apply({ patch: { category } }).then((ok) => ok && setCategory(''))}>
        Move
      </button>
      <Problem error={error} />
    </div>
  );
}

import type { QaEntry } from '../../engine/qa.ts';
import { repoKey, type Item } from './model.ts';
import { TaskStatus, type Task } from './task.tsx';

const LABEL = { ready: 'AI: ready', 'needs-work': 'AI: needs work', 'not-testable': 'AI: not testable' } as const;

export const QaBadge = ({ qa }: { qa: QaEntry }) => (
  <span className={`badge qa-${qa.verdict}`} title={`${qa.functional} ${qa.end_to_end}`}>
    {LABEL[qa.verdict]}
  </span>
);

const flowsOf = (items: Item[]) => items.map((item) => ({ repo: repoKey(item.repo), flow: item.flow.id }));

// In a flow's panel: what the AI thought of it as a test, and a button to ask again. The AI's advice never switches
// a flow on or off.
export function QaSection({ item, task }: { item: Item; task: Task }) {
  const { qa } = item;
  return (
    <section>
      <h3>AI check</h3>
      {qa === undefined ? (
        <p className="muted">Not checked since it last changed. The AI reads the steps as a QA engineer would: are the results specific, and does it run end to end?</p>
      ) : (
        <>
          <p>
            <QaBadge qa={qa} /> <span className="muted">{qa.at.slice(0, 10)}</span>
          </p>
          <p>
            <strong>Functional.</strong> {qa.functional}
          </p>
          <p>
            <strong>End to end.</strong> {qa.end_to_end}
          </p>
          {qa.gaps.length === 0 ? null : (
            <ul className="notes">
              {qa.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <button type="button" disabled={task.running !== null} onClick={() => task.start('/api/qa', { flows: flowsOf([item]) })}>
        {qa === undefined ? 'Check with AI' : 'Check again'}
      </button>
    </section>
  );
}

// Above the list: check the flows now shown, newest and changed ones first being the usual ones to filter to.
export function QaBar({ items, task }: { items: Item[]; task: Task }) {
  const todo = items.filter((item) => item.qa === undefined && item.flow.status !== 'rejected');
  if (items.length === 0) return null;
  return (
    <span className="button-row">
      <button type="button" disabled={task.running !== null || todo.length === 0} title="Uses the AI chosen under AI naming; the answers are kept while a flow is unchanged" onClick={() => task.start('/api/qa', { flows: flowsOf(todo) })}>
        Check {todo.length} unchecked with AI
      </button>
      <TaskStatus task={task} kind="qa" />
    </span>
  );
}

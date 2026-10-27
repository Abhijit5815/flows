import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { useMemo, useState, type CSSProperties } from 'react';
import type { Category } from '../../model/category.ts';
import { NO_ROUTE, NOT_OBSERVED, ROLE_NOT_EXPLORED, STALE, unstable, whereOf, type Item } from './model.ts';

// PLAN.md Phase 5: nodes are steps, lanes are categories. Each flow is a row in its category's lane: a header
// node, then its steps left to right. Positions are computed here; nothing is dragged.
const LEFT = 24;
const HEADER_W = 300;
const STEP_W = 250;
const GAP = 40;
const ROW_GAP = 20;
const LANE_TOP = 48; // room for the lane's label
const NAME_LINES = 3; // as clamped in styles.css; the full text is in the tooltip and the side panel
const CLAIM_LINES = 4;

// How tall a card will be, from its text: the first layout uses this, and the rows are laid out again from the
// heights React Flow measures, so each row is its tallest card plus the same gap.
const lines = (text: string, perLine: number, cap: number) => Math.min(cap, Math.max(1, Math.ceil((text.length * 1.1) / perLine)));
const badgeRows = (labels: readonly string[], width: number) => Math.max(1, Math.ceil(labels.reduce((sum, text) => sum + text.length * 6.5 + 22, 0) / width));
function rowHeight(item: Item, measured: ReadonlyMap<string, number>): number {
  const { flow } = item;
  const card = 18 + 4; // padding and border
  const head = measured.get(`${item.key}>flow`) ?? card + badgeRows(flowBadges(item), HEADER_W - 24) * 22 + lines(flow.name, 34, NAME_LINES) * 18 + (whereOf(flow) === undefined ? 0 : 17) + 18;
  const steps = flow.steps.map((step) => measured.get(`${item.key}>${step.id}`) ?? card + badgeRows(stepBadges(step), STEP_W - 22) * 22 + lines(step.claim, 32, CLAIM_LINES) * 17);
  return Math.max(76, head, ...steps) + ROW_GAP;
}

type LaneData = { category: Category; count: number; width: number; height: number };
type FlowData = { item: Item; selected: boolean };
type StepData = { item: Item; index: number; selected: boolean };
type CanvasNode = Node<LaneData, 'lane'> | Node<FlowData, 'flow'> | Node<StepData, 'step'>;

function LaneNode({ data }: NodeProps<Node<LaneData, 'lane'>>) {
  return (
    <div className={`lane${data.category.enabled ? '' : ' is-off'}`} style={{ width: data.width, height: data.height, '--lane': data.category.color } as CSSProperties}>
      <span className="lane-label">
        {data.category.name} <span className="lane-count">{data.count}</span>
        {data.category.enabled ? '' : ' · switched off'}
      </span>
    </div>
  );
}

// The badges a flow card shows, by their text; the card and the row height both use this list.
function flowBadges({ flow }: Item): string[] {
  return [
    flow.status,
    flow.kind.toUpperCase(),
    flow.confidence.toFixed(2),
    ...(flow.destructive !== 'no' && flow.status !== 'rejected' ? ['review'] : []),
    ...[NOT_OBSERVED, ROLE_NOT_EXPLORED, STALE, NO_ROUTE].filter((tag) => flow.tags.includes(tag)),
    ...(flow.enabled ? [] : ['off']),
  ];
}

const stepBadges = (step: Item['flow']['steps'][number]): string[] => [
  step.kind,
  ...(step.check === null && step.kind !== 'subflow' ? ['no check'] : []),
  ...(unstable(step) ? ['no stable selector'] : []),
  ...(step.enabled ? [] : ['off']),
];

function FlowNode({ data }: NodeProps<Node<FlowData, 'flow'>>) {
  const { flow } = data.item;
  const held = flow.destructive !== 'no' && flow.status !== 'rejected';
  return (
    <div className={`flow-node${data.selected ? ' is-selected' : ''}${flow.enabled ? '' : ' is-off'}`}>
      <div className="flow-badges">
        <span className={`pill status-${flow.status}`}>{flow.status}</span>
        <span className="badge">{flow.kind.toUpperCase()}</span>
        <span className="badge" title="confidence">{flow.confidence.toFixed(2)}</span>
        {held ? <span className="badge warn" title={`destructive: ${flow.destructive}`}>review</span> : null}
        {flow.tags.includes(NOT_OBSERVED) ? <span className="badge gap">not observed</span> : null}
        {flow.tags.includes(ROLE_NOT_EXPLORED) ? <span className="badge gap">role not explored</span> : null}
        {flow.tags.includes(STALE) ? <span className="badge warn" title="it cites code the repo no longer has">stale</span> : null}
        {flow.tags.includes(NO_ROUTE) ? <span className="badge warn" title="it calls the API at a path no route answers">no backend route</span> : null}
        {flow.enabled ? null : <span className="badge muted">off</span>}
      </div>
      <div className="flow-name" title={flow.name}>
        {flow.name}
      </div>
      {whereOf(flow) === undefined ? null : <div className="flow-path">{whereOf(flow)}</div>}
      <div className="flow-meta">
        {flow.id} · {data.item.repo.path}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepData, 'step'>>) {
  const step = data.item.flow.steps[data.index];
  return (
    <div className={`step-node kind-${step.kind}${data.selected ? ' is-selected' : ''}${step.enabled ? '' : ' is-off'}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="step-badges">
        <span className="step-kind">{step.kind}</span>
        {step.check === null && step.kind !== 'subflow' ? <span className="badge muted">no check</span> : null}
        {unstable(step) ? <span className="badge warn">no stable selector</span> : null}
        {step.enabled ? null : <span className="badge muted">off</span>}
      </div>
      <div className="step-claim" title={step.claim}>
        {step.claim}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { lane: LaneNode, flow: FlowNode, step: StepNode };

function layout(items: readonly Item[], categories: readonly Category[], selected: string | undefined, measured: ReadonlyMap<string, number>): { nodes: CanvasNode[]; edges: Edge[] } {
  const known = new Map(categories.map((category) => [category.id, category]));
  const lanes = [...categories.map((category) => category.id), ...new Set(items.map((item) => item.flow.category).filter((id) => !known.has(id)))];
  const nodes: CanvasNode[] = [];
  const edges: Edge[] = [];
  let top = 0;
  for (const id of lanes) {
    const rows = items.filter((item) => item.flow.category === id);
    if (rows.length === 0) continue;
    const category = known.get(id) ?? { id, name: id, color: '#888888', editable: true, enabled: true };
    // Every lane as wide as the longest flow on the page, so their edges line up.
    const widest = Math.max(...items.map((item) => item.flow.steps.length));
    const width = LEFT + HEADER_W + widest * (STEP_W + GAP) + GAP;
    const heights = rows.map((item) => rowHeight(item, measured));
    const height = LANE_TOP + heights.reduce((sum, each) => sum + each, 0);
    nodes.push({ id: `lane:${id}`, type: 'lane', position: { x: 0, y: top }, data: { category, count: rows.length, width, height }, selectable: false, draggable: false, zIndex: -1 });
    rows.forEach((item, row) => {
      const y = top + LANE_TOP + heights.slice(0, row).reduce((sum, each) => sum + each, 0);
      const isSelected = item.key === selected;
      nodes.push({ id: `${item.key}>flow`, type: 'flow', position: { x: LEFT, y }, data: { item, selected: isSelected } });
      item.flow.steps.forEach((step, index) => {
        const id = `${item.key}>${step.id}`;
        nodes.push({ id, type: 'step', position: { x: LEFT + HEADER_W + GAP + index * (STEP_W + GAP), y }, data: { item, index, selected: isSelected } });
        const from = index === 0 ? `${item.key}>flow` : `${item.key}>${item.flow.steps[index - 1].id}`;
        edges.push({ id: `${from}->${id}`, source: from, target: id, markerEnd: { type: MarkerType.ArrowClosed }, className: isSelected ? 'is-selected' : '' });
      });
    });
    top += height + GAP;
  }
  return { nodes, edges };
}

type CanvasProps = { items: readonly Item[]; categories: readonly Category[]; selected: string | undefined; onSelect: (key: string) => void };

export function Canvas({ items, categories, selected, onSelect }: CanvasProps) {
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(new Map());
  const { nodes, edges } = useMemo(() => layout(items, categories, selected, measured), [items, categories, selected, measured]);
  // Card heights as rendered; set only when one changed, so laying the rows out again settles at once.
  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    const sized = changes.flatMap((change) => (change.type === 'dimensions' && change.dimensions !== undefined && !change.id.startsWith('lane:') ? [[change.id, Math.round(change.dimensions.height)] as const] : []));
    if (sized.some(([id, height]) => measured.get(id) !== height)) setMeasured((known) => new Map([...known, ...sized]));
  };
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => {
        if (node.type !== 'lane') onSelect((node.data as FlowData | StepData).item.key);
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      colorMode="system"
      // Lanes run long, so the canvas opens at a readable size at the top and the wheel scrolls through it.
      defaultViewport={{ x: 16, y: 16, zoom: 0.85 }}
      panOnScroll
      minZoom={0.05}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

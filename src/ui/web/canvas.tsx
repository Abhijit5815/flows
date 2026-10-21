import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useMemo, type CSSProperties } from 'react';
import type { Category } from '../../model/category.ts';
import { NOT_OBSERVED, ROLE_NOT_EXPLORED, unstable, type Item } from './model.ts';

// PLAN.md Phase 5: nodes are steps, lanes are categories. Each flow is a row in its category's lane: a header
// node, then its steps left to right. Positions are computed here; nothing is dragged.
const LEFT = 24;
const HEADER_W = 300;
const STEP_W = 250;
const GAP = 40;
const ROW_H = 104;
const LANE_TOP = 48; // room for the lane's label

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
        {flow.enabled ? null : <span className="badge muted">off</span>}
      </div>
      <div className="flow-name">{flow.name}</div>
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
      <div className="step-claim">{step.claim}</div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { lane: LaneNode, flow: FlowNode, step: StepNode };

function layout(items: readonly Item[], categories: readonly Category[], selected: string | undefined): { nodes: CanvasNode[]; edges: Edge[] } {
  const known = new Map(categories.map((category) => [category.id, category]));
  const lanes = [...categories.map((category) => category.id), ...new Set(items.map((item) => item.flow.category).filter((id) => !known.has(id)))];
  const nodes: CanvasNode[] = [];
  const edges: Edge[] = [];
  let top = 0;
  for (const id of lanes) {
    const rows = items.filter((item) => item.flow.category === id);
    if (rows.length === 0) continue;
    const category = known.get(id) ?? { id, name: id, color: '#888888', editable: true, enabled: true };
    const widest = Math.max(...rows.map((item) => item.flow.steps.length));
    const width = LEFT + HEADER_W + widest * (STEP_W + GAP) + GAP;
    const height = LANE_TOP + rows.length * ROW_H;
    nodes.push({ id: `lane:${id}`, type: 'lane', position: { x: 0, y: top }, data: { category, count: rows.length, width, height }, selectable: false, draggable: false, zIndex: -1 });
    rows.forEach((item, row) => {
      const y = top + LANE_TOP + row * ROW_H;
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
  const { nodes, edges } = useMemo(() => layout(items, categories, selected), [items, categories, selected]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
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

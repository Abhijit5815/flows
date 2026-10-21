import type { Flow } from '../model/flow.ts';

export type Verdict = 'correct' | 'wrong' | 'never';

export type JudgeInput = {
  claims: number;
  proven: number;
  unreachable: string | undefined; // why the flow can't be reached, if it can't
  destructive: Flow['destructive'];
  verdict: Verdict | undefined; // a reviewer's, from the repo's rules
  sourceOnlyWeight: number;
  seen?: boolean; // the live app showed every step (Phase 3 cross-check)
};

export type Judgement = Pick<Flow, 'status' | 'confidence' | 'enabled'> & { reasons: string[] };

const refusedBy = (verdict: Verdict | undefined): Judgement | undefined =>
  verdict === 'wrong'
    ? { status: 'rejected', confidence: 0, enabled: false, reasons: ['a reviewer marked it wrong'] }
    : verdict === 'never'
      ? { status: 'rejected', confidence: 0, enabled: false, reasons: ['a reviewer said never to suggest it again'] }
      : undefined;

// PLAN.md Phase 4 judge. Status follows PLAN.md §4: verified means every claim has source evidence and the flow is
// reachable; confirmed (Phase 3) means the live app showed it too, which also settles a reachability the static check
// got wrong. Confidence is the share of claims proven, weighted down when only source backs it. Fail closed: only
// verified or confirmed, non-destructive flows start enabled, until a reviewer says so.
export function judge(input: JudgeInput): Judgement {
  const refused = refusedBy(input.verdict);
  if (refused !== undefined) return refused;
  const reasons: string[] = [];
  let status: Flow['status'] = 'verified';
  const seen = input.seen === true;
  if (input.unreachable !== undefined && seen) reasons.push(`the static check found it unreachable (${input.unreachable}), but the live app reached it`);
  if (input.unreachable !== undefined && !seen) {
    status = 'unreachable';
    reasons.push(`unreachable: ${input.unreachable}`);
  } else if (input.proven < input.claims) {
    status = 'unverified';
    reasons.push(`${input.claims - input.proven} of ${input.claims} claims are not backed by source${seen ? ', though the live app showed every step' : ''}`);
  } else if (seen) {
    status = 'confirmed';
    reasons.push('confirmed: the live app showed every step');
  }
  if (input.destructive !== 'no') reasons.push(`held for review: destructive is ${input.destructive}`);
  if (input.verdict === 'correct') {
    reasons.push('a reviewer marked it correct');
    return { status, confidence: 1, enabled: status !== 'unreachable', reasons };
  }
  const weight = status === 'confirmed' ? 1 : input.sourceOnlyWeight;
  const confidence = Math.round((input.proven / input.claims) * weight * 100) / 100;
  return { status, confidence, enabled: (status === 'verified' || status === 'confirmed') && input.destructive === 'no', reasons };
}

// A flow seen on the live app that no source flow matches (PLAN.md §4 observed-only): every claim cites what the run
// captured, and only the weight says how far one input alone is trusted. It is shown for review and stays off until
// a reviewer marks it correct.
export function judgeObserved(input: { destructive: Flow['destructive']; verdict: Verdict | undefined; weight: number }): Judgement {
  const refused = refusedBy(input.verdict);
  if (refused !== undefined) return refused;
  const reasons = ['observed-only: seen on the live app, with no matching flow in source'];
  if (input.destructive !== 'no') reasons.push(`held for review: destructive is ${input.destructive}`);
  if (input.verdict === 'correct') return { status: 'observed-only', confidence: 1, enabled: true, reasons: [...reasons, 'a reviewer marked it correct'] };
  return { status: 'observed-only', confidence: input.weight, enabled: false, reasons };
}

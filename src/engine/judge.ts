import type { Flow } from '../model/flow.ts';

export type Verdict = 'correct' | 'wrong' | 'never';

export type JudgeInput = {
  claims: number;
  proven: number;
  unreachable: string | undefined; // why the flow can't be reached, if it can't
  destructive: Flow['destructive'];
  verdict: Verdict | undefined; // a reviewer's, from the repo's rules
  sourceOnlyWeight: number;
};

export type Judgement = Pick<Flow, 'status' | 'confidence' | 'enabled'> & { reasons: string[] };

// PLAN.md Phase 4 judge. Status follows PLAN.md §4: verified means every claim has source evidence and the flow is
// reachable. Confidence is the share of claims proven, weighted down for source-only flows (agreement with the live
// app, Phase 3, raises it). Fail closed: only verified, non-destructive flows start enabled, until a reviewer says so.
export function judge(input: JudgeInput): Judgement {
  if (input.verdict === 'wrong') return { status: 'rejected', confidence: 0, enabled: false, reasons: ['a reviewer marked it wrong'] };
  if (input.verdict === 'never') return { status: 'rejected', confidence: 0, enabled: false, reasons: ['a reviewer said never to suggest it again'] };
  const reasons: string[] = [];
  let status: Flow['status'] = 'verified';
  if (input.unreachable !== undefined) {
    status = 'unreachable';
    reasons.push(`unreachable: ${input.unreachable}`);
  } else if (input.proven < input.claims) {
    status = 'unverified';
    reasons.push(`${input.claims - input.proven} of ${input.claims} claims are not backed by source`);
  }
  if (input.destructive !== 'no') reasons.push(`held for review: destructive is ${input.destructive}`);
  if (input.verdict === 'correct') {
    reasons.push('a reviewer marked it correct');
    return { status, confidence: 1, enabled: status !== 'unreachable', reasons };
  }
  const confidence = Math.round((input.proven / input.claims) * input.sourceOnlyWeight * 100) / 100;
  return { status, confidence, enabled: status === 'verified' && input.destructive === 'no', reasons };
}

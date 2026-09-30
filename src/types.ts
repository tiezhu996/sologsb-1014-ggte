export type StepType = 'premise' | 'derivation' | 'goal';
export type CheckSeverity = 'error' | 'warning' | 'info';

export interface ProofStep {
  id: string;
  type: StepType;
  statement: string;
  rule: string;
  references: string[];
  note: string;
  counterexample: string;
  alternative: string;
}

export interface ProofVersion {
  id: string;
  name: string;
  createdAt: string;
  steps: ProofStep[];
  goal: string;
}

export interface ProofDocument {
  id: string;
  title: string;
  author: string;
  goal: string;
  symbols: Record<string, string>;
  steps: ProofStep[];
  versions: ProofVersion[];
  updatedAt: string;
}

export interface ProofCheck {
  id: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
  stepId?: string;
}

export interface ProofDiff {
  kind: 'same' | 'added' | 'removed' | 'changed';
  label: string;
  before: string;
  after: string;
}

export type MergeConflictField = 'statement' | 'rule' | 'references';

export interface MergeConflict {
  id: string;
  docId: string;
  stepId: string;
  field: MergeConflictField;
  localTab: string;
  peerTab: string;
  /** 统一成字符串数组：命题/规则只放一项，依据为步骤 id 列表 */
  baseValue: string[];
  localValue: string[];
  peerValue: string[];
  choice: 'local' | 'peer' | null;
}

export interface MergeReport {
  docId: string;
  title: string;
  addedLocal: string[];
  addedPeer: string[];
  removed: string[];
  restored: string[];
  prunedReferences: { stepId: string; reference: string }[];
  notes: string[];
}

export interface MergeResult {
  merged: ProofDocument[];
  conflicts: MergeConflict[];
  reports: MergeReport[];
}

export interface PendingMerge {
  sessionId: string;
  ownerTabId: string;
  localTabName: string;
  baseRev: number;
  createdAt: string;
  consumedPeers: string[];
  merged: ProofDocument[];
  conflicts: MergeConflict[];
  reports: MergeReport[];
}

import type {
  MergeConflict,
  MergeConflictField,
  MergeReport,
  MergeResult,
  ProofDocument,
  ProofStep,
} from './types';

export interface DraftEnvelope {
  tabId: string;
  tabName: string;
  updatedAt: string;
  /** 断网瞬间的共同基线（在线稿为 null，直接使用共享稿作基线） */
  base: ProofDocument[] | null;
  baseRev: number;
  docs: ProofDocument[];
}

const CONFLICT_FIELDS: { field: MergeConflictField; label: string }[] = [
  { field: 'statement', label: '结论' },
  { field: 'rule', label: '推理规则' },
  { field: 'references', label: '依据' },
];

export function conflictFieldLabel(field: MergeConflictField): string {
  return CONFLICT_FIELDS.find((item) => item.field === field)?.label ?? field;
}

function isNewer(a: ProofDocument | DraftEnvelope | undefined, b: ProofDocument | DraftEnvelope | undefined): boolean {
  const ta = a ? Date.parse(a.updatedAt) : NaN;
  const tb = b ? Date.parse(b.updatedAt) : NaN;
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta >= tb;
}

function stepChanged(a: ProofStep | undefined, b: ProofStep | undefined): boolean {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  return (
    a.statement !== b.statement ||
    a.rule !== b.rule ||
    a.type !== b.type ||
    JSON.stringify([...a.references].sort()) !== JSON.stringify([...b.references].sort()) ||
    a.note !== b.note ||
    a.counterexample !== b.counterexample ||
    a.alternative !== b.alternative
  );
}

function freeText(
  base: string,
  local: string,
  remote: string,
  chooseNewer: () => string,
): string {
  if (local === remote) return local;
  if (base === local) return remote;
  if (base === remote) return local;
  return chooseNewer();
}

/** 合并旁注/反例/替代分支：非空即保留，两边不同则拼接，尽量不丢信息 */
function noteText(base: string, local: string, remote: string, newerWins: boolean): string {
  if (local === remote) return local;
  if (base === local) return remote;
  if (base === remote) return local;
  if (!local.trim()) return remote;
  if (!remote.trim()) return local;
  if (local.includes(remote)) return local;
  if (remote.includes(local)) return remote;
  return newerWins ? `${local}\n（另一标签稿）${remote}` : `${remote}\n（另一标签稿）${local}`;
}

function sameRefs(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

export function mergeThreeWay(
  local: DraftEnvelope,
  peer: DraftEnvelope,
  base: ProofDocument[],
): MergeResult {
  const reports: MergeReport[] = [];
  const conflicts: MergeConflict[] = [];
  const merged: ProofDocument[] = [];
  const docIds = new Set([
    ...base.map((doc) => doc.id),
    ...local.docs.map((doc) => doc.id),
    ...peer.docs.map((doc) => doc.id),
  ]);

  docIds.forEach((docId) => {
    const b = base.find((doc) => doc.id === docId);
    const l = local.docs.find((doc) => doc.id === docId);
    const p = peer.docs.find((doc) => doc.id === docId);

    // 文档级新增：另一边的新文档直接整体保留
    if (!l || !p) {
      const only = l ?? p;
      if (only) {
        merged.push(structuredClone(only));
        reports.push({
          docId,
          title: only.title,
          addedLocal: l ? only.steps.map((step) => step.id) : [],
          addedPeer: p ? p.steps.map((step) => step.id) : [],
          removed: [],
          restored: [],
          prunedReferences: [],
          notes: [`整份证明《${only.title}》由${l ? local.tabName : peer.tabName}新建，整体保留`],
        });
      }
      return;
    }

    const report: MergeReport = {
      docId,
      title: l.title,
      addedLocal: [],
      addedPeer: [],
      removed: [],
      restored: [],
      prunedReferences: [],
      notes: [],
    };
    const result: ProofDocument = {
      id: docId,
      title: b?.title ?? '',
      author: b?.author ?? '',
      goal: b?.goal ?? '',
      symbols: b ? { ...b.symbols } : {},
      steps: [],
      versions: [],
      updatedAt: new Date().toISOString(),
    };

    // 文档级字段：两边都改且不一致时，以更新的一稿为准
    const localNewer = isNewer(l, p);
    if (b) {
      result.title = freeText(b.title, l.title, p.title, () => (localNewer ? l.title : p.title));
      result.author = freeText(b.author, l.author, p.author, () => (localNewer ? l.author : p.author));
      result.goal = freeText(b.goal, l.goal, p.goal, () => (localNewer ? l.goal : p.goal));
      const symbolNames = new Set([...Object.keys(b.symbols), ...Object.keys(l.symbols), ...Object.keys(p.symbols)]);
      symbolNames.forEach((name) => {
        const value = freeText(
          b.symbols[name] ?? '',
          l.symbols[name] ?? '',
          p.symbols[name] ?? '',
          () => (localNewer ? l.symbols[name] ?? '' : p.symbols[name] ?? ''),
        );
        if (value) result.symbols[name] = value;
      });
    } else {
      Object.assign(result, { title: l.title, author: l.author, goal: l.goal, symbols: { ...l.symbols, ...p.symbols } });
    }

    // 步骤级合并：以本标签顺序为主，另一标签独有的步骤追加在末尾
    const baseSteps = new Map<string, ProofStep>((b?.steps ?? []).map((step) => [step.id, step]));
    const localSteps = new Map<string, ProofStep>(l.steps.map((step) => [step.id, step]));
    const peerSteps = new Map<string, ProofStep>(p.steps.map((step) => [step.id, step]));
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    l.steps.forEach((step) => {
      orderedIds.push(step.id);
      seen.add(step.id);
    });
    p.steps.forEach((step) => {
      if (!seen.has(step.id)) {
        orderedIds.push(step.id);
        seen.add(step.id);
      }
    });

    orderedIds.forEach((stepId) => {
      const sb = baseSteps.get(stepId);
      const sl = localSteps.get(stepId);
      const sp = peerSteps.get(stepId);

      if (!sb) {
        // 基线没有：某一边新增的步骤（两边新增同一 id 时按字段三向合并）
        const owner = sl && sp ? null : sl ? local.tabName : peer.tabName;
        const source = sl ?? sp;
        if (!source) return;
        if (!sl) report.addedPeer.push(stepId);
        else if (!sp) report.addedLocal.push(stepId);
        const kept: ProofStep = structuredClone(source);
        if (sl && sp) {
          mergeStepFields(kept, sl, sp, undefined, local.tabName, peer.tabName, docId, conflicts);
          kept.note = noteText('', sl.note, sp.note, localNewer);
          kept.counterexample = noteText('', sl.counterexample, sp.counterexample, localNewer);
          kept.alternative = noteText('', sl.alternative, sp.alternative, localNewer);
        }
        result.steps.push(kept);
        if (owner) report.notes.push(`步骤 #${short(stepId)} 由${owner}新增，已保留`);
        return;
      }

      const localMissing = !sl;
      const peerMissing = !sp;
      if (localMissing && peerMissing) return;

      // 一边删除、另一边未改动：删除生效
      if (localMissing && !stepChanged(sb, sp)) {
        report.removed.push(stepId);
        return;
      }
      if (peerMissing && !stepChanged(sb, sl)) {
        report.removed.push(stepId);
        return;
      }
      // 一边删除、另一边有修改：保留修改稿，提醒老师
      if (localMissing || peerMissing) {
        const kept = structuredClone(sl ?? sp) as ProofStep;
        result.steps.push(kept);
        report.restored.push(stepId);
        report.notes.push(
          `步骤 #${short(stepId)} 被${localMissing ? local.tabName : peer.tabName}删除，` +
          `但${localMissing ? peer.tabName : local.tabName}有修改，已保留修改稿，请人工确认`,
        );
        return;
      }

      const slv = sl as ProofStep;
      const spv = sp as ProofStep;
      const mergedStep: ProofStep = structuredClone(sb);
      mergedStep.type = freeText(sb.type, slv.type, spv.type, () => (localNewer ? slv.type : spv.type)) as ProofStep['type'];
      mergeStepFields(mergedStep, slv, spv, sb, local.tabName, peer.tabName, docId, conflicts);
      mergedStep.note = noteText(sb.note, slv.note, spv.note, localNewer);
      mergedStep.counterexample = noteText(sb.counterexample, slv.counterexample, spv.counterexample, localNewer);
      mergedStep.alternative = noteText(sb.alternative, slv.alternative, spv.alternative, localNewer);
      result.steps.push(mergedStep);
    });

    // 拿掉步骤后，引用不能指向已经消失的步骤（含删除/新增合并）
    const liveIds = new Set(result.steps.map((step) => step.id));
    result.steps.forEach((step) => {
      const dangling = step.references.filter((reference) => !liveIds.has(reference));
      dangling.forEach((reference) => report.prunedReferences.push({ stepId: step.id, reference }));
      if (dangling.length) step.references = step.references.filter((reference) => liveIds.has(reference));
    });

    // 版本快照：两边保存的快照都保留，按时间倒序
    const versionMap = new Map<string, ProofDocument['versions'][number]>();
    [...l.versions, ...p.versions, ...(b?.versions ?? [])].forEach((version) => {
      const existing = versionMap.get(version.id);
      if (!existing || Date.parse(version.createdAt) > Date.parse(existing.createdAt)) versionMap.set(version.id, version);
    });
    result.versions = [...versionMap.values()].sort((a, b2) => Date.parse(b2.createdAt) - Date.parse(a.createdAt));

    reports.push(report);
    merged.push(result);
  });

  return { merged, conflicts, reports };
}

function mergeStepFields(
  target: ProofStep,
  local: ProofStep,
  peer: ProofStep,
  base: ProofStep | undefined,
  localTabName: string,
  peerTabName: string,
  docId: string,
  conflicts: MergeConflict[],
): void {
  // 结论 / 推理规则：两边都改且不一致 -> 待处理项
  (['statement', 'rule'] as const).forEach((field) => {
    const b = base?.[field] ?? '';
    const lv = local[field];
    const pv = peer[field];
    if (lv === pv) {
      target[field] = lv;
    } else if (b === lv) {
      target[field] = pv;
    } else if (b === pv) {
      target[field] = lv;
    } else {
      target[field] = lv;
      conflicts.push({
        id: `${docId}-${local.id}-${field}-${Math.random().toString(36).slice(2, 8)}`,
        docId,
        stepId: local.id,
        field,
        localTab: localTabName,
        peerTab: peerTabName,
        baseValue: [b],
        localValue: [lv],
        peerValue: [pv],
        choice: null,
      });
    }
  });

  // 依据：两边都改且集合不一致 -> 待处理项
  const bRefs = base?.references ?? [];
  if (sameRefs(local.references, peer.references)) {
    target.references = [...local.references];
  } else if (sameRefs(bRefs, local.references)) {
    target.references = [...peer.references];
  } else if (sameRefs(bRefs, peer.references)) {
    target.references = [...local.references];
  } else {
    target.references = [...local.references];
    conflicts.push({
      id: `${docId}-${local.id}-references-${Math.random().toString(36).slice(2, 8)}`,
      docId,
      stepId: local.id,
      field: 'references',
      localTab: localTabName,
      peerTab: peerTabName,
      baseValue: [...bRefs],
      localValue: [...local.references],
      peerValue: [...peer.references],
      choice: null,
    });
  }
}

function short(id: string): string {
  return id.replace(/^step-/, '').slice(-4).toUpperCase();
}

import type { ProofDocument, ProofStep } from './types';

// ---------------------------------------------------------------------------
// 多标签本地稿与合并：存储键、协议类型
// ---------------------------------------------------------------------------

const LEGACY_STORAGE_KEY = 'sologsb-1014-proof-workspace-v1';
export const BASE_KEY = 'sologsb-1014:sync:base';
export const DRAFT_PREFIX = 'sologsb-1014:sync:draft:';
export const SESSION_PREFIX = 'sologsb-1014:sync:session:';
export const LOCK_KEY = 'sologsb-1014:sync:merge-lock';
export const SID_KEY = 'sologsb-1014:sync:sid';
export const CHANNEL_NAME = 'sologsb-1014-sync-v1';

export const SYNC_ORDINALS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const SESSION_TTL = 9000;
const LOCK_TTL = 10000;
const FLUSH_DELAY = 250;
/** 恢复联网后给其他标签一点时间重新上线，避免先到者把本地稿单独快进提交。 */
const RECONNECT_GRACE = 1500;
/** 保留的历史基线快照数量；再多会逼近 localStorage 容量，写入超限时也会自动再裁剪。 */
const HISTORY_LIMIT = 10;

export type SyncMode = 'online' | 'offline' | 'waiting' | 'merging';

export interface SyncBase {
  revision: number;
  documents: ProofDocument[];
  updatedAt: string;
  /** 历史基线快照（修订号 → 文档），用于跨越多次快进提交做三方合并；只保留最近若干版。 */
  history: { revision: number; documents: ProofDocument[] }[];
}

export interface SyncDraft {
  sessionId: string;
  label: string;
  /** 最近一次看到的共享基线（三方合并的共同祖先）是否在线 */
  online: boolean;
  /** 共同祖先对应的文档快照 */
  ancestor: ProofDocument[];
  ancestorBaseRevision: number;
  /** 本标签当前的完整本地稿 */
  documents: ProofDocument[];
  baseRevision: number;
  savedAt: string;
}

export interface SyncSession {
  id: string;
  label: string;
  online: boolean;
  lastSeen: number;
}

export interface MergeLock {
  owner: string;
  label: string;
  at: number;
}

type ChannelMessage =
  | { type: 'commit'; revision: number; from: string }
  | { type: 'merge-start'; from: string; label: string; at: number };

// ---------------------------------------------------------------------------
// 合并结果类型
// ---------------------------------------------------------------------------

export type MergeConflictKind = 'field' | 'step-existence' | 'doc-existence';
export type MergeFieldKind = 'statement' | 'rule' | 'references';

export interface MergeConflictOption {
  side: string;
  text: string;
}

export interface MergeConflict {
  id: string;
  kind: MergeConflictKind;
  docId: string;
  docTitle: string;
  stepId?: string;
  stepTitle?: string;
  field?: MergeFieldKind;
  fieldLabel?: string;
  baseText: string;
  options: MergeConflictOption[];
  /** 与 options 对齐的实际取值：结论/规则为字符串，依据为步骤 id 数组 */
  values?: (string | string[])[];
  /** 存在性冲突选择“保留”时要恢复的对象 */
  keepStep?: ProofStep;
  keepDoc?: ProofDocument;
  chosen?: number;
}

export interface MergeSideInput {
  label: string;
  documents: ProofDocument[];
  savedAt: string;
  /** 该本地稿所基于的共享基线修订号。 */
  baseRevision?: number;
}

export interface MergeReport {
  documents: ProofDocument[];
  conflicts: MergeConflict[];
  notices: string[];
  sides: MergeSideInput[];
}

// ---------------------------------------------------------------------------
// 纯函数：三方合并（不依赖浏览器 API，便于校验）
// ---------------------------------------------------------------------------

const clone = <T>(value: T): T => structuredClone(value);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const nowIso = (): string => new Date().toISOString();
const sortRefs = (refs: string[]): string[] => [...refs].sort();
const refEqual = (a: string[], b: string[]): boolean => deepEqual(sortRefs(a), sortRefs(b));
const maxIso = (a: string, b: string): string => (a > b ? a : b);

const STEP_FIELDS: { field: MergeFieldKind; label: string }[] = [
  { field: 'statement', label: '结论' },
  { field: 'rule', label: '推理规则' },
  { field: 'references', label: '依据' },
];
const NOTE_FIELDS = ['note', 'counterexample', 'alternative'] as const;
const NOTE_LABELS: Record<(typeof NOTE_FIELDS)[number], string> = {
  note: '旁注',
  counterexample: '反例',
  alternative: '替代分支',
};

function statementPreview(step: ProofStep | undefined): string {
  if (!step) return '（空）';
  return step.statement.replace(/\$/g, '').slice(0, 24) || '未命名步骤';
}

function docSignature(doc: ProofDocument): string {
  return JSON.stringify([doc.title, doc.author, doc.goal, doc.symbols, doc.steps, doc.versions]);
}

function emptyStep(id: string): ProofStep {
  return { id, type: 'derivation', statement: '', rule: '', references: [], note: '', counterexample: '', alternative: '' };
}

/** 按对方标签页中的相对位置，把新步骤插到结果序列里。 */
function insertByAnchor(result: ProofStep[], step: ProofStep, referenceOrder: ProofStep[]): void {
  if (result.some((item) => item.id === step.id)) return;
  const anchorIndex = referenceOrder.findIndex((item) => item.id === step.id);
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const at = result.findIndex((item) => item.id === referenceOrder[index].id);
    if (at >= 0) {
      result.splice(at + 1, 0, step);
      return;
    }
  }
  for (let index = anchorIndex + 1; index < referenceOrder.length; index += 1) {
    const at = result.findIndex((item) => item.id === referenceOrder[index].id);
    if (at >= 0) {
      result.splice(at, 0, step);
      return;
    }
  }
  result.push(step);
}

interface MergeContext {
  conflicts: MergeConflict[];
  notices: string[];
  seenConflictKeys: Set<string>;
  sequence: number;
}

function addConflict(ctx: MergeContext, conflict: Omit<MergeConflict, 'id'>, key: string): void {
  if (ctx.seenConflictKeys.has(key)) return;
  ctx.seenConflictKeys.add(key);
  ctx.conflicts.push({ id: `conflict-${ctx.sequence += 1}`, ...conflict });
}

function mergeAnnotationText(
  ancestor: string,
  left: string,
  right: string,
  labelLeft: string,
  labelRight: string,
): { value: string; joined: boolean } {
  if (left === right) return { value: left, joined: false };
  if (left === ancestor) return { value: right, joined: false };
  if (right === ancestor) return { value: left, joined: false };
  if (!left) return { value: right, joined: false };
  if (!right) return { value: left, joined: false };
  return { value: `【${labelLeft}】${left}\n【${labelRight}】${right}`, joined: true };
}

/**
 * 合并两个标签对同一步骤的修改。
 * 结论 / 推理规则 / 依据两边都改且不一致时，登记待处理项，暂取左稿。
 */
function mergeStepFields(
  ctx: MergeContext,
  docId: string,
  docTitle: string,
  stepIndex: number,
  ancestor: ProofStep,
  left: ProofStep,
  right: ProofStep,
  labelLeft: string,
  labelRight: string,
  leftIndexById: Map<string, number>,
  rightIndexById: Map<string, number>,
): ProofStep {
  const merged = clone(left);
  const stepTitle = `步骤 ${stepIndex}（${statementPreview(left)}）`;

  for (const { field, label } of STEP_FIELDS) {
    if (field === 'references') {
      const xVal = left.references;
      const yVal = right.references;
      if (refEqual(xVal, yVal)) {
        merged.references = [...xVal];
      } else if (refEqual(yVal, ancestor.references)) {
        merged.references = [...xVal];
      } else if (refEqual(xVal, ancestor.references)) {
        merged.references = [...yVal];
      } else {
        const format = (refs: string[], indexById: Map<string, number>) =>
          refs.length ? refs.map((id) => (indexById.has(id) ? `步骤 ${indexById.get(id)}` : `已删除 ${id}`)).join('、') : '（无依据）';
        addConflict(ctx, {
          kind: 'field',
          docId,
          docTitle,
          stepId: left.id,
          stepTitle,
          field,
          fieldLabel: label,
          baseText: format(ancestor.references, leftIndexById),
          options: [
            { side: labelLeft, text: format(xVal, leftIndexById) },
            { side: labelRight, text: format(yVal, rightIndexById) },
          ],
          values: [[...xVal], [...yVal]],
        }, `field:${left.id}:${field}`);
        merged.references = [...xVal];
      }
      continue;
    }

    const aVal = ancestor[field];
    const xVal = left[field];
    const yVal = right[field];
    if (xVal === yVal) {
      merged[field] = xVal;
    } else if (yVal === aVal) {
      merged[field] = xVal;
    } else if (xVal === aVal) {
      merged[field] = yVal;
    } else {
      addConflict(ctx, {
        kind: 'field',
        docId,
        docTitle,
        stepId: left.id,
        stepTitle,
        field,
        fieldLabel: label,
        baseText: aVal || '（空）',
        options: [
          { side: labelLeft, text: xVal || '（空）' },
          { side: labelRight, text: yVal || '（空）' },
        ],
        values: [xVal, yVal],
      }, `field:${left.id}:${field}`);
      merged[field] = xVal;
    }
  }

  // 旁注 / 反例 / 替代分支不属于阻塞项：两边都改则并列保留。
  for (const noteField of NOTE_FIELDS) {
    const result = mergeAnnotationText(ancestor[noteField], left[noteField], right[noteField], labelLeft, labelRight);
    merged[noteField] = result.value;
    if (result.joined) {
      ctx.notices.push(`《${docTitle}》${stepTitle}的${NOTE_LABELS[noteField]}两边均有修改，已并列保留。`);
    }
  }

  // 步骤类型同样不阻塞：仅一边改则采用，两边都改暂取左稿并提示。
  if (left.type !== right.type) {
    if (left.type === ancestor.type) merged.type = right.type;
    else if (right.type === ancestor.type) merged.type = left.type;
    else {
      merged.type = left.type;
      ctx.notices.push(`《${docTitle}》${stepTitle}的步骤类型两边不一致，暂采用${labelLeft}的设置，请核对。`);
    }
  }

  return merged;
}

/**
 * 合并两个标签对同一份证明文档的步骤序列。
 * 仅一边新增/修改的内容全部保留；一边删除、另一边修改 → 待处理项，暂保留步骤。
 */
function mergeSteps(
  ctx: MergeContext,
  docId: string,
  docTitle: string,
  ancestorDoc: ProofDocument | undefined,
  leftDoc: ProofDocument,
  rightDoc: ProofDocument,
  labelLeft: string,
  labelRight: string,
): ProofStep[] {
  const ancestorMap = new Map((ancestorDoc?.steps ?? []).map((step) => [step.id, step]));
  const leftMap = new Map(leftDoc.steps.map((step) => [step.id, step]));
  const rightMap = new Map(rightDoc.steps.map((step) => [step.id, step]));

  const result: ProofStep[] = [];

  // 以左稿顺序为底稿；右稿删除而左稿未改的步骤直接尊重删除。
  for (const step of leftDoc.steps) {
    const ancestor = ancestorMap.get(step.id);
    const right = rightMap.get(step.id);
    if (ancestor && !right) {
      if (deepEqual(step, ancestor)) continue; // 两边一致：删除
      addConflict(ctx, {
        kind: 'step-existence',
        docId,
        docTitle,
        stepId: step.id,
        stepTitle: statementPreview(step),
        baseText: `${labelRight}删除了该步骤，${labelLeft}修改了该步骤`,
        options: [
          { side: labelLeft, text: `保留步骤并采用${labelLeft}的修改` },
          { side: labelRight, text: '删除该步骤' },
        ],
        keepStep: clone(step),
      }, `existence:${step.id}`);
    }
    result.push(clone(step));
  }

  // 右稿独有的步骤：左稿新增 → 按右稿相对位置插入；左稿删除、右稿修改 → 待处理项。
  for (const step of rightDoc.steps) {
    if (leftMap.has(step.id)) continue;
    const ancestor = ancestorMap.get(step.id);
    if (ancestor) {
      if (deepEqual(step, ancestor)) continue; // 两边一致：删除
      addConflict(ctx, {
        kind: 'step-existence',
        docId,
        docTitle,
        stepId: step.id,
        stepTitle: statementPreview(step),
        baseText: `${labelLeft}删除了该步骤，${labelRight}修改了该步骤`,
        options: [
          { side: labelRight, text: `保留步骤并采用${labelRight}的修改` },
          { side: labelLeft, text: '删除该步骤' },
        ],
        keepStep: clone(step),
      }, `existence:${step.id}`);
    }
    insertByAnchor(result, clone(step), rightDoc.steps);
  }

  // 两边都保留的步骤：逐字段三方合并。
  const leftIndexById = new Map(leftDoc.steps.map((step, index) => [step.id, index + 1]));
  const rightIndexById = new Map(rightDoc.steps.map((step, index) => [step.id, index + 1]));
  for (const step of result) {
    const left = leftMap.get(step.id);
    const right = rightMap.get(step.id);
    if (!left || !right) continue;
    const ancestor = ancestorMap.get(step.id) ?? emptyStep(step.id);
    const index = result.indexOf(step) + 1;
    const merged = mergeStepFields(ctx, docId, docTitle, index, ancestor, left, right, labelLeft, labelRight, leftIndexById, rightIndexById);
    result[index - 1] = merged;
  }

  return result;
}

function mergeSymbols(
  ctx: MergeContext,
  docTitle: string,
  ancestor: Record<string, string>,
  left: Record<string, string>,
  right: Record<string, string>,
  newerSide: 'L' | 'R',
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const aVal = ancestor[key];
    const xVal = left[key];
    const yVal = right[key];
    if (xVal === undefined) {
      merged[key] = yVal;
    } else if (yVal === undefined) {
      merged[key] = xVal;
    } else if (xVal === yVal || yVal === aVal) {
      merged[key] = xVal;
    } else if (xVal === aVal) {
      merged[key] = yVal;
    } else {
      merged[key] = newerSide === 'L' ? xVal : yVal;
      ctx.notices.push(`《${docTitle}》符号 $${key}$ 的含义两边均有修改，已采用较晚保存的版本。`);
    }
  }
  return merged;
}

function mergeVersions(left: ProofDocument['versions'], right: ProofDocument['versions']): ProofDocument['versions'] {
  const byId = new Map<string, ProofDocument['versions'][number]>();
  [...left, ...right].forEach((version) => byId.set(version.id, version));
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 合并单个文档。rightDoc 为 null 表示第二边等于共同祖先（只有一份分歧稿的快进场景）。
 * newerSide：'L' | 'R'，文档级字段两边都改时取较晚保存的一边。
 */
function mergeDocument(
  ctx: MergeContext,
  ancestorDoc: ProofDocument | undefined,
  leftDoc: ProofDocument | undefined,
  rightDoc: ProofDocument | undefined,
  labelLeft: string,
  labelRight: string,
  newerSide: 'L' | 'R',
): ProofDocument | undefined {
  // 共同祖先中不存在：纯新增。
  if (!ancestorDoc) {
    if (leftDoc && rightDoc && leftDoc.id !== rightDoc.id) return leftDoc;
    if (leftDoc && rightDoc) {
      return mergeDocumentAddedByBoth(ctx, leftDoc, rightDoc, labelLeft, labelRight);
    }
    return clone((leftDoc ?? rightDoc) as ProofDocument);
  }

  if (!leftDoc || !rightDoc) {
    const survivor = leftDoc ?? rightDoc;
    // 一边删除、另一边未改 → 尊重删除；另一边有改动 → 待处理项，暂保留文档。
    if (!survivor || deepEqual(docSignature(survivor), docSignature(ancestorDoc))) return undefined;
    addConflict(ctx, {
      kind: 'doc-existence',
      docId: ancestorDoc.id,
      docTitle: ancestorDoc.title,
      baseText: `${leftDoc ? labelLeft : labelRight}删除了整份文档，另一边做了修改`,
      options: [
        { side: leftDoc ? labelLeft : labelRight, text: '保留该文档' },
        { side: leftDoc ? labelRight : labelLeft, text: '删除整份文档' },
      ],
      keepDoc: clone(survivor),
    }, `doc-existence:${ancestorDoc.id}`);
    return clone(survivor);
  }

  const docTitle = leftDoc.title;
  const docId = leftDoc.id;
  const merged: ProofDocument = clone(leftDoc);

  for (const scalarField of ['title', 'author', 'goal'] as const) {
    const aVal = ancestorDoc[scalarField];
    const xVal = leftDoc[scalarField];
    const yVal = rightDoc[scalarField];
    if (xVal === yVal || yVal === aVal) merged[scalarField] = xVal;
    else if (xVal === aVal) merged[scalarField] = yVal;
    else {
      merged[scalarField] = newerSide === 'L' ? xVal : yVal;
      const label = scalarField === 'title' ? '标题' : scalarField === 'author' ? '作者' : '证明目标';
      ctx.notices.push(`《${docTitle}》的${label}两边均有修改，已采用较晚保存的${newerSide === 'L' ? labelLeft : labelRight}版本。`);
    }
  }

  merged.symbols = mergeSymbols(ctx, docTitle, ancestorDoc.symbols, leftDoc.symbols, rightDoc.symbols, newerSide);
  merged.versions = mergeVersions(leftDoc.versions, rightDoc.versions);
  merged.steps = mergeSteps(ctx, docId, docTitle, ancestorDoc, leftDoc, rightDoc, labelLeft, labelRight);
  merged.updatedAt = maxIso(leftDoc.updatedAt, rightDoc.updatedAt);
  return merged;
}

/**
 * 单边重连的变基合并：把离线稿（side）相对其旧基线（oldBase）的改动，
 * 叠加到当前在线稿（currentBase）之上。离线稿没有改动的字段保持在线稿的最新值，
 * 离线稿与在线稿都改了同一关键字段则登记待处理项。
 */
function rebaseDocument(
  ctx: MergeContext,
  oldDoc: ProofDocument | undefined,
  sideDoc: ProofDocument | undefined,
  currentDoc: ProofDocument | undefined,
  sideLabel: string,
  onlineLabel: string,
): ProofDocument | undefined {
  // 在线稿已删除该文档
  if (!currentDoc) {
    if (!sideDoc) return undefined;
    if (oldDoc && deepEqual(docSignature(sideDoc), docSignature(oldDoc))) return undefined; // 离线也没改，尊重删除
    addConflict(ctx, {
      kind: 'doc-existence',
      docId: (sideDoc ?? oldDoc)!.id,
      docTitle: (sideDoc ?? oldDoc)!.title,
      baseText: `在线的其他标签删除了整份文档，${sideLabel}离线做了修改`,
      options: [
        { side: sideLabel, text: '保留该文档' },
        { side: onlineLabel, text: '删除整份文档' },
      ],
      keepDoc: clone(sideDoc!),
    }, `doc-existence:${sideDoc!.id}`);
    return clone(sideDoc);
  }
  if (!sideDoc) return clone(currentDoc);

  // 旧基线缺失（离线稿基于的快照太旧已被清理）：退化为对称合并，祖先用当前在线稿，
  // 离线稿相对当前稿不一致的关键字段仍会进入待处理项，不会静默覆盖。
  if (!oldDoc) {
    return mergeDocument(ctx, currentDoc, sideDoc, currentDoc, sideLabel, onlineLabel, 'L');
  }

  const docId = sideDoc.id;
  const docTitle = currentDoc.title;
  const merged: ProofDocument = clone(currentDoc);

  for (const scalarField of ['title', 'author', 'goal'] as const) {
    const oldVal = oldDoc[scalarField];
    const sideVal = sideDoc[scalarField];
    const currentVal = currentDoc[scalarField];
    if (sideVal === oldVal) merged[scalarField] = currentVal; // 离线没动，保留在线值
    else if (currentVal === oldVal || sideVal === currentVal) merged[scalarField] = sideVal; // 只有离线改 / 两边一致
    else {
      merged[scalarField] = currentVal;
      const label = scalarField === 'title' ? '标题' : scalarField === 'author' ? '作者' : '证明目标';
      ctx.notices.push(`《${docTitle}》的${label}离线与在线均有修改，已保留在线版本，请核对。`);
    }
  }

  merged.symbols = mergeSymbols(ctx, docTitle, oldDoc.symbols, sideDoc.symbols, currentDoc.symbols, 'R');
  merged.versions = mergeVersions(sideDoc.versions, currentDoc.versions);
  merged.updatedAt = maxIso(sideDoc.updatedAt, currentDoc.updatedAt);
  merged.steps = rebaseSteps(ctx, docId, docTitle, oldDoc, sideDoc, currentDoc, sideLabel, onlineLabel);
  return merged;
}

/** 变基时按步骤叠加离线改动；删除/新增/修改都以「离线稿相对旧基线是否动过」为准。 */
function rebaseSteps(
  ctx: MergeContext,
  docId: string,
  docTitle: string,
  oldDoc: ProofDocument,
  sideDoc: ProofDocument,
  currentDoc: ProofDocument,
  sideLabel: string,
  onlineLabel: string,
): ProofStep[] {
  const oldMap = new Map(oldDoc.steps.map((step) => [step.id, step]));
  const sideMap = new Map(sideDoc.steps.map((step) => [step.id, step]));
  const currentMap = new Map(currentDoc.steps.map((step) => [step.id, step]));

  // 以在线稿顺序为底稿
  const result: ProofStep[] = currentDoc.steps.map((step) => clone(step));

  // 离线稿删除了某步骤
  for (const old of oldDoc.steps) {
    if (sideMap.has(old.id)) continue;
    const current = currentMap.get(old.id);
    if (!current) continue; // 在线也删了
    if (deepEqual(current, old)) {
      // 在线没改：尊重离线删除
      const index = result.findIndex((item) => item.id === old.id);
      if (index >= 0) result.splice(index, 1);
    } else {
      // 在线改了、离线删了：待处理项，暂保留在线步骤
      addConflict(ctx, {
        kind: 'step-existence',
        docId,
        docTitle,
        stepId: old.id,
        stepTitle: statementPreview(current),
        baseText: `${sideLabel}离线删除了该步骤，在线的其他标签修改了它`,
        options: [
          { side: onlineLabel, text: '保留在线版本的步骤' },
          { side: sideLabel, text: '删除该步骤' },
        ],
        keepStep: clone(current),
      }, `existence:${old.id}`);
    }
  }

  // 离线稿新增的步骤（旧基线没有）
  for (const step of sideDoc.steps) {
    if (oldMap.has(step.id)) continue;
    if (!currentMap.has(step.id)) insertByAnchor(result, clone(step), sideDoc.steps);
  }

  // 两边都有的步骤：只在离线稿相对旧基线「改过」时才叠加
  const currentIndexById = new Map(currentDoc.steps.map((step, index) => [step.id, index + 1]));
  const sideIndexById = new Map(sideDoc.steps.map((step, index) => [step.id, index + 1]));
  const next: ProofStep[] = [];
  for (const step of result) {
    const old = oldMap.get(step.id);
    const side = sideMap.get(step.id);
    const current = currentMap.get(step.id) ?? step;
    if (!old || !side) { next.push(step); continue; }
    next.push(rebaseStepFields(ctx, docId, docTitle, result.indexOf(step) + 1, old, side, current, sideLabel, onlineLabel, sideIndexById, currentIndexById));
  }
  return next;
}

function rebaseStepFields(
  ctx: MergeContext,
  docId: string,
  docTitle: string,
  stepIndex: number,
  old: ProofStep,
  side: ProofStep,
  current: ProofStep,
  sideLabel: string,
  onlineLabel: string,
  sideIndexById: Map<string, number>,
  currentIndexById: Map<string, number>,
): ProofStep {
  const merged = clone(current);
  const stepTitle = `步骤 ${stepIndex}（${statementPreview(current)}）`;

  for (const { field, label } of STEP_FIELDS) {
    if (field === 'references') {
      if (refEqual(side.references, old.references)) {
        merged.references = [...current.references]; // 离线没动依据
      } else if (refEqual(current.references, old.references) || refEqual(side.references, current.references)) {
        merged.references = [...side.references]; // 只有离线改，或两边改成一致
      } else {
        const format = (refs: string[], indexById: Map<string, number>) =>
          refs.length ? refs.map((id) => (indexById.has(id) ? `步骤 ${indexById.get(id)}` : `已删除 ${id}`)).join('、') : '（无依据）';
        addConflict(ctx, {
          kind: 'field',
          docId,
          docTitle,
          stepId: side.id,
          stepTitle,
          field,
          fieldLabel: label,
          baseText: format(old.references, currentIndexById),
          options: [
            { side: sideLabel, text: format(side.references, sideIndexById) },
            { side: onlineLabel, text: format(current.references, currentIndexById) },
          ],
          values: [[...side.references], [...current.references]],
        }, `field:${side.id}:${field}`);
        merged.references = [...current.references];
      }
      continue;
    }

    const oldVal = old[field];
    const sideVal = side[field];
    const currentVal = current[field];
    if (sideVal === oldVal) {
      merged[field] = currentVal;
    } else if (currentVal === oldVal || sideVal === currentVal) {
      merged[field] = sideVal;
    } else {
      addConflict(ctx, {
        kind: 'field',
        docId,
        docTitle,
        stepId: side.id,
        stepTitle,
        field,
        fieldLabel: label,
        baseText: oldVal || '（空）',
        options: [
          { side: sideLabel, text: sideVal || '（空）' },
          { side: onlineLabel, text: currentVal || '（空）' },
        ],
        values: [sideVal, currentVal],
      }, `field:${side.id}:${field}`);
      merged[field] = currentVal;
    }
  }

  // 旁注等非阻塞字段：离线没动保留在线值；离线改了则叠加（在线也改时并列保留）
  for (const noteField of NOTE_FIELDS) {
    if (side[noteField] === old[noteField]) {
      merged[noteField] = current[noteField];
    } else {
      const result = mergeAnnotationText(old[noteField], side[noteField], current[noteField], sideLabel, onlineLabel);
      merged[noteField] = result.value;
      if (result.joined) ctx.notices.push(`《${docTitle}》${stepTitle}的${NOTE_LABELS[noteField]}离线与在线均有修改，已并列保留。`);
    }
  }
  if (side.type !== old.type) merged.type = current.type === old.type ? side.type : current.type;
  return merged;
}

/** 两边以相同 id 各自新建文档（概率极低）：无共同祖先，冲突字段仍走待处理项。 */
function mergeDocumentAddedByBoth(
  ctx: MergeContext,
  leftDoc: ProofDocument,
  rightDoc: ProofDocument,
  labelLeft: string,
  labelRight: string,
): ProofDocument {
  const base: ProofDocument = {
    ...clone(leftDoc),
    title: leftDoc.title,
    author: leftDoc.author,
    goal: leftDoc.goal,
    symbols: {},
    steps: [],
    versions: mergeVersions(leftDoc.versions, rightDoc.versions),
    updatedAt: maxIso(leftDoc.updatedAt, rightDoc.updatedAt),
  };
  const merged = mergeDocument(
    ctx,
    { ...clone(base), title: '', author: '', goal: '', symbols: {}, steps: [], versions: [] },
    leftDoc,
    rightDoc,
    labelLeft,
    labelRight,
    'L',
  );
  return merged ?? clone(leftDoc);
}

function mergeDocumentSet(
  base: ProofDocument[],
  leftDocs: ProofDocument[],
  rightDocs: ProofDocument[] | null,
  labelLeft: string,
  labelRight: string,
  newerSide: 'L' | 'R',
  ctx: MergeContext,
): ProofDocument[] {
  const ghost = rightDocs === null;
  const rightSource = rightDocs ?? base;
  const baseMap = new Map(base.map((doc) => [doc.id, doc]));
  const leftMap = new Map(leftDocs.map((doc) => [doc.id, doc]));
  const rightMap = new Map(rightSource.map((doc) => [doc.id, doc]));

  // 以左稿顺序为底稿，再追加右稿新增的文档。
  const orderedIds: string[] = leftDocs.map((doc) => doc.id);
  rightSource.forEach((doc) => {
    if (!orderedIds.includes(doc.id)) orderedIds.push(doc.id);
  });

  const merged: ProofDocument[] = [];
  for (const id of orderedIds) {
    const result = mergeDocument(
      ctx,
      baseMap.get(id),
      leftMap.get(id),
      ghost ? baseMap.get(id) : rightMap.get(id),
      labelLeft,
      ghost ? '' : labelRight,
      newerSide,
    );
    if (result) merged.push(result);
  }
  return merged;
}

/** 单边重连：把 sideDocs（基于 oldBaseDocs）的改动变基叠加到 currentBaseDocs 上。 */
function rebaseDocumentSet(
  oldBaseDocs: ProofDocument[],
  sideDocs: ProofDocument[],
  currentBaseDocs: ProofDocument[],
  sideLabel: string,
  onlineLabel: string,
  ctx: MergeContext,
): ProofDocument[] {
  const oldMap = new Map(oldBaseDocs.map((doc) => [doc.id, doc]));
  const sideMap = new Map(sideDocs.map((doc) => [doc.id, doc]));
  const currentMap = new Map(currentBaseDocs.map((doc) => [doc.id, doc]));

  const orderedIds: string[] = currentBaseDocs.map((doc) => doc.id);
  sideDocs.forEach((doc) => {
    if (!orderedIds.includes(doc.id)) orderedIds.push(doc.id);
  });

  const merged: ProofDocument[] = [];
  for (const id of orderedIds) {
    const result = rebaseDocument(ctx, oldMap.get(id), sideMap.get(id), currentMap.get(id), sideLabel, onlineLabel);
    if (result) merged.push(result);
  }
  return merged;
}

/** 删除步骤后，任何引用都不能再指向它；同时去重。 */
export function sanitizeReferences(documents: ProofDocument[], notices?: string[], docTitleFor?: (id: string) => string): ProofDocument[] {
  const result = clone(documents);
  for (const doc of result) {
    const alive = new Set(doc.steps.map((step) => step.id));
    const indexById = new Map(doc.steps.map((step, index) => [step.id, index + 1]));
    for (const step of doc.steps) {
      const before = step.references;
      const deduped = [...new Set(before)].filter((id) => alive.has(id));
      if (deduped.length !== before.length) {
        step.references = deduped;
        if (notices) {
          const dropped = before.filter((id) => !alive.has(id));
          const title = docTitleFor?.(doc.id) ?? doc.title;
          const position = indexById.get(step.id) ?? doc.steps.indexOf(step) + 1;
          ctx_noticeRemoved(notices, title, position, dropped);
        }
      }
    }
  }
  return result;
}

function ctx_noticeRemoved(notices: string[], docTitle: string, position: number, dropped: string[]): void {
  notices.push(`《${docTitle}》步骤 ${position} 引用的步骤已删除（${dropped.join('、')}），对应引用已移除。`);
}

/**
 * 把若干标签的本地稿与共同祖先合并成一份合并稿。
 * sides 按保存时间从早到晚排列；两份以上时依次与累计合并稿再合并。
 * history 提供历史基线快照：当某些标签断网跨越了多次快进提交时，
 * 取所有待合并本地稿中「最高的基线修订号」对应快照作为共同祖先，
 * 避免把较新的快进内容误当成祖先值而覆盖掉。
 */
export function mergeProofWorkspaces(
  base: ProofDocument[],
  sides: MergeSideInput[],
  history: { revision: number; documents: ProofDocument[] }[] = [],
): MergeReport {
  const ctx: MergeContext = { conflicts: [], notices: [], seenConflictKeys: new Set(), sequence: 0 };

  const ancestorFor = (subset: MergeSideInput[]): ProofDocument[] => {
    const revisions = subset.map((side) => side.baseRevision ?? 0).filter((revision) => revision > 0);
    if (!revisions.length) return base;
    const target = Math.min(...revisions);
    // 多标签共同祖先取「所有相关本地稿都见过的最高修订号」= 最小的基修订号对应的快照。
    const snapshot = [...history].sort((a, b) => b.revision - a.revision).find((item) => item.revision <= target);
    return snapshot ? snapshot.documents : base;
  };

  let documents: ProofDocument[];

  if (sides.length === 0) {
    documents = clone(base);
  } else if (sides.length === 1) {
    // 只有一份分歧稿（典型：一个标签离线，其他标签在线做了快进提交）：
    // 把离线稿相对其旧基线的改动「变基」到当前最新在线稿上，离线没动的内容保持在线值。
    documents = rebaseDocumentSet(ancestorFor(sides), sides[0].documents, base, sides[0].label, '在线稿', ctx);
  } else {
    const ordered = [...sides].sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
    documents = mergeDocumentSet(
      ancestorFor(ordered),
      ordered[0].documents,
      ordered[1].documents,
      ordered[0].label,
      ordered[1].label,
      ordered[0].savedAt > ordered[1].savedAt ? 'L' : 'R',
      ctx,
    );
    for (let index = 2; index < ordered.length; index += 1) {
      const side = ordered[index];
      // 累计合并稿代表此前所有（更新的）稿；与新到的一方合并时，祖先不能新到吞掉它的改动，
      // 因此以这一方的基线为共同祖先。
      const ancestor = ancestorFor([side]);
      documents = mergeDocumentSet(ancestor, documents, side.documents, '此前合并稿', side.label, 'R', ctx);
    }
  }

  // 回填待处理项所属文档标题，并做第一轮失效引用清理。
  const titleById = new Map(documents.map((doc) => [doc.id, doc.title]));
  for (const conflict of ctx.conflicts) {
    if (!conflict.docTitle) conflict.docTitle = titleById.get(conflict.docId) ?? '未命名证明';
  }
  documents = sanitizeReferences(documents, ctx.notices, (id) => titleById.get(id) ?? '未命名证明');

  return {
    documents,
    conflicts: ctx.conflicts,
    notices: ctx.notices,
    sides: [...sides].sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1)),
  };
}

/** 老师逐项选择后，应用全部决议并再次清理引用，得到最终合并稿。 */
export function resolveMergeReport(report: MergeReport): ProofDocument[] {
  const documents = clone(report.documents);
  for (const conflict of report.conflicts) {
    if (conflict.chosen === undefined) continue;
    const doc = documents.find((item) => item.id === conflict.docId);

    if (conflict.kind === 'doc-existence') {
      if (conflict.chosen === 1) {
        const index = documents.findIndex((item) => item.id === conflict.docId);
        if (index >= 0) documents.splice(index, 1);
      } else if (doc && conflict.keepDoc) {
        const keepIndex = documents.findIndex((item) => item.id === doc.id);
        if (keepIndex < 0) documents.push(clone(conflict.keepDoc));
        else documents[keepIndex] = clone(conflict.keepDoc);
      }
      continue;
    }

    if (!doc) continue;
    let step = doc.steps.find((item) => item.id === conflict.stepId);

    if (conflict.kind === 'step-existence') {
      if (conflict.chosen === 1) {
        doc.steps = doc.steps.filter((item) => item.id !== conflict.stepId);
      } else if (conflict.keepStep) {
        if (!step) insertByAnchor(doc.steps, clone(conflict.keepStep), conflict.keepDoc?.steps ?? doc.steps);
        else {
          const index = doc.steps.findIndex((item) => item.id === step!.id);
          doc.steps[index] = clone(conflict.keepStep);
        }
      }
      continue;
    }

    if (!step || !conflict.field || conflict.values === undefined) continue;
    const value = conflict.values[conflict.chosen] as string | string[];
    if (conflict.field === 'references' && Array.isArray(value)) {
      step.references = [...value];
    } else if (conflict.field === 'statement' && typeof value === 'string') {
      step.statement = value;
    } else if (conflict.field === 'rule' && typeof value === 'string') {
      step.rule = value;
    }
  }
  return sanitizeReferences(documents);
}

// ---------------------------------------------------------------------------
// 传输层：localStorage + BroadcastChannel，维护 base / draft / 会话与选举
// ---------------------------------------------------------------------------

export interface SyncSink {
  /** 其他标签提交了新版本，或合并完成后，要求用合并稿替换当前编辑区。 */
  onRemoteDocuments(documents: ProofDocument[], revision: number): void;
  /** 在线 / 离线 / 等待 / 合并中 状态或待处理项发生变化。 */
  onSyncStateChange(): void;
}

/** 运行环境（浏览器全局的可注入替身，便于在 Node 中核对多标签行为）。 */
export interface SyncEnv {
  localStorage: Storage;
  sessionStorage: Storage;
  window: EventTarget;
  navigator: { onLine: boolean };
  BroadcastChannel?: typeof BroadcastChannel;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** 测试用：覆盖恢复联网的宽限等待时长。 */
  reconnectGrace?: number;
  /** 测试用：覆盖会话存活判定时长。 */
  sessionTtl?: number;
  Date?: DateConstructor;
}

let env: SyncEnv;

function readJSON<T>(key: string): T | null {
  try {
    const raw = env.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  env.localStorage.setItem(key, JSON.stringify(value));
}

/** 写入共享基线；超出 localStorage 容量时逐级丢弃历史快照后重试，保证当前稿总能落盘。 */
function writeBase(base: SyncBase): void {
  let history = base.history;
  for (let attempt = 0; attempt <= 6; attempt += 1) {
    try {
      writeJSON(BASE_KEY, { ...base, history });
      base.history = history;
      return;
    } catch {
      if (history.length <= 1) {
        // 只剩当前版本时仍失败：丢弃全部历史再试一次
        try {
          writeJSON(BASE_KEY, { ...base, history: [] });
          base.history = [];
          return;
        } catch {
          return;
        }
      }
      history = history.slice(Math.ceil(history.length / 2));
    }
  }
}

function createId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SyncHub {
  mode: SyncMode = 'online';
  readonly sessionId: string;
  label: string;
  base: SyncBase;
  pending: MergeReport | null = null;
  mergerLabel = '';
  /** null 表示跟随浏览器 online/offline；true/false 为老师手动模拟的联网状态。 */
  private simulated: boolean | null = null;

  private draft: SyncDraft;
  private channel: BroadcastChannel | null;
  private readonly sink: SyncSink;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval>;
  private knownRevision: number;
  private readonly sessionTtl: number;
  private readonly reconnectGrace: number;

  constructor(sink: SyncSink, seedDocuments: () => ProofDocument[], envOverride?: Partial<SyncEnv>) {
    this.sink = sink;
    env = {
      localStorage: globalThis.localStorage,
      sessionStorage: globalThis.sessionStorage,
      window: globalThis.window,
      navigator: globalThis.navigator,
      BroadcastChannel: globalThis.BroadcastChannel,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      ...envOverride,
    } as SyncEnv;
    this.sessionTtl = env.sessionTtl ?? SESSION_TTL;
    this.reconnectGrace = env.reconnectGrace ?? RECONNECT_GRACE;
    const { sessionStorage: session } = env;
    this.sessionId = session.getItem(SID_KEY) || createId();
    session.setItem(SID_KEY, this.sessionId);

    const existing = readJSON<SyncBase>(BASE_KEY);
    if (existing && Array.isArray(existing.documents)) {
      // 兼容旧版没有 history 字段的基线。
      this.base = Array.isArray(existing.history)
        ? existing
        : { ...existing, history: [{ revision: existing.revision, documents: clone(existing.documents) }] };
    } else {
      // 首次升级：沿用旧版整存数据作为共享基线。
      const legacy = readJSON<ProofDocument[]>(LEGACY_STORAGE_KEY);
      const documents = legacy && Array.isArray(legacy) && legacy.length ? legacy : seedDocuments();
      this.base = {
        revision: 1,
        documents: clone(documents),
        updatedAt: nowIso(),
        history: [{ revision: 1, documents: clone(documents) }],
      };
      writeBase(this.base);
    }
    this.knownRevision = this.base.revision;

    this.label = this.claimLabel();
    this.draft = this.syncedDraft(this.base.documents);
    this.persistDraft();

    const ChannelCtor = env.BroadcastChannel;
    this.channel = typeof ChannelCtor === 'function' ? new ChannelCtor(CHANNEL_NAME) : null;
    this.channel?.addEventListener('message', (event: MessageEvent<ChannelMessage>) => this.onMessage(event.data));
    env.window.addEventListener('online', this.onNavigatorOnline);
    env.window.addEventListener('offline', this.onNavigatorOffline);
    env.window.addEventListener('storage', this.onStorage as EventListener);
    env.window.addEventListener('beforeunload', this.onBeforeUnload);
    this.heartbeatTimer = env.setInterval(() => this.heartbeat(), 2000);

    // 打开页面时浏览器就处于离线状态：直接进入本地稿模式（首次心跳也按离线登记）。
    if (!this.online) this.mode = 'offline';
    this.heartbeat();
  }

  get online(): boolean {
    return this.simulated ?? env.navigator.onLine;
  }

  // -- 持久化 -------------------------------------------------------------

  private draftKey(): string {
    return `${DRAFT_PREFIX}${this.sessionId}`;
  }

  private syncedDraft(documents: ProofDocument[]): SyncDraft {
    return {
      sessionId: this.sessionId,
      label: this.label,
      online: true,
      ancestor: clone(documents),
      ancestorBaseRevision: this.base.revision,
      documents: clone(documents),
      baseRevision: this.base.revision,
      savedAt: nowIso(),
    };
  }

  private persistDraft(): void {
    this.draft.sessionId = this.sessionId;
    this.draft.label = this.label;
    this.draft.savedAt = nowIso();
    writeJSON(this.draftKey(), this.draft);
  }

  private pushHistory(previous: SyncBase): SyncBase['history'] {
    const history = [...(previous.history ?? []), { revision: previous.revision, documents: clone(previous.documents) }];
    return history.slice(-HISTORY_LIMIT);
  }

  private commit(documents: ProofDocument[]): void {
    this.base = {
      revision: this.base.revision + 1,
      documents: clone(documents),
      updatedAt: nowIso(),
      history: this.pushHistory(this.base),
    };
    this.knownRevision = this.base.revision;
    writeBase(this.base);
    this.draft = this.syncedDraft(documents);
    this.persistDraft();
    this.scheduleFlush();
  }

  /** 编辑区发生改动：在线立即提交基线，离线只保留本标签本地稿。 */
  localChanged(documents: ProofDocument[]): void {
    if (this.mode === 'offline') {
      this.draft.online = false;
      this.draft.baseRevision = this.base.revision;
      this.draft.documents = clone(documents);
      this.persistDraft();
      return;
    }
    if (this.mode === 'online') {
      this.commit(documents);
    }
  }

  /** Ctrl/Cmd+S：在线已逐字同步，离线把本地稿落盘。 */
  saveNow(documents: ProofDocument[]): void {
    this.localChanged(documents);
  }

  // -- 会话与标签编号 ------------------------------------------------------

  private liveSessions(): SyncSession[] {
    const sessions: SyncSession[] = [];
    for (let index = 0; index < env.localStorage.length; index += 1) {
      const key = env.localStorage.key(index);
      if (!key?.startsWith(SESSION_PREFIX)) continue;
      const session = readJSON<SyncSession>(key);
      if (session && Date.now() - session.lastSeen < this.sessionTtl) sessions.push(session);
    }
    return sessions;
  }

  private claimLabel(): string {
    const live = this.liveSessions().filter((session) => session.id !== this.sessionId);
    const used = new Set(live.map((session) => session.label));
    const ordinal = SYNC_ORDINALS.find((candidate) => !used.has(`标签${candidate}`)) ?? SYNC_ORDINALS[SYNC_ORDINALS.length - 1];
    this.label = `标签${ordinal}`;
    return this.label;
  }

  private heartbeat(): void {
    writeJSON(`${SESSION_PREFIX}${this.sessionId}`, {
      id: this.sessionId,
      label: this.label,
      online: this.mode !== 'offline',
      lastSeen: Date.now(),
    } satisfies SyncSession);
    // 老师处理待处理项期间持续续约合并锁，防止等待者误以为持锁标签已消失。
    if (this.mode === 'merging') {
      writeJSON(LOCK_KEY, { owner: this.sessionId, label: this.label, at: Date.now() } satisfies MergeLock);
    }
    if (this.mode === 'waiting') this.checkLock();
  }

  private onBeforeUnload = (): void => {
    env.localStorage.removeItem(`${SESSION_PREFIX}${this.sessionId}`);
    this.draft.online = this.mode === 'online';
    this.persistDraft();
  };

  // -- 浏览器事件 ----------------------------------------------------------

  private onNavigatorOnline = (): void => {
    if (this.simulated !== null) return;
    this.reconnect();
  };

  private onNavigatorOffline = (): void => {
    if (this.simulated !== null) return;
    this.goOffline();
  };

  /** 老师手动切换联网状态（真实断网由浏览器事件触发，这里用于演示与核对）。 */
  setSimulatedOnline(value: boolean): void {
    this.simulated = value;
    if (value) this.reconnect();
    else this.goOffline();
  }

  private goOffline(): void {
    if (this.mode === 'offline') return;
    this.mode = 'offline';
    this.pending = null;
    this.draft.online = false;
    this.persistDraft();
    this.heartbeat(); // 立即把会话标记为离线，让其他标签的宽限等待能观察到
    this.sink.onSyncStateChange();
  }

  // -- 重连与合并选举 ------------------------------------------------------

  private reconnect(): void {
    this.draft.online = true;
    // 先把状态切到非离线，再发心跳，否则这一帧心跳会把本会话错误登记为离线。
    this.mode = 'waiting';
    this.mergerLabel = '等待其他标签重新上线';
    this.persistDraft();
    this.heartbeat();
    this.sink.onSyncStateChange();
    if (this.graceTimer) env.clearTimeout(this.graceTimer);
    const startedAt = Date.now();
    const tick = (): void => {
      this.heartbeat();
      const liveById = new Map(this.liveSessions().map((session) => [session.id, session]));
      const diverged = this.readAllDrafts().filter((draft) => !deepEqual(draft.documents, readJSON<SyncBase>(BASE_KEY)?.documents));
      const othersOnline = diverged
        .filter((draft) => draft.sessionId !== this.sessionId)
        .every((draft) => {
          const session = liveById.get(draft.sessionId);
          return !session || session.online;
        });
      if (othersOnline || Date.now() - startedAt >= this.reconnectGrace) {
        this.graceTimer = null;
        this.reconcile();
      } else {
        this.graceTimer = env.setTimeout(tick, 200);
      }
    };
    this.graceTimer = env.setTimeout(tick, 200);
  }

  private readAllDrafts(): SyncDraft[] {
    const drafts: SyncDraft[] = [];
    for (let index = 0; index < env.localStorage.length; index += 1) {
      const key = env.localStorage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const draft = readJSON<SyncDraft>(key);
      if (draft && Array.isArray(draft.documents)) drafts.push(draft);
    }
    return drafts;
  }

  private readLock(): MergeLock | null {
    const lock = readJSON<MergeLock>(LOCK_KEY);
    return lock && Date.now() - lock.at < LOCK_TTL ? lock : null;
  }

  private reconcile(): void {
    this.base = readJSON<SyncBase>(BASE_KEY) ?? this.base;
    this.knownRevision = this.base.revision;

    const liveSessions = this.liveSessions();
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    // 仍离线的标签草稿暂不合并：它基于的共同祖先可能已过期，应等它自己恢复后再参与，避免产生伪冲突。
    const eligible = (draft: SyncDraft): boolean => {
      const session = liveById.get(draft.sessionId);
      return !session || session.online;
    };
    const diverged = this.readAllDrafts()
      .filter((draft) => !deepEqual(draft.documents, this.base.documents))
      .filter(eligible);

    // 仍有“存活但离线”的标签持着分歧本地稿：不能把自己的稿快进提交（那正是要避免的覆盖）。
    // 等它恢复上线，或心跳超时（视为已关闭，其草稿按 eligible 规则并入）后再继续。
    const pendingOffline = this.readAllDrafts()
      .filter((draft) => !deepEqual(draft.documents, this.base.documents))
      .some((draft) => liveById.get(draft.sessionId)?.online === false);
    if (pendingOffline) {
      this.mode = 'waiting';
      this.pending = null;
      this.mergerLabel = '等待离线标签恢复后合并';
      this.sink.onSyncStateChange();
      // 短周期轮询：其他标签一恢复上线（或其会话心跳超时）就能尽快重新选举，不必等满会话 TTL。
      if (!this.graceTimer) {
        this.graceTimer = env.setTimeout(() => {
          this.graceTimer = null;
          this.reconcile();
        }, 400);
      }
      return;
    }

    if (diverged.length === 0) {
      this.toIdle();
      return;
    }

    const liveIds = new Set(liveSessions.map((session) => session.id));
    liveIds.add(this.sessionId);
    const liveDivergers = diverged.map((draft) => draft.sessionId).filter((id) => liveIds.has(id));
    // 兜底选举只在在线会话中进行，保证一定有人执行合并。
    const onlineIds = new Set(liveSessions.filter((session) => session.online).map((session) => session.id));
    onlineIds.add(this.sessionId);
    const candidates = liveDivergers.length ? liveDivergers : [...onlineIds];
    const elected = [...candidates].sort().at(-1) as string;

    if (elected === this.sessionId) {
      this.runMerge(diverged);
    } else {
      const owner = this.readLock();
      this.mergerLabel = owner?.label ?? diverged.find((draft) => draft.sessionId === elected)?.label ?? '其他标签';
      this.mode = 'waiting';
      this.pending = null;
      this.sink.onSyncStateChange();
    }
  }

  private toIdle(): void {
    const lock = readJSON<MergeLock>(LOCK_KEY);
    if (lock?.owner === this.sessionId) env.localStorage.removeItem(LOCK_KEY);
    this.mode = 'online';
    this.pending = null;
    this.mergerLabel = '';
    // 把已被消费的在线/关闭标签草稿对齐到基线，仍离线的标签草稿保留。
    const liveById = new Map(this.liveSessions().map((session) => [session.id, session]));
    for (const draft of this.readAllDrafts()) {
      if (liveById.get(draft.sessionId)?.online === false) continue;
      writeJSON(`${DRAFT_PREFIX}${draft.sessionId}`, this.syncedDraft(this.base.documents));
    }
    this.draft = this.syncedDraft(this.base.documents);
    this.persistDraft();
    this.sink.onSyncStateChange();
  }

  private runMerge(diverged: SyncDraft[]): void {
    const sides: MergeSideInput[] = [...diverged]
      .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1))
      .map((draft) => ({
        label: draft.label,
        documents: clone(draft.documents),
        savedAt: draft.savedAt,
        baseRevision: draft.baseRevision,
      }));

    const report = mergeProofWorkspaces(this.base.documents, sides, this.base.history);

    if (report.conflicts.length === 0) {
      this.finishMerge(report.documents);
      return;
    }

    const lock: MergeLock = { owner: this.sessionId, label: this.label, at: Date.now() };
    writeJSON(LOCK_KEY, lock);
    this.mode = 'merging';
    this.pending = report;
    this.post({ type: 'merge-start', from: this.sessionId, label: this.label, at: lock.at });
    this.sink.onSyncStateChange();
  }

  resolveConflict(conflictId: string, optionIndex: number): void {
    const conflict = this.pending?.conflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    conflict.chosen = optionIndex;
    this.sink.onSyncStateChange();
  }

  get allConflictsResolved(): boolean {
    return !!this.pending && this.pending.conflicts.every((conflict) => conflict.chosen !== undefined);
  }

  confirmMerge(): void {
    if (this.mode !== 'merging' || !this.pending || !this.allConflictsResolved) return;
    const documents = resolveMergeReport(this.pending);
    this.finishMerge(documents);
  }

  private finishMerge(documents: ProofDocument[]): void {
    env.localStorage.removeItem(LOCK_KEY);
    this.base = {
      revision: this.base.revision + 1,
      documents: clone(documents),
      updatedAt: nowIso(),
      history: this.pushHistory(this.base),
    };
    this.knownRevision = this.base.revision;
    writeBase(this.base);
    this.toIdleAfterMerged();
    // 立即广播一次即可；不要再 scheduleFlush，否则对端收到第二发 commit 会重置拉取防抖。
    this.post({ type: 'commit', revision: this.base.revision, from: this.sessionId });
    this.sink.onRemoteDocuments(this.base.documents, this.base.revision);
    this.sink.onSyncStateChange();
  }

  private toIdleAfterMerged(): void {
    const liveById = new Map(this.liveSessions().map((session) => [session.id, session]));
    for (const draft of this.readAllDrafts()) {
      if (liveById.get(draft.sessionId)?.online === false) continue;
      writeJSON(`${DRAFT_PREFIX}${draft.sessionId}`, this.syncedDraft(this.base.documents));
    }
    this.draft = this.syncedDraft(this.base.documents);
    this.persistDraft();
    this.mode = 'online';
    this.pending = null;
    this.mergerLabel = '';
  }

  private checkLock(): void {
    const lock = this.readLock();
    if (lock) {
      this.mergerLabel = lock.label;
      return;
    }
    // 持锁标签消失：由等待者重新选举。
    this.reconcile();
  }

  // -- 跨标签消息 ----------------------------------------------------------

  private post(message: ChannelMessage): void {
    this.channel?.postMessage(message);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = env.setTimeout(() => {
      this.flushTimer = null;
      this.post({ type: 'commit', revision: this.base.revision, from: this.sessionId });
    }, FLUSH_DELAY);
  }

  private onMessage(message: ChannelMessage): void {
    if (message.from === this.sessionId) return;
    if (message.type === 'commit') {
      this.scheduleRemoteReload();
    } else if (message.type === 'merge-start') {
      this.handleMergeStart(message.from, message.label);
    }
  }

  private handleMergeStart(from: string, label: string): void {
    if (this.mode === 'merging') {
      // 选举应只有一个胜者；若对端 id 更大则让位。
      if (from > this.sessionId) {
        this.mode = 'waiting';
        this.pending = null;
        this.mergerLabel = label;
        this.sink.onSyncStateChange();
      }
      return;
    }
    if (this.mode === 'offline') return;
    this.mergerLabel = label;
    this.mode = 'waiting';
    this.sink.onSyncStateChange();
  }

  private onStorage = (event: StorageEvent): void => {
    if (event.key === BASE_KEY) this.scheduleRemoteReload();
    else if (event.key === LOCK_KEY && event.newValue) {
      try {
        const lock = JSON.parse(event.newValue) as MergeLock;
        if (lock.owner !== this.sessionId) this.handleMergeStart(lock.owner, lock.label);
      } catch {
        // 忽略损坏的锁记录
      }
    }
  };

  private scheduleRemoteReload(): void {
    if (this.mode === 'offline') return;
    if (this.reloadTimer) env.clearTimeout(this.reloadTimer);
    this.reloadTimer = env.setTimeout(() => this.applyRemoteBase(), FLUSH_DELAY);
  }

  private applyRemoteBase(): void {
    const latest = readJSON<SyncBase>(BASE_KEY);
    if (!latest || latest.revision <= this.knownRevision) {
      if (this.mode === 'waiting') this.reconcile();
      return;
    }
    this.base = latest;
    this.knownRevision = latest.revision;

    if (this.mode === 'waiting') {
      // 合并稿已发布：替换编辑区。此时自己的旧稿已被合并稿取代，直接对齐转在线，
      // 不再调用 reconcile（否则会把刚被取代的旧草稿又当成新分歧，重开合并面板）。
      this.sink.onRemoteDocuments(latest.documents, latest.revision);
      this.draft = this.syncedDraft(latest.documents);
      this.persistDraft();
      this.toIdle();
      return;
    }

    if (this.mode === 'online') {
      this.sink.onRemoteDocuments(latest.documents, latest.revision);
      this.draft = this.syncedDraft(latest.documents);
      this.persistDraft();
    }
  }

  dispose(): void {
    if (this.flushTimer) env.clearTimeout(this.flushTimer);
    if (this.reloadTimer) env.clearTimeout(this.reloadTimer);
    env.clearInterval(this.heartbeatTimer);
    this.channel?.close();
    env.window.removeEventListener('online', this.onNavigatorOnline);
    env.window.removeEventListener('offline', this.onNavigatorOffline);
    env.window.removeEventListener('storage', this.onStorage as EventListener);
    env.window.removeEventListener('beforeunload', this.onBeforeUnload);
  }
}

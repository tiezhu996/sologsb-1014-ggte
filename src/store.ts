import { redraw } from 'mithril';
import { mergeThreeWay, type DraftEnvelope } from './merge';
import type {
  MergeConflict,
  MergeReport,
  PendingMerge,
  ProofCheck,
  ProofDocument,
  ProofStep,
  ProofVersion,
} from './types';

const STORAGE_KEY = 'sologsb-1014-proof-workspace-v1';
const SHARED_KEY = 'sologsb-1014-shared-v2';
const DRAFTS_KEY = 'sologsb-1014-drafts-v2';
const OFFLINE_KEY = 'sologsb-1014-offline-v2';
const LOCK_KEY = 'sologsb-1014-merge-lock-v2';
const PENDING_KEY = 'sologsb-1014-pending-merge-v2';
const TAB_KEY = 'sologsb-1014-tab';
const LOCK_TTL_MS = 120_000;

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clone = <T>(value: T): T => structuredClone(value);

export const RULES = ['前提', '定义展开', '代入', '等式变形', '分配律', '同类项合并', '数学归纳', '反证法', '构造法', '结论'];

interface SharedWorkspace {
  rev: number;
  docs: ProofDocument[];
  /** tabId -> 该标签离线稿被并入合并稿的时间，用于避免重连时重复合并 */
  consumed: Record<string, string>;
}

function sampleSteps(): ProofStep[] {
  return [
    { id: 's1', type: 'premise', statement: '$a,b$ 是实数', rule: '前提', references: [], note: '采用实数域中的交换律与分配律。', counterexample: '', alternative: '' },
    { id: 's2', type: 'derivation', statement: '$(a+b)^2=(a+b)(a+b)$', rule: '定义展开', references: ['s1'], note: '把平方写成两个相同因式之积。', counterexample: '', alternative: '' },
    { id: 's3', type: 'derivation', statement: '$(a+b)(a+b)=a^2+ab+ba+b^2$', rule: '分配律', references: ['s2'], note: '', counterexample: '', alternative: '也可先展开后半部分。' },
    { id: 's4', type: 'derivation', statement: '$a^2+ab+ba+b^2=a^2+2ab+b^2$', rule: '同类项合并', references: ['s3'], note: '由实数的交换律，$ab=ba$。', counterexample: '', alternative: '' },
    { id: 's5', type: 'goal', statement: '$(a+b)^2=a^2+2ab+b^2$', rule: '结论', references: ['s4'], note: '目标已由步骤 1 至 4 逐项推出。', counterexample: '', alternative: '' },
  ];
}

function issueSteps(): ProofStep[] {
  return [
    { id: 'i1', type: 'premise', statement: '$n$ 是正整数', rule: '前提', references: [], note: '', counterexample: '', alternative: '' },
    { id: 'i2', type: 'derivation', statement: '$P(1)$ 成立', rule: '前提', references: ['i1'], note: '归纳基例。', counterexample: '', alternative: '' },
    { id: 'i3', type: 'derivation', statement: '若 $P(k)$ 成立，则 $P(k+1)$ 也成立', rule: '数学归纳', references: ['missing-step'], note: '这里故意保留一个失效引用，用于演示检查。', counterexample: '', alternative: '' },
    { id: 'i4', type: 'goal', statement: '$P(n)$ 对所有正整数 $n$ 成立', rule: '结论', references: ['i3'], note: '尚未补齐归纳假设。', counterexample: '', alternative: '' },
  ];
}

function initialDocuments(): ProofDocument[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'doc-algebra',
      title: '完全平方公式证明',
      author: '数学组',
      goal: '$(a+b)^2=a^2+2ab+b^2$',
      symbols: { a: '实数', b: '实数', P: '关于正整数的命题', n: '正整数', k: '正整数' },
      steps: sampleSteps(),
      versions: [],
      updatedAt: now,
    },
    {
      id: 'doc-induction',
      title: '数学归纳法待核对稿',
      author: '学生工作区',
      goal: '$P(n)$ 对所有正整数 $n$ 成立',
      symbols: { P: '关于正整数的命题', n: '正整数', k: '正整数' },
      steps: issueSteps(),
      versions: [],
      updatedAt: now,
    },
  ];
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/** 首次升级：把旧版整包存储迁移为共享合并稿 */
function bootstrapShared(): SharedWorkspace {
  const existing = readJSON<SharedWorkspace | null>(SHARED_KEY, null);
  if (existing && Array.isArray(existing.docs)) return existing;
  let docs: ProofDocument[];
  const legacy = readJSON<ProofDocument[] | null>(STORAGE_KEY, null);
  if (Array.isArray(legacy) && legacy.length) {
    docs = legacy;
  } else {
    docs = initialDocuments();
  }
  const shared: SharedWorkspace = { rev: 1, docs, consumed: {} };
  writeJSON(SHARED_KEY, shared);
  return shared;
}

function readSessionJSON<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadTabIdentity(): { id: string; name: string } {
  // sessionStorage 按浏览器标签隔离，天然作为标签身份
  const saved = readSessionJSON<{ id: string; name: string } | null>(TAB_KEY, null);
  if (saved?.id) return saved;
  const id = uid('tab');
  const name = `标签 ${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const identity = { id, name };
  sessionStorage.setItem(TAB_KEY, JSON.stringify(identity));
  return identity;
}

export class ProofStore {
  // —— 标签身份与连接状态 ——
  tabId: string;
  tabName: string;
  online: boolean;
  private offlineOverride = localStorage.getItem(OFFLINE_KEY) === 'true';
  private offlineBase: ProofDocument[] | null = null;
  private offlineBaseRev = 0;

  // —— 工作区 ——
  documents: ProofDocument[];
  private rev: number;
  activeId: string;
  selectedStepId: string;
  compareVersionId = '';
  dragStepId = '';
  lastInput: HTMLTextAreaElement | HTMLInputElement | null = null;
  undoStack: ProofDocument[][] = [];
  redoStack: ProofDocument[][] = [];
  toast = '';

  // —— 合并 ——
  pendingMerge: PendingMerge | null = null;
  private merging = false;
  lastMerge: { at: string; reports: MergeReport[]; conflictCount: number } | null = null;

  constructor() {
    const identity = loadTabIdentity();
    this.tabId = identity.id;
    this.tabName = identity.name;

    const shared = bootstrapShared();
    this.rev = shared.rev;
    this.documents = shared.docs;
    this.online = navigator.onLine && !this.offlineOverride;

    // 重开页面时若有待处理合并，继续承接
    const pending = readJSON<PendingMerge | null>(PENDING_KEY, null);
    const ownDraft = this.readDrafts()[this.tabId];
    if (pending && this.online) {
      this.pendingMerge = pending;
      this.documents = pending.merged;
    } else if (!this.online) {
      if (ownDraft?.base) {
        // 离线状态下刷新页面：继续使用本标签的本地稿
        this.documents = ownDraft.docs;
        this.offlineBase = ownDraft.base;
        this.offlineBaseRev = ownDraft.baseRev;
      } else {
        // 断网期间新开的标签：冻结共同基线并生成本地稿
        this.documents = clone(shared.docs);
        this.offlineBase = clone(shared.docs);
        this.offlineBaseRev = shared.rev;
        this.writeOwnEnvelope(this.offlineBase, this.offlineBaseRev, this.documents);
      }
    } else if (this.online) {
      this.writeOwnEnvelope(null, this.rev, this.documents);
    }

    this.activeId = this.documents[0]?.id ?? '';
    this.selectedStepId = this.documents[0]?.steps[0]?.id ?? '';

    window.addEventListener('online', () => this.refreshConnectionState());
    window.addEventListener('offline', () => this.refreshConnectionState());
    window.addEventListener('storage', (event) => this.handleStorage(event));
  }

  get current(): ProofDocument {
    return this.documents.find((item) => item.id === this.activeId) ?? this.documents[0];
  }

  get selectedStep(): ProofStep | undefined {
    return this.current?.steps.find((step) => step.id === this.selectedStepId);
  }

  get checks(): ProofCheck[] {
    if (!this.current) return [];
    return validate(this.current);
  }

  /** 有待处理冲突时，编辑区整体锁定，老师选定后才能继续 */
  get locked(): boolean {
    return this.pendingMerge !== null;
  }

  // —— 持久化 ——

  private readShared(): SharedWorkspace {
    return readJSON<SharedWorkspace>(SHARED_KEY, { rev: this.rev, docs: this.documents, consumed: {} });
  }

  private readDrafts(): Record<string, DraftEnvelope> {
    return readJSON<Record<string, DraftEnvelope>>(DRAFTS_KEY, {});
  }

  private writeOwnEnvelope(base: ProofDocument[] | null, baseRev: number, docs: ProofDocument[]): void {
    const drafts = this.readDrafts();
    drafts[this.tabId] = {
      tabId: this.tabId,
      tabName: this.tabName,
      updatedAt: new Date().toISOString(),
      base: base ? clone(base) : null,
      baseRev,
      docs: clone(docs),
    };
    writeJSON(DRAFTS_KEY, drafts);
  }

  drafts(): DraftEnvelope[] {
    return Object.values(this.readDrafts()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  save(): void {
    if (this.pendingMerge) return;
    this.current.updatedAt = new Date().toISOString();
    if (this.online && !this.pendingMerge) {
      const shared = this.readShared();
      shared.rev += 1;
      shared.docs = clone(this.documents);
      this.rev = shared.rev;
      writeJSON(SHARED_KEY, shared);
      this.writeOwnEnvelope(null, this.rev, this.documents);
    } else {
      // 离线：只写本标签分槽，绝不触碰共享合并稿
      this.writeOwnEnvelope(this.offlineBase, this.offlineBaseRev, this.documents);
    }
  }

  update(mutator: (document: ProofDocument) => void): void {
    if (this.locked) return;
    this.undoStack.push(clone(this.documents));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    mutator(this.current);
    this.save();
  }

  undo(): void {
    if (this.locked) return;
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.documents));
    this.documents = previous;
    this.ensureSelection();
    this.save();
  }

  redo(): void {
    if (this.locked) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.documents));
    this.documents = next;
    this.ensureSelection();
    this.save();
  }

  // —— 连接状态 ——

  toggleConnection(): void {
    if (!navigator.onLine) {
      this.notify('浏览器当前处于离线状态，无法模拟恢复连接');
      return;
    }
    if (this.online) {
      localStorage.setItem(OFFLINE_KEY, 'true');
      this.offlineOverride = true;
      this.enterOffline();
    } else {
      localStorage.setItem(OFFLINE_KEY, 'false');
      this.offlineOverride = false;
      this.enterOnline();
    }
  }

  private refreshConnectionState(): void {
    const wasOnline = this.online;
    this.online = navigator.onLine && !this.offlineOverride;
    if (wasOnline && !this.online) this.enterOffline();
    else if (!wasOnline && this.online) this.enterOnline();
    redraw();
  }

  private enterOffline(): void {
    this.online = false;
    const shared = this.readShared();
    this.rev = shared.rev;
    this.documents = clone(shared.docs);
    this.offlineBase = clone(shared.docs);
    this.offlineBaseRev = shared.rev;
    this.ensureSelection();
    this.undoStack = [];
    this.redoStack = [];
    // 每个标签各自落一份本地稿（带共同基线），互不覆盖
    this.writeOwnEnvelope(this.offlineBase, this.offlineBaseRev, this.documents);
    this.notify(`已断开连接：改动只保存在「${this.tabName}」本地稿`);
  }

  private enterOnline(): void {
    this.online = true;
    const primary = this.readDrafts()[this.tabId];
    if (!primary?.base) {
      this.adoptShared();
      redraw();
      return;
    }
    this.performReconnect(primary);
  }

  /** 手动把某份遗留的离线本地稿并入当前合并稿（例如离线标签关闭后重开） */
  manualMergeDraft(tabId: string): void {
    if (this.locked || !this.online || this.merging) return;
    const envelope = this.readDrafts()[tabId];
    if (!envelope?.base) return;
    this.performReconnect(envelope);
  }

  private acquireLock(): boolean {
    const lock = readJSON<{ tabId: string; ts: number } | null>(LOCK_KEY, null);
    if (lock && lock.tabId !== this.tabId && Date.now() - lock.ts < LOCK_TTL_MS) return false;
    writeJSON(LOCK_KEY, { tabId: this.tabId, ts: Date.now() });
    return true;
  }

  private performReconnect(primary: DraftEnvelope): void {
    if (this.merging) return;
    // 其他标签已发起一个待处理合并：只承接，不再重复发起
    const existingPending = readJSON<PendingMerge | null>(PENDING_KEY, null);
    if (existingPending && existingPending.ownerTabId !== this.tabId) {
      this.pendingMerge = existingPending;
      this.documents = existingPending.merged;
      this.ensureSelection();
      redraw();
      return;
    }
    if (!this.acquireLock()) {
      this.notify('另一标签正在合并，稍候自动重试…');
      window.setTimeout(() => {
        if (!this.pendingMerge) this.performReconnect(this.readDrafts()[primary.tabId] ?? primary);
      }, 1000);
      return;
    }
    this.merging = true;
    try {
      const base = primary.base as ProofDocument[];
      const shared = this.readShared();

      // 该稿已被其他标签的重连合并吸收：直接采用合并稿
      const consumedAt = shared.consumed[primary.tabId];
      if (consumedAt && Date.parse(consumedAt) >= Date.parse(primary.updatedAt)) {
        this.finishAdoption();
        return;
      }

      // 收集同一共同基线上、其他标签的离线本地稿
      const peers = Object.values(this.readDrafts()).filter(
        (item) => item.tabId !== primary.tabId && item.base && item.baseRev === primary.baseRev,
      );

      let accumulated: ProofDocument[] | null = null;
      const conflicts: MergeConflict[] = [];
      const reports: MergeReport[] = [];

      // 当前标签原始稿与每份伙伴稿（或前进后的合并稿）两两三向合并，
      // 再按文档/步骤 id 把结果聚合，避免把“已合并稿”当成普通稿产生伪冲突。
      const runPair = (other: DraftEnvelope, pairBase: ProofDocument[]) => {
        const result = mergeThreeWay(primary, other, pairBase);
        conflicts.push(...result.conflicts);
        reports.push(...result.reports);
        if (!accumulated) {
          accumulated = result.merged;
          return;
        }
        const combined = combineResults(accumulated, result.merged, base, other.tabName);
        accumulated = combined.docs;
        conflicts.push(...combined.conflicts);
      };

      if (peers.length) {
        peers.forEach((peer) => runPair(peer, base));
      } else if (shared.rev > primary.baseRev) {
        // 没有同基线伙伴，但合并稿已前进：与当前合并稿对合
        const sharedEnvelope: DraftEnvelope = {
          tabId: 'shared',
          tabName: '合并稿',
          updatedAt: new Date(shared.docs.reduce((max, doc) => Math.max(max, Date.parse(doc.updatedAt)), 0)).toISOString(),
          base: clone(base),
          baseRev: primary.baseRev,
          docs: clone(shared.docs),
        };
        runPair(sharedEnvelope, base);
      } else {
        accumulated = clone(primary.docs);
        reports.push(...base.map((doc) => ({
          docId: doc.id,
          title: primary.docs.find((item) => item.id === doc.id)?.title ?? doc.title,
          addedLocal: [],
          addedPeer: [],
          removed: [],
          restored: [],
          prunedReferences: [],
          notes: ['没有发现其他标签的改动，本地稿直接成为合并稿'],
        })));
      }

      const merged = accumulated as ProofDocument[];
      const consumedPeers = [primary.tabId, ...peers.map((peer) => peer.tabId)];

      // 聚合后统一清理一次悬空引用
      merged.forEach((doc) => {
        const liveIds = new Set(doc.steps.map((step) => step.id));
        doc.steps.forEach((step) => {
          step.references = step.references.filter((reference) => liveIds.has(reference));
        });
      });

      if (conflicts.length) {
        // 有待处理项：先落盘合并中间结果，老师逐项选择；期间编辑锁定
        const pending: PendingMerge = {
          sessionId: uid('merge'),
          ownerTabId: this.tabId,
          localTabName: primary.tabName,
          baseRev: primary.baseRev,
          createdAt: new Date().toISOString(),
          consumedPeers,
          merged,
          conflicts,
          reports,
        };
        this.pendingMerge = pending;
        this.documents = merged;
        writeJSON(PENDING_KEY, pending);
        this.offlineBase = null;
        this.ensureSelection();
        this.notify(`合并发现 ${conflicts.length} 处同步骤冲突，请逐项选择`);
      } else {
        this.commitMerge(merged, reports, conflicts.length, consumedPeers);
      }
    } finally {
      this.merging = false;
      if (!this.pendingMerge) localStorage.removeItem(LOCK_KEY);
    }
    redraw();
  }

  private commitMerge(
    merged: ProofDocument[],
    reports: MergeReport[],
    conflictCount: number,
    consumedPeers: string[],
  ): void {
    // 选定结果落地前，再清一遍悬空引用
    merged.forEach((doc) => {
      const liveIds = new Set(doc.steps.map((step) => step.id));
      doc.steps.forEach((step) => {
        step.references = step.references.filter((reference) => liveIds.has(reference));
      });
      doc.updatedAt = new Date().toISOString();
    });

    const shared = this.readShared();
    shared.rev += 1;
    shared.docs = clone(merged);
    consumedPeers.forEach((tabId) => {
      shared.consumed[tabId] = new Date().toISOString();
    });
    writeJSON(SHARED_KEY, shared);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(LOCK_KEY);

    this.rev = shared.rev;
    this.documents = merged;
    this.offlineBase = null;
    this.offlineBaseRev = 0;
    this.pendingMerge = null;
    this.undoStack = [];
    this.redoStack = [];
    this.writeOwnEnvelope(null, this.rev, this.documents);
    this.lastMerge = { at: new Date().toISOString(), reports, conflictCount };
    this.ensureSelection();
    this.notify('合并稿已生成：不同步骤的改动均已保留');
  }

  resolveConflict(conflictId: string, choice: 'local' | 'peer'): void {
    if (!this.pendingMerge || this.pendingMerge.ownerTabId !== this.tabId) return;
    const conflict = this.pendingMerge.conflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    conflict.choice = choice;
    writeJSON(PENDING_KEY, this.pendingMerge);
    writeJSON(LOCK_KEY, { tabId: this.tabId, ts: Date.now() }); // 选择期间续期合并锁
    redraw();
  }

  dismissLastMerge(): void {
    this.lastMerge = null;
    redraw();
  }

  finalizeMerge(): void {
    const pending = this.pendingMerge;
    if (!pending || pending.ownerTabId !== this.tabId) return;
    if (pending.conflicts.some((conflict) => conflict.choice === null)) {
      this.notify('还有待处理项未选择，暂时无法完成合并');
      return;
    }
    const merged = clone(pending.merged);
    merged.forEach((doc) => {
      pending.conflicts
        .filter((conflict) => conflict.docId === doc.id)
        .forEach((conflict) => {
          const step = doc.steps.find((item) => item.id === conflict.stepId);
          if (!step) return;
          const chosen = conflict.choice === 'local' ? conflict.localValue : conflict.peerValue;
          if (conflict.field === 'references') step.references = [...chosen];
          else if (conflict.field === 'rule') step.rule = chosen[0] ?? step.rule;
          else step.statement = chosen[0] ?? step.statement;
        });
    });
    this.commitMerge(merged, clone(pending.reports), pending.conflicts.length, pending.consumedPeers);
    redraw();
  }

  get conflictProgress(): { done: number; total: number } {
    const conflicts = this.pendingMerge?.conflicts ?? [];
    return { done: conflicts.filter((item) => item.choice !== null).length, total: conflicts.length };
  }

  get isMergeOwner(): boolean {
    return this.pendingMerge?.ownerTabId === this.tabId;
  }

  get sharedRev(): number {
    return this.online ? this.rev : this.offlineBaseRev;
  }

  private finishAdoption(): void {
    localStorage.removeItem(LOCK_KEY);
    this.adoptShared();
    this.writeOwnEnvelope(null, this.rev, this.documents);
    this.offlineBase = null;
    this.notify('本地稿已在另一标签完成合并，已采用合并稿');
  }

  private adoptShared(): void {
    const shared = this.readShared();
    this.rev = shared.rev;
    this.documents = shared.docs;
    this.offlineBase = null;
    this.offlineBaseRev = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.ensureSelection();
  }

  renameTab(): void {
    const name = window.prompt('给当前标签起个名字', this.tabName);
    if (!name || !name.trim()) return;
    this.tabName = name.trim();
    sessionStorage.setItem(TAB_KEY, JSON.stringify({ id: this.tabId, name: this.tabName }));
    const drafts = this.readDrafts();
    if (drafts[this.tabId]) {
      drafts[this.tabId].tabName = this.tabName;
      writeJSON(DRAFTS_KEY, drafts);
    }
    this.save();
    redraw();
  }

  private handleStorage(event: StorageEvent): void {
    if (event.key === OFFLINE_KEY) {
      this.offlineOverride = localStorage.getItem(OFFLINE_KEY) === 'true';
      this.refreshConnectionState();
      return;
    }
    if (event.key === PENDING_KEY) {
      const pending = readJSON<PendingMerge | null>(PENDING_KEY, null);
      if (!pending) {
        if (this.online) {
          this.pendingMerge = null;
          this.adoptShared();
        }
      } else if (this.online && (!this.pendingMerge || this.pendingMerge.sessionId !== pending.sessionId)) {
        this.pendingMerge = pending;
        this.documents = pending.merged;
        this.ensureSelection();
      } else if (this.pendingMerge) {
        // 发起方的选择实时同步给其他标签
        this.pendingMerge.conflicts = pending.conflicts;
      }
      redraw();
      return;
    }
    if (!this.online || this.pendingMerge) return;
    if (event.key === SHARED_KEY) {
      const shared = this.readShared();
      if (shared.rev > this.rev) this.adoptShared();
      redraw();
    } else if (event.key === DRAFTS_KEY) {
      redraw();
    }
  }

  selectDocument(id: string): void {
    this.activeId = id;
    this.compareVersionId = '';
    this.selectedStepId = this.current?.steps[0]?.id ?? '';
  }

  selectStep(id: string): void {
    this.selectedStepId = id;
  }

  ensureSelection(): void {
    if (!this.documents.some((item) => item.id === this.activeId)) this.activeId = this.documents[0]?.id ?? '';
    if (!this.current?.steps.some((step) => step.id === this.selectedStepId)) {
      this.selectedStepId = this.current?.steps[0]?.id ?? '';
    }
  }

  addDocument(): void {
    if (this.locked) return;
    const id = uid('doc');
    const document: ProofDocument = {
      id,
      title: '未命名证明',
      author: '本地用户',
      goal: '$A=B$',
      symbols: { A: '待定义对象', B: '待定义对象' },
      steps: [{ id: uid('step'), type: 'premise', statement: '在这里输入前提', rule: '前提', references: [], note: '', counterexample: '', alternative: '' }],
      versions: [],
      updatedAt: new Date().toISOString(),
    };
    this.undoStack.push(clone(this.documents));
    this.documents.unshift(document);
    this.activeId = id;
    this.selectedStepId = document.steps[0].id;
    this.save();
  }

  removeDocument(id: string): void {
    if (this.locked) return;
    if (this.documents.length <= 1) {
      this.notify('至少保留一个证明文档');
      return;
    }
    this.undoStack.push(clone(this.documents));
    this.documents = this.documents.filter((item) => item.id !== id);
    this.ensureSelection();
    this.save();
  }

  addStep(type: ProofStep['type'] = 'derivation'): void {
    const step: ProofStep = {
      id: uid('step'),
      type,
      statement: type === 'goal' ? '$A=B$' : '输入新的推导式',
      rule: type === 'goal' ? '结论' : '等式变形',
      references: this.selectedStepId ? [this.selectedStepId] : [],
      note: '',
      counterexample: '',
      alternative: '',
    };
    this.update((document) => {
      const selectedIndex = document.steps.findIndex((item) => item.id === this.selectedStepId);
      document.steps.splice(type === 'goal' ? document.steps.length : selectedIndex + 1, 0, step);
    });
    this.selectedStepId = step.id;
  }

  removeStep(id: string): void {
    this.update((document) => {
      document.steps = document.steps.filter((step) => step.id !== id);
      document.steps.forEach((step) => {
        // 拿掉步骤后，引用不能指向已经消失的步骤
        step.references = step.references.filter((reference) => reference !== id);
      });
    });
    this.ensureSelection();
  }

  moveStep(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.update((document) => {
      const from = document.steps.findIndex((step) => step.id === sourceId);
      const to = document.steps.findIndex((step) => step.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = document.steps.splice(from, 1);
      document.steps.splice(to, 0, moved);
    });
  }

  updateStep(patch: Partial<ProofStep>): void {
    const id = this.selectedStepId;
    this.update((document) => {
      const step = document.steps.find((item) => item.id === id);
      if (step) Object.assign(step, patch);
    });
  }

  createVersion(): void {
    if (this.locked) {
      this.notify('有待处理冲突，合并完成后才能保存版本快照');
      return;
    }
    this.update((document) => {
      const version: ProofVersion = {
        id: uid('version'),
        name: `版本 ${document.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        steps: clone(document.steps),
        goal: document.goal,
      };
      document.versions.unshift(version);
      this.compareVersionId = version.id;
    });
    this.notify('已基于合并稿保存当前证明快照');
  }

  notify(message: string): void {
    this.toast = message;
    window.setTimeout(() => {
      if (this.toast === message) {
        this.toast = '';
        redraw();
      }
    }, 2600);
  }
}

function stripLatexCommands(text: string): string {
  return text.replace(/\\[A-Za-z]+/g, ' ').replace(/[{}_^]/g, ' ');
}

/** 把多组两两合并的结果按文档/步骤 id 聚合；步骤存在于任一份即保留 */
function combineResults(
  previous: ProofDocument[],
  incoming: ProofDocument[],
  base: ProofDocument[],
  incomingTabName: string,
): { docs: ProofDocument[]; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const docs: ProofDocument[] = [];
  const allIds = new Set([...previous.map((doc) => doc.id), ...incoming.map((doc) => doc.id)]);

  allIds.forEach((docId) => {
    const a = previous.find((doc) => doc.id === docId);
    const b = incoming.find((doc) => doc.id === docId);
    const baseDoc = base.find((doc) => doc.id === docId);
    if (!a || !b) {
      docs.push(structuredClone((a ?? b) as ProofDocument));
      return;
    }

    const merged: ProofDocument = structuredClone(a);
    merged.updatedAt = new Date().toISOString();
    // 元数据取非基线的一侧，两边都不同则沿用先合并进来的一侧
    if (baseDoc && a.title === baseDoc.title && b.title !== baseDoc.title) merged.title = b.title;
    if (baseDoc && a.author === baseDoc.author && b.author !== baseDoc.author) merged.author = b.author;
    if (baseDoc && a.goal === baseDoc.goal && b.goal !== baseDoc.goal) merged.goal = b.goal;
    merged.symbols = { ...a.symbols, ...b.symbols };

    // 步骤并集：以 a 的顺序为主，b 独有的追加
    const bSteps = new Map(b.steps.map((step) => [step.id, step]));
    const aIds = new Set(a.steps.map((step) => step.id));
    const ordered: ProofStep[] = [];
    a.steps.forEach((step) => {
      const counterpart = bSteps.get(step.id);
      if (!counterpart) {
        ordered.push(step);
        return;
      }
      const mergedStep = structuredClone(step);
      const baseStep = baseDoc?.steps.find((item) => item.id === step.id);
      (['statement', 'rule'] as const).forEach((field) => {
        const baseValue = baseStep?.[field] ?? '';
        const va = step[field];
        const vb = counterpart[field];
        if (va === vb) mergedStep[field] = va;
        else if (va === baseValue) mergedStep[field] = vb;
        else if (vb === baseValue) mergedStep[field] = va;
        else {
          mergedStep[field] = va;
          conflicts.push({
            id: `${docId}-${step.id}-${field}-${Math.random().toString(36).slice(2, 8)}`,
            docId,
            stepId: step.id,
            field,
            localTab: '已合并稿',
            peerTab: incomingTabName,
            baseValue: [baseValue],
            localValue: [va],
            peerValue: [vb],
            choice: null,
          });
        }
      });
      const sameRefs = (x: string[], y: string[]) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
      const baseRefs = baseStep?.references ?? [];
      if (sameRefs(step.references, counterpart.references)) {
        mergedStep.references = [...step.references];
      } else if (sameRefs(baseRefs, step.references)) {
        mergedStep.references = [...counterpart.references];
      } else if (sameRefs(baseRefs, counterpart.references)) {
        mergedStep.references = [...step.references];
      } else {
        mergedStep.references = [...step.references];
        conflicts.push({
          id: `${docId}-${step.id}-references-${Math.random().toString(36).slice(2, 8)}`,
          docId,
          stepId: step.id,
          field: 'references',
          localTab: '已合并稿',
          peerTab: incomingTabName,
          baseValue: [...baseRefs],
          localValue: [...step.references],
          peerValue: [...counterpart.references],
          choice: null,
        });
      }
      (['note', 'counterexample', 'alternative'] as const).forEach((field) => {
        const baseValue = baseStep?.[field] ?? '';
        const va = step[field];
        const vb = counterpart[field];
        if (va === vb) return;
        if (va === baseValue) mergedStep[field] = vb;
        else if (vb === baseValue) mergedStep[field] = va;
        else if (va && vb && !va.includes(vb) && !vb.includes(va)) {
          mergedStep[field] = `${va}\n（${incomingTabName}）${vb}`;
        } else {
          mergedStep[field] = va || vb;
        }
      });
      ordered.push(mergedStep);
    });
    b.steps.forEach((step) => {
      if (!aIds.has(step.id)) ordered.push(step);
    });
    merged.steps = ordered;

    // 版本快照并集
    const versions = new Map<string, ProofVersion>();
    [...a.versions, ...b.versions].forEach((version) => {
      if (!versions.has(version.id)) versions.set(version.id, version);
    });
    merged.versions = [...versions.values()].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
    docs.push(merged);
  });

  return { docs, conflicts };
}

export function validate(document: ProofDocument): ProofCheck[] {
  const checks: ProofCheck[] = [];
  const ids = new Set(document.steps.map((step) => step.id));
  const symbolKeys = new Set(Object.keys(document.symbols));
  const ignored = new Set(['a', 'A', 'b', 'B', 'n', 'k', 'P', 'Q', 'R', 'x', 'y', 'to', 'text', 'frac', 'sqrt']);

  document.steps.forEach((step, index) => {
    const tokens = stripLatexCommands(step.statement).match(/\b[A-Za-z][A-Za-z0-9']*\b/g) ?? [];
    const unknown = [...new Set(tokens.filter((token) => !symbolKeys.has(token) && !ignored.has(token)))];
    if (unknown.length) {
      checks.push({ id: `symbol-${step.id}`, severity: 'warning', title: '发现未定义符号', detail: `步骤 ${index + 1} 使用了：${unknown.join('、')}`, stepId: step.id });
    }

    step.references.forEach((reference) => {
      if (!ids.has(reference)) {
        checks.push({ id: `missing-${step.id}-${reference}`, severity: 'error', title: '引用步骤不存在', detail: `步骤 ${index + 1} 引用了已删除的步骤 ${reference}`, stepId: step.id });
      }
    });
  });

  const graph = new Map(document.steps.map((step) => [step.id, step.references.filter((id) => ids.has(id))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleStep = new Set<string>();
  const visit = (id: string, path: string[]): boolean => {
    if (visiting.has(id)) {
      path.slice(path.indexOf(id)).forEach((item) => cycleStep.add(item));
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    const hasCycle = (graph.get(id) ?? []).some((next) => visit(next, [...path, id]));
    visiting.delete(id);
    visited.add(id);
    return hasCycle;
  };
  [...graph.keys()].forEach((id) => visit(id, []));
  if (cycleStep.size) {
    checks.push({ id: 'cycle', severity: 'error', title: '检测到循环引用', detail: '引用链形成闭环，请调整步骤关系。', stepId: [...cycleStep][0] });
  }

  const goalStep = document.steps.find((step) => step.type === 'goal' && step.rule === '结论');
  if (!goalStep) {
    checks.push({ id: 'goal-missing', severity: 'error', title: '目标未被证明', detail: '请添加“结论”类型的最终步骤。' });
  } else if (goalStep.references.length === 0) {
    checks.push({ id: 'goal-unlinked', severity: 'warning', title: '结论尚无推导支撑', detail: '最终步骤没有引用任何前置步骤。', stepId: goalStep.id });
  }

  if (!checks.some((check) => check.severity === 'error')) {
    checks.push({ id: 'proof-ok', severity: 'info', title: '结构检查通过', detail: '未发现缺失引用、循环引用或未证明目标。' });
  }
  return checks;
}

export function compareVersion(document: ProofDocument, version: ProofVersion) {
  const result = [];
  const size = Math.max(document.steps.length, version.steps.length);
  for (let index = 0; index < size; index += 1) {
    const before = version.steps[index]?.statement ?? '';
    const after = document.steps[index]?.statement ?? '';
    const kind = !before ? 'added' : !after ? 'removed' : before === after ? 'same' : 'changed';
    result.push({ kind, label: `步骤 ${index + 1}`, before, after } as const);
  }
  return result;
}

export function createId(prefix: string): string {
  return uid(prefix);
}

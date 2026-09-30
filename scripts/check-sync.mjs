// 多标签 SyncHub 传输层模拟：验证断网各自保存、重连合并、冲突决议、等待者接收
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({ entryPoints: ['src/sync.ts'], bundle: true, format: 'esm', write: false, platform: 'node' });
writeFileSync('/tmp/sync.bundle.mjs', result.outputFiles[0].text);
const { SyncHub, DRAFT_PREFIX, BASE_KEY, SESSION_PREFIX } = await import('file:///tmp/sync.bundle.mjs');

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

class MemoryChannel {
  static channels = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    MemoryChannel.channels.push(this);
  }
  addEventListener(_event, fn) { this.listeners.push(fn); }
  postMessage(message) {
    for (const channel of MemoryChannel.channels) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => channel.listeners.forEach((fn) => fn({ data: structuredClone(message) })));
    }
  }
  close() { MemoryChannel.channels = MemoryChannel.channels.filter((c) => c !== this); }
}

let passed = 0;
let failed = 0;
const assert = (condition, message) => {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
};

function createTab(storage, seedDocuments, sink, timing = {}) {
  const sessionStorage = new MemoryStorage();
  const win = { addEventListener() {}, removeEventListener() {} };
  return new SyncHub(sink, seedDocuments, {
    localStorage: storage,
    sessionStorage,
    window: win,
    navigator: { onLine: true },
    BroadcastChannel: MemoryChannel,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    reconnectGrace: 200,
    sessionTtl: 600,
    ...timing,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const waitForRemote = () => new Promise((resolve) => setTimeout(resolve, 320));
const waitForGrace = () => new Promise((resolve) => setTimeout(resolve, 500));

const sampleDocuments = () => [{
  id: 'doc-sample',
  title: '样例证明',
  author: '老师',
  goal: '$A=B$',
  symbols: { a: '实数', b: '实数' },
  updatedAt: new Date().toISOString(),
  versions: [],
  steps: [
    { id: 's1', type: 'premise', statement: '$a,b$ 是实数', rule: '前提', references: [], note: '', counterexample: '', alternative: '' },
    { id: 's2', type: 'derivation', statement: '$(a+b)^2=(a+b)(a+b)$', rule: '定义展开', references: ['s1'], note: '', counterexample: '', alternative: '' },
    { id: 's3', type: 'goal', statement: '$(a+b)^2=a^2+2ab+b^2$', rule: '结论', references: ['s2'], note: '', counterexample: '', alternative: '' },
  ],
}];

console.log('传输层：两标签断网 → 各自保存 → 重连合并');
const storage = new MemoryStorage();
let remoteA = null;
let remoteB = null;
const hubA = createTab(storage, sampleDocuments, { onRemoteDocuments: (docs) => { remoteA = docs; }, onSyncStateChange() {} });
const hubB = createTab(storage, sampleDocuments, { onRemoteDocuments: (docs) => { remoteB = docs; }, onSyncStateChange() {} });
assert(hubA.label !== hubB.label, `两标签各自编号（${hubA.label} / ${hubB.label}）`);

const readBase = () => JSON.parse(storage.getItem(BASE_KEY));
const seedDocs = () => structuredClone(readBase().documents);

// 两标签同时断网
hubA.setSimulatedOnline(false);
hubB.setSimulatedOnline(false);
assert(hubA.mode === 'offline' && hubB.mode === 'offline', '两边都进入离线本地稿模式');

// A：改 s1、新增步骤
const docsA = seedDocs();
docsA[0].steps[0].statement = '$a,b$ 是实数（A 改前提）';
docsA[0].steps.push({ id: 'new-by-A', type: 'derivation', statement: 'A 离线新增步骤', rule: '构造法', references: [], note: '', counterexample: '', alternative: '' });
hubA.localChanged(docsA);

// B：改 s2 的结论（与基线不同；A 没动 s2 → 单边修改直接采纳），再改 s1 结论与 A 冲突
const docsB = seedDocs();
docsB[0].steps[1].statement = '$(a+b)^2=(a+b)(a+b)$（B 改 s2）';
docsB[0].steps[1].rule = '等式变形';
docsB[0].steps[0].statement = '$a,b$ 是实数（B 改前提）';
hubB.localChanged(docsB);

const baseAfterOffline = readBase();
assert(!baseAfterOffline.documents[0].steps.some((s) => s.statement.includes('A 改') || s.statement.includes('B 改')), '离线编辑没有覆盖共享基线');
assert(storage.getItem(DRAFT_PREFIX + hubA.sessionId) && storage.getItem(DRAFT_PREFIX + hubB.sessionId), '两份本地稿分别保存');

// 两标签几乎同时恢复联网：先恢复者进入宽限等待，检测到另一方上线后立即合并
hubA.setSimulatedOnline(true);
await flush();
assert(hubA.mode === 'waiting', `先恢复的 ${hubA.label} 进入宽限等待`);
hubB.setSimulatedOnline(true);
await waitForGrace();

const [winner, loser] = hubA.sessionId > hubB.sessionId ? [hubA, hubB] : [hubB, hubA];
assert(winner.mode === 'merging', `${winner.label}（会话 id 更大）被选举负责合并，进入待处理项面板`);
assert(loser.mode === 'waiting', `${loser.label} 保持等待（合并锁生效）`);

const pending = winner.pending;
assert(pending !== null, '生成合并报告');
assert(pending.conflicts.length === 1 && pending.conflicts[0].field === 'statement', '只有 s1 结论的真正冲突（s2 单边改不冲突）');
assert(pending.conflicts[0].options.map((o) => o.side).includes(hubA.label) && pending.conflicts[0].options.map((o) => o.side).includes(hubB.label), '冲突项标明两边标签身份');

// 未处理完不能确认
winner.confirmMerge();
assert(winner.mode === 'merging', '老师选定前无法生成合并稿');

// 自动合并部分已经在报告里：不同步骤的改动都在
const reportDoc = pending.documents[0];
assert(reportDoc.steps.some((s) => s.id === 'new-by-A'), 'A 新增步骤已在合并稿中');
assert(reportDoc.steps.find((s) => s.id === 's2').rule === '等式变形', 'B 单边修改的推理规则自动采纳');
assert(reportDoc.steps.find((s) => s.id === 's2').statement.includes('B 改 s2'), 'B 对 s2 结论的单边修改自动采纳');

// 老师选择 B 的 s1 结论并确认
const chooseB = pending.conflicts[0].options.findIndex((o) => o.side === hubB.label);
winner.resolveConflict(pending.conflicts[0].id, chooseB);
winner.confirmMerge();
assert(winner.mode === 'online', '确认后合并标签回到在线状态');

const finalBase = readBase();
const doc = finalBase.documents[0];
assert(doc.steps.find((s) => s.id === 's1').statement.includes('B 改前提'), '老师选定的 B 版前提进入合并稿');
assert(doc.steps.some((s) => s.id === 'new-by-A'), 'A 的新步骤仍保留（不同步骤改动都留下）');

// 等待标签通过 commit 消息拉取合并稿
await waitForRemote();
const waiterDocs = loser === hubA ? remoteA : remoteB;
assert(waiterDocs && waiterDocs[0].steps.some((s) => s.id === 'new-by-A'), '等待标签编辑区自动载入合并稿（含另一边的新步骤）');

// 合并后各标签本地稿都基于合并稿
const drafts = [];
for (let i = 0; i < storage.length; i += 1) {
  const key = storage.key(i);
  if (key.startsWith(DRAFT_PREFIX)) drafts.push(JSON.parse(storage.getItem(key)));
}
assert(drafts.every((d) => d.documents[0].steps.some((s) => s.id === 'new-by-A')), '合并后各标签本地稿都已对齐合并稿');

// ---- 场景：A 先恢复并继续在线编辑（产生快进提交），B 一直离线，之后才恢复 ----
console.log('\n传输层：A 先恢复并快进，B 后恢复变基');
const storage2 = new MemoryStorage();
let r2a = null, r2b = null;
const C2 = createTab(storage2, sampleDocuments, { onRemoteDocuments: (d) => { r2a = d; }, onSyncStateChange() {} });
const D2 = createTab(storage2, sampleDocuments, { onRemoteDocuments: (d) => { r2b = d; }, onSyncStateChange() {} });
C2.setSimulatedOnline(false);
D2.setSimulatedOnline(false);

// C 离线改 s1；D 离线改 s2（之后 D 先恢复并在线又改一次，形成快进）
const cOffline = structuredClone(JSON.parse(storage2.getItem(BASE_KEY)).documents);
cOffline[0].steps[0].statement = '$a,b$ 是实数（C 离线 s1）';
C2.localChanged(cOffline);
const dOffline = structuredClone(JSON.parse(storage2.getItem(BASE_KEY)).documents);
dOffline[0].steps[1].statement = '$(a+b)^2=(a+b)(a+b)$（D 离线 s2）';
D2.localChanged(dOffline);

// D 先恢复：此时 C 仍离线 → D 等待约 9 秒会话超时成本过高，这里直接验证 pendingOffline 守卫：
// 宽限期结束后 D 不应快进覆盖；为模拟 C 一直不回来，手动让 C 会话保持离线。
D2.setSimulatedOnline(true);
await new Promise((r) => setTimeout(r, 350));
assert(D2.mode === 'waiting', '仍有离线标签持分歧稿时，先恢复者不快进、保持等待');

// C 恢复 → 双向合并（无冲突，因改不同步骤）
C2.setSimulatedOnline(true);
await new Promise((r) => setTimeout(r, 900));
const winner2 = C2.sessionId > D2.sessionId ? C2 : D2;
const loser2 = C2.sessionId > D2.sessionId ? D2 : C2;
assert(winner2.mode === 'online', '无冲突时负责合并的标签自动完成合并');
await waitForRemote();
const final2 = JSON.parse(storage2.getItem(BASE_KEY)).documents[0].steps;
assert(final2.find((s) => s.id === 's1').statement.includes('C 离线 s1'), 'C 离线的 s1 修改进入合并稿');
assert(final2.find((s) => s.id === 's2').statement.includes('D 离线 s2'), 'D 离线的 s2 修改进入合并稿');
void loser2; void r2a; void r2b;

// ---- 场景：一方在线提交 rev2，另一方离线基于 rev1 编辑后恢复（单边变基）----
console.log('\n传输层：在线快进提交后，离线者恢复并变基');
const storage3 = new MemoryStorage();
let r3offline = null;
const Online3 = createTab(storage3, sampleDocuments, { onRemoteDocuments() {}, onSyncStateChange() {} });
const Off3 = createTab(storage3, sampleDocuments, { onRemoteDocuments: (d) => { r3offline = d; }, onSyncStateChange() {} });
assert(Online3.mode === 'online' && Off3.mode === 'online', '初始两边在线');

// Off3 先断网；Online3 保持在线并提交 rev2（改 s2）——此时 Off3 草稿与 rev1 一致，不构成分歧
Off3.setSimulatedOnline(false);
const online3docs = structuredClone(JSON.parse(storage3.getItem(BASE_KEY)).documents);
online3docs[0].steps[1].statement = '$(a+b)^2=(a+b)(a+b)$（在线方 rev2 改 s2）';
Online3.localChanged(online3docs);
await flush();
assert(JSON.parse(storage3.getItem(BASE_KEY)).revision === 2, '在线方编辑快进提交为 rev2');

// Off3 离线期间基于 rev1 改 s1
const f3 = structuredClone(Online3.base.documents); // 仅取结构；下面用 Off3 自己的旧基线内容
void f3;
const off3base = structuredClone(JSON.parse(storage3.getItem(BASE_KEY)).documents);
// Off3 看到的仍是 rev1：把 s2 还原成 rev1 内容，再改 s1
off3base[0].steps[1].statement = '$(a+b)^2=(a+b)(a+b)$';
off3base[0].steps[0].statement = '$a,b$ 是实数（离线者 s1）';
Off3.localChanged(off3base);

// Off3 恢复：唯一分歧稿，变基到 rev2
Off3.setSimulatedOnline(true);
await waitForGrace();
await waitForRemote();
const final3 = JSON.parse(storage3.getItem(BASE_KEY)).documents[0].steps;
assert(final3.find((s) => s.id === 's1').statement.includes('离线者 s1'), '离线者对 s1 的改动叠加成功');
assert(final3.find((s) => s.id === 's2').statement.includes('在线方 rev2 改 s2'), '在线方 rev2 的 s2 未被离线者旧基线覆盖（变基成功）');
assert(Off3.mode === 'online', '离线者变基完成后回到在线');
void r3offline;

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);

// 纯合并逻辑核对脚本：node --experimental-strip-types 不适用的版本，用 esbuild 打包后运行
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/sync.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
});
writeFileSync('/tmp/sync.bundle.mjs', result.outputFiles[0].text);

const { mergeProofWorkspaces, resolveMergeReport, sanitizeReferences } = await import('file:///tmp/sync.bundle.mjs');

const makeDoc = () => ({
  id: 'd1',
  title: '证明一',
  author: '老师',
  goal: '$A=B$',
  symbols: { A: '对象A' },
  updatedAt: '2026-09-30T10:00:00.000Z',
  versions: [],
  steps: [
    { id: 's1', type: 'premise', statement: '$x>0$', rule: '前提', references: [], note: '', counterexample: '', alternative: '' },
    { id: 's2', type: 'derivation', statement: '$x+1>1$', rule: '代入', references: ['s1'], note: '', counterexample: '', alternative: '' },
    { id: 's3', type: 'goal', statement: '$A=B$', rule: '结论', references: ['s2'], note: '', counterexample: '', alternative: '' },
  ],
});

let passed = 0;
let failed = 0;
const assert = (condition, message) => {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
};

// 场景 1：不同步骤各自修改，全部保留、无冲突
{
  console.log('场景 1：两边改不同步骤 / 新增不同步骤');
  const base = makeDoc();
  const a = makeDoc();
  const b = makeDoc();
  a.steps[1].statement = '$x+1>1\\ (A改)$';
  b.steps[0].statement = '$x>0\\ (B改)$';
  a.steps.push({ id: 's4', type: 'derivation', statement: 'A 新增步骤', rule: '构造法', references: ['s3'], note: '', counterexample: '', alternative: '' });
  b.steps.push({ id: 's5', type: 'derivation', statement: 'B 新增步骤', rule: '代入', references: ['s3'], note: '', counterexample: '', alternative: '' });
  const report = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  const ids = report.documents[0].steps.map((s) => s.id);
  assert(report.conflicts.length === 0, '没有待处理项');
  assert(ids.includes('s4') && ids.includes('s5'), '两边新增的步骤都保留');
  const merged = report.documents[0].steps;
  assert(merged.find((s) => s.id === 's2').statement.includes('A改'), 'A 对 s2 的修改保留');
  assert(merged.find((s) => s.id === 's1').statement.includes('B改'), 'B 对 s1 的修改保留');
}

// 场景 2：同一步骤 结论/规则/依据 两边不一致 → 阻塞冲突
{
  console.log('场景 2：同一步骤结论、规则、依据两边不一致');
  const base = makeDoc();
  const a = makeDoc();
  const b = makeDoc();
  a.steps[1].statement = 'A 的结论';
  b.steps[1].statement = 'B 的结论';
  a.steps[1].rule = '等式变形';
  b.steps[1].rule = '构造法';
  a.steps[2].references = ['s1'];
  b.steps[2].references = ['s1', 's2'];
  const report = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  const fields = report.conflicts.map((c) => c.field);
  assert(fields.includes('statement'), '结论不一致列入待处理项');
  assert(fields.includes('rule'), '推理规则不一致列入待处理项');
  assert(fields.includes('references'), '依据不一致列入待处理项');
  assert(report.conflicts.every((c) => c.options.length === 2 && c.options[0].side === '标签甲'), '每项都给出两边选项');
}

// 场景 3：一边只改了规则，另一边没动 → 直接采用改动，无冲突
{
  console.log('场景 3：单边修改直接采纳');
  const base = makeDoc();
  const a = makeDoc();
  const b = makeDoc();
  a.steps[1].rule = '构造法';
  a.steps[1].note = 'A 的旁注';
  const report = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  assert(report.conflicts.length === 0, '无冲突');
  const s2 = report.documents[0].steps.find((s) => s.id === 's2');
  assert(s2.rule === '构造法', '规则采用 A 的修改');
  assert(s2.note === 'A 的旁注', '旁注采用 A 的修改');
}

// 场景 4：拿掉步骤后引用自动清理；删除 vs 修改 → 待处理项
{
  console.log('场景 4：删除步骤与引用清理');
  const base = makeDoc();

  // 4a：两边一致删除 s2，s3 原本引用 s2 → 引用被移除
  const a = makeDoc();
  const b = makeDoc();
  a.steps = a.steps.filter((s) => s.id !== 's2');
  b.steps = b.steps.filter((s) => s.id !== 's2');
  const report = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  assert(report.conflicts.length === 0, '一致删除不产生冲突');
  const s3 = report.documents[0].steps.find((s) => s.id === 's3');
  assert(!s3.references.includes('s2'), '已删除步骤 s2 的引用被自动移除');

  // 4b：A 删除 s2，B 修改 s2 → step-existence 冲突，老师选定前步骤暂留
  const a2 = makeDoc();
  const b2 = makeDoc();
  a2.steps = a2.steps.filter((s) => s.id !== 's2');
  b2.steps[1].statement = 'B 对 s2 的修改';
  const report2 = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a2], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b2], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  assert(report2.conflicts.some((c) => c.kind === 'step-existence' && c.stepId === 's2'), '删除 vs 修改列入待处理项');

  // 选“删除”
  for (const conflict of report2.conflicts) conflict.chosen = conflict.options.length - 1;
  const resolved = resolveMergeReport(report2);
  const steps = resolved[0].steps;
  assert(!steps.some((s) => s.id === 's2'), '老师选删除后步骤消失');
  assert(!steps.find((s) => s.id === 's3').references.includes('s2'), '删除后引用也不指向消失步骤');

  // 选“保留 B 的修改”
  const report3 = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a2], savedAt: '2026-09-30T11:00:00.000Z' },
    { label: '标签乙', documents: [b2], savedAt: '2026-09-30T11:01:00.000Z' },
  ]);
  for (const conflict of report3.conflicts) conflict.chosen = 0;
  const kept = resolveMergeReport(report3)[0].steps;
  assert(kept.find((s) => s.id === 's2')?.statement === 'B 对 s2 的修改', '老师选保留后采用 B 的修改');
}

// 场景 5：只有一份分歧稿（单标签断网改动）→ 快进，内容原样保留
{
  console.log('场景 5：单标签离线后恢复');
  const base = makeDoc();
  const a = makeDoc();
  a.steps.push({ id: 's6', type: 'derivation', statement: '离线新增', rule: '代入', references: [], note: '', counterexample: '', alternative: '' });
  const report = mergeProofWorkspaces([base], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:00:00.000Z' },
  ]);
  assert(report.conflicts.length === 0, '单标签无冲突');
  assert(report.documents[0].steps.some((s) => s.id === 's6'), '离线新增步骤保留');
}

// 场景 6：快照内容本身带失效引用时，sanitizeReferences 也会清理
{
  console.log('场景 6：直接清理失效引用工具');
  const doc = makeDoc();
  doc.steps[2].references.push('ghost');
  const cleaned = sanitizeReferences([doc]);
  assert(!cleaned[0].steps[2].references.includes('ghost'), '幽灵引用被清除');
}

// 场景 7：跨越快进提交 —— A 先恢复并基于 rev2 改了 s2；B 一直离线基于 rev1，改 s1
// 共同祖先应取 rev2，这样 A 对 s2 的快进修改不会被当成祖先而覆盖。
{
  console.log('场景 7：跨越快进提交的三方合并');
  const rev1 = makeDoc();
  const rev2 = makeDoc();
  rev2.steps[1].statement = '$x+1>1$（A 在 rev2 快进改的 s2）';
  const history = [{ revision: 1, documents: [rev1] }, { revision: 2, documents: [rev2] }];
  const currentBase = rev2;

  // B 断网期间一直停留在 rev1，本地稿只改 s1
  const b = makeDoc();
  b.steps[0].statement = '$x>0$（B 离线改的 s1）';

  // A 此刻在线、稿面就是 rev2（无新增分歧），分歧只来自 B
  const report = mergeProofWorkspaces([currentBase], [
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T12:00:00.000Z', baseRevision: 1 },
  ], history);
  assert(report.conflicts.length === 0, '无待处理项');
  const merged = report.documents[0].steps;
  assert(merged.find((s) => s.id === 's1').statement.includes('B 离线改的 s1'), 'B 离线对 s1 的修改保留');
  assert(merged.find((s) => s.id === 's2').statement.includes('A 在 rev2 快进改'), 'A 在 rev2 对 s2 的快进修改也保留（未被错误覆盖）');
}

// 场景 8：跨越快进提交且两边改同一步骤同一字段 → 仍应产生冲突
{
  console.log('场景 8：跨快进的同字段冲突');
  const rev1 = makeDoc();
  const rev2 = makeDoc();
  rev2.steps[1].statement = 'A 的 s2 结论（rev2）';
  const history = [{ revision: 1, documents: [rev1] }, { revision: 2, documents: [rev2] }];
  // A 在线稿停在 rev2（baseRevision=2），B 离线稿停在 rev1 并改了 s2（baseRevision=1）
  const a = makeDoc();
  a.steps[1].statement = 'A 的 s2 结论（rev2）';
  const b = makeDoc();
  b.steps[1].statement = 'B 离线的 s2 结论';
  const report = mergeProofWorkspaces([rev2], [
    { label: '标签甲', documents: [a], savedAt: '2026-09-30T11:30:00.000Z', baseRevision: 2 },
    { label: '标签乙', documents: [b], savedAt: '2026-09-30T12:00:00.000Z', baseRevision: 1 },
  ], history);
  assert(report.conflicts.some((c) => c.field === 'statement' && c.stepId === 's2'), '跨基线的同字段不一致仍列入待处理项');
  const opts = report.conflicts.find((c) => c.stepId === 's2').options.map((o) => o.text);
  assert(opts.includes('A 的 s2 结论（rev2）') && opts.includes('B 离线的 s2 结论'), '冲突两边取值正确');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);

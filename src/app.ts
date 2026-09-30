import m, { type Component } from 'mithril';
import katex from 'katex';
import { compareVersion, ProofStore, RULES } from './store';
import { conflictFieldLabel, type DraftEnvelope } from './merge';
import type { MergeConflict, ProofDocument, ProofStep } from './types';

const store = new ProofStore();

const snippets = [
  { label: '∀', value: '\\forall ' },
  { label: '∃', value: '\\exists ' },
  { label: '→', value: '\\to ' },
  { label: '⇔', value: '\\iff ' },
  { label: '≠', value: '\\ne ' },
  { label: '≤', value: '\\le ' },
  { label: '≥', value: '\\ge ' },
  { label: '∈', value: '\\in ' },
  { label: '∑', value: '\\sum_{i=1}^{n} ' },
  { label: '√', value: '\\sqrt{}' },
  { label: '分式', value: '\\frac{}{}' },
  { label: '上标', value: '^{}' },
  { label: '下标', value: '_{}' },
];

const typeLabel: Record<ProofStep['type'], string> = {
  premise: '前提',
  derivation: '推导',
  goal: '目标 / 结论',
};

function renderRichText(text: string): m.Children {
  const parts = text.split(/(\$[^$]+\$)/g);
  return parts.map((part) => {
    if (part.startsWith('$') && part.endsWith('$') && part.length > 2) {
      try {
        return m.trust(katex.renderToString(part.slice(1, -1), { throwOnError: false, output: 'html' }));
      } catch {
        return part;
      }
    }
    return part;
  });
}

function shortId(id: string): string {
  return id.replace(/^step-/, '').slice(-4).toUpperCase();
}

function download(name: string, content: string, mime: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: mime }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportMarkdown(document: ProofDocument): string {
  const lines = [`# ${document.title}`, '', `**证明目标：** $${document.goal}$`, ''];
  document.steps.forEach((step, index) => {
    const refs = step.references.map((id) => `步骤 ${document.steps.findIndex((item) => item.id === id) + 1}`).filter((ref) => ref !== '步骤 0');
    lines.push(`## ${index + 1}. ${step.statement}`);
    lines.push('');
    lines.push(`- 类型：${typeLabel[step.type]}`);
    lines.push(`- 推理规则：${step.rule}`);
    if (refs.length) lines.push(`- 依据：${refs.join('、')}`);
    if (step.note) lines.push(`- 旁注：${step.note}`);
    if (step.counterexample) lines.push(`- 反例：${step.counterexample}`);
    if (step.alternative) lines.push(`- 替代分支：${step.alternative}`);
    lines.push('');
  });
  lines.push('## 符号表');
  Object.entries(document.symbols).forEach(([symbol, meaning]) => lines.push(`- $${symbol}$：${meaning}`));
  return lines.join('\n');
}

function exportLatex(document: ProofDocument): string {
  const lines = ['\\documentclass{article}', '\\usepackage{amsmath,amssymb}', '\\begin{document}', `\\section*{${document.title}}`, `\\textbf{证明目标：} $${document.goal}$`, '\\begin{enumerate}'];
  document.steps.forEach((step) => {
    const refs = step.references.map((id) => document.steps.findIndex((item) => item.id === id) + 1).filter(Boolean);
    const support = refs.length ? `（依据 ${refs.join(', ')}；${step.rule}）` : `（${step.rule}）`;
    lines.push(`  \\item ${step.statement} ${support}`);
    if (step.note) lines.push(`  \\par\\small 旁注：${step.note}`);
  });
  lines.push('\\end{enumerate}', '\\end{document}');
  return lines.join('\n');
}

function refIdsToText(document: ProofDocument | undefined, ids: string[]): string {
  if (!ids.length) return '（无依据）';
  return ids
    .map((id) => {
      const index = document?.steps.findIndex((item) => item.id === id) ?? -1;
      return index >= 0 ? `步骤 ${index + 1}` : `已删除步骤 #${id.replace(/^step-/, '').slice(-4).toUpperCase()}`;
    })
    .join('、');
}

function formatConflictValue(conflict: MergeConflict, side: 'base' | 'local' | 'peer', mergedDoc?: ProofDocument): string {
  if (conflict.field === 'references') {
    return refIdsToText(mergedDoc, conflict[`${side}Value`]);
  }
  return conflict[`${side}Value`][0] ?? '';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function mergePanel(): m.Children {
  const drafts = store.drafts();
  return m('section.panel.merge-panel', [
    m('div.panel-heading', [
      m('span', '本地稿与合并'),
      m('button.icon-button', { onclick: () => store.renameTab(), title: '重命名当前标签' }, '✎'),
    ]),
    m('div.connection-row', [
      m('span.conn-dot', { class: store.online ? 'is-ok' : 'is-off', title: store.online ? '已连接共享合并稿' : '离线：改动只在本标签本地稿中' }),
      m('span.conn-label', store.online ? '已连接' : '已断网（仅本地稿）'),
      m('button.button.is-small', {
        class: store.online ? 'is-danger is-light' : 'is-success is-light',
        disabled: store.locked,
        onclick: () => store.toggleConnection(),
      }, store.online ? '模拟断网' : '恢复连接并合并'),
    ]),
    m('div.tab-self', [
      m('span.tab-name', store.tabName),
      m('small', store.online ? `共享稿 rev ${store.sharedRev}` : `离线基线 rev ${store.sharedRev}`),
    ]),
    m('div.draft-list', [
      m('p.draft-list-title', `各标签本地稿（${drafts.length}）`),
      ...drafts.map((draft: DraftEnvelope) => m('div.draft-item', {
        class: draft.tabId === store.tabId ? 'is-self' : '',
      }, [
        m('span.draft-dot', { class: draft.base ? (draft.tabId === store.tabId ? 'is-off' : 'is-peer') : 'is-ok' }),
        m('span.draft-copy', [
          m('strong', draft.tabId === store.tabId ? `${draft.tabName}（本标签）` : draft.tabName),
          m('small', `${draft.base ? '离线稿' : '在线稿'} · ${formatTime(draft.updatedAt)}`),
        ]),
        draft.base && store.online && draft.tabId !== store.tabId && m('button.button.is-small.is-light', {
          title: '把这份离线稿按其冻结基线并入当前合并稿',
          onclick: () => store.manualMergeDraft(draft.tabId),
        }, '并入'),
      ])),
      drafts.length === 0 && m('p.empty-copy', '尚无其他标签的本地稿。'),
    ]),
    store.lastMerge && m('div.merge-summary', [
      m('div.merge-summary-head', [
        m('strong', `上次合并 ${formatTime(store.lastMerge.at)}`),
        m('button.icon-button', { onclick: () => store.dismissLastMerge() }, '×'),
      ]),
      ...store.lastMerge.reports.map((report) => m('div.merge-report-doc', [
        m('p.report-title', `《${report.title}》`),
        (report.addedLocal.length + report.addedPeer.length > 0) && m('small', `保留新增步骤 ${report.addedLocal.length + report.addedPeer.length} 个；删除生效 ${report.removed.length} 个`),
        report.restored.length > 0 && m('small.report-warn', `${report.restored.length} 个步骤一边删除一边修改，已保留修改稿`),
        report.prunedReferences.length > 0 && m('small.report-warn', `清理 ${report.prunedReferences.length} 处指向已消失步骤的引用`),
        ...report.notes.map((note) => m('small.report-note', note)),
      ])),
    ]),
  ]);
}

function conflictOverlay(): m.Children {
  const pending = store.pendingMerge;
  if (!pending) return null;
  const { done, total } = store.conflictProgress;
  const grouped = new Map<string, MergeConflict[]>();
  pending.conflicts.forEach((conflict) => {
    grouped.set(conflict.docId, [...(grouped.get(conflict.docId) ?? []), conflict]);
  });
  const owner = store.isMergeOwner;

  return m('div.conflict-overlay', [
    m('section.conflict-dialog', [
      m('header.conflict-head', [
        m('div', [
          m('span.eyebrow', 'MERGE REQUIRED'),
          m('h2', '同一步骤两边不一致 · 请逐项选择'),
          m('p.conflict-sub', owner
            ? `${pending.localTabName} 与另一标签的本地稿已按步骤合并，不同步骤的改动均已保留；以下 ${total} 项需要老师拍板。`
            : `合并由标签「${pending.localTabName}」发起，请在该标签完成选择，本标签只读查看。`),
        ]),
        m('span.conflict-progress', { class: done === total ? 'is-done' : '' }, `${done} / ${total}`),
      ]),
      m('div.conflict-groups', [...grouped.entries()].map(([docId, conflicts]) => {
        const doc = pending.merged.find((item) => item.id === docId);
        return m('div.conflict-group', [
          m('h3', `《${doc?.title ?? docId}》 · ${conflicts.length} 项`),
          ...conflicts.map((conflict) => {
            const stepIndex = doc?.steps.findIndex((step) => step.id === conflict.stepId) ?? -1;
            const stepLabel = stepIndex >= 0 ? `步骤 ${stepIndex + 1}` : `#${conflict.stepId}`;
            const cardClass = `conflict-card choice-${conflict.choice ?? 'none'}`;
            const option = (side: 'local' | 'peer') => m('button.conflict-option', {
              class: conflict.choice === side ? 'is-chosen' : '',
              disabled: !owner,
              onclick: () => store.resolveConflict(conflict.id, side),
            }, [
              m('span.option-side', side === 'local' ? conflict.localTab : conflict.peerTab),
              m('span.option-field', `${conflictFieldLabel(conflict.field)}：`),
              m('span.option-value', formatConflictValue(conflict, side, doc)),
            ]);
            return m('div', { class: cardClass }, [
              m('div.conflict-card-head', [
                m('strong', stepLabel),
                m('span.tag.is-warning', conflictFieldLabel(conflict.field)),
                m('small.conflict-base', `共同基线：${formatConflictValue(conflict, 'base', doc)}`),
              ]),
              m('div.conflict-options', [option('local'), option('peer')]),
            ]);
          }),
        ]);
      })),
      m('footer.conflict-foot', [
        m('p', done === total ? '所有待处理项已选定，可以生成合并稿。' : `还有 ${total - done} 项未选择，完成前不能继续编辑、存快照或导出。`),
        owner
          ? m('button.button.is-link', { disabled: done !== total, onclick: () => store.finalizeMerge() }, '选定完成，生成合并稿')
          : m('span', `等待「${pending.localTabName}」完成选择…`),
      ]),
    ]),
  ]);
}

export class ProofApp implements Component {
  private readonly onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const inEditor = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const command = event.ctrlKey || event.metaKey;
    const editingKeys = command && ['z', 'y', 's', 'enter'].includes(event.key.toLowerCase());
    const deleteKeys = (event.key === 'Delete' || event.key === 'Backspace') && !inEditor;
    if (store.locked && (editingKeys || deleteKeys)) {
      event.preventDefault();
      return;
    }
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
      m.redraw();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      m.redraw();
      return;
    }
    if (command && event.key === 'Enter') {
      event.preventDefault();
      store.addStep(event.shiftKey ? 'goal' : 'derivation');
      m.redraw();
      return;
    }
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      store.save();
      store.notify('已保存到浏览器');
      m.redraw();
      return;
    }
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !inEditor) {
      event.preventDefault();
      const steps = store.current.steps;
      const index = steps.findIndex((step) => step.id === store.selectedStepId);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, steps.length - 1) : Math.max(index - 1, 0);
      store.selectStep(steps[next]?.id ?? '');
      document.querySelector(`[data-step="${store.selectedStepId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      m.redraw();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !inEditor && store.selectedStepId) {
      event.preventDefault();
      store.removeStep(store.selectedStepId);
      m.redraw();
    }
  };

  oncreate(): void {
    window.addEventListener('keydown', this.onKeyDown);
  }

  onremove(): void {
    window.removeEventListener('keydown', this.onKeyDown);
  }

  view(): m.Children {
    const document = store.current;
    const selected = store.selectedStep;
    const checks = store.checks;
    const errors = checks.filter((check) => check.severity === 'error').length;
    const warnings = checks.filter((check) => check.severity === 'warning').length;
    const selectedVersion = document.versions.find((version) => version.id === store.compareVersionId);
    const diff = selectedVersion ? compareVersion(document, selectedVersion) : [];

    return m('div.app-shell', [
      m('header.topbar', [
        m('div.brand', [
          m('div.brand-mark', '∑'),
          m('div', [m('p.eyebrow', 'FORMAL NOTEBOOK'), m('h1', '格致 · 证明编辑器')]),
        ]),
        m('div.topbar-center', [
          m('span.status-dot', { class: errors ? 'has-error' : 'is-ok' }),
          errors ? `${errors} 个结构错误` : '证明结构可检查',
          m('span.topbar-separator'),
          m('span', { class: store.online ? '' : 'offline-chip', title: '改动保存在本标签本地稿中，恢复连接后合并' }, store.online ? '共享稿已连接' : '本地稿 · 离线中'),
          m('span.topbar-separator'),
          `自动保存于 ${new Date(document.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        ]),
        m('div.actions', [
          m('button.button.is-light', { onclick: () => { store.undo(); m.redraw(); }, disabled: !store.undoStack.length || store.locked, title: '撤销 Ctrl+Z' }, '↶ 撤销'),
          m('button.button.is-light', { onclick: () => { store.redo(); m.redraw(); }, disabled: !store.redoStack.length || store.locked, title: '重做 Ctrl+Y' }, '↷ 重做'),
          m('button.button.is-link', { onclick: () => { store.addStep('derivation'); m.redraw(); }, disabled: store.locked, title: '添加步骤 Ctrl+Enter' }, '+ 添加步骤'),
          store.pendingMerge && m('span.pending-chip', `${store.conflictProgress.total - store.conflictProgress.done} 项待处理`),
        ]),
      ]),
      m('main.workspace', [
        m('aside.left-rail', [
          m('section.panel.document-panel', [
            m('div.panel-heading', [m('span', '证明文档'), m('button.icon-button', { disabled: store.locked, onclick: () => { store.addDocument(); m.redraw(); }, title: '新建证明' }, '+')]),
            m('div.document-list', store.documents.map((item) => m('button.document-item', {
              class: item.id === document.id ? 'is-active' : '',
              disabled: store.locked,
              onclick: () => { store.selectDocument(item.id); m.redraw(); },
            }, [
              m('span.document-glyph', item.steps.length),
              m('span.document-copy', [m('strong', item.title), m('small', `${item.steps.length} 步 · ${item.author}`)]),
              m('span.chevron', '›'),
            ]))),
          ]),
          m('section.panel.version-panel', [
            m('div.panel-heading', [m('span', '版本快照'), m('span.count-badge', document.versions.length)]),
            document.versions.length === 0 && m('p.empty-copy', '保存快照后，可以并排查看改动。'),
            m('div.version-list', document.versions.map((version) => m('button.version-item', {
              class: version.id === store.compareVersionId ? 'is-active' : '',
              onclick: () => { store.compareVersionId = store.compareVersionId === version.id ? '' : version.id; m.redraw(); },
            }, [
              m('span', version.name),
              m('small', new Date(version.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
            ]))),
            m('button.button.is-fullwidth.is-small', { disabled: store.locked, title: store.locked ? '有待处理冲突，合并完成后才能保存版本快照' : '', onclick: () => { store.createVersion(); m.redraw(); } }, '＋ 保存当前版本'),
          ]),
          mergePanel(),
          m('section.check-summary', [
            m('div.check-summary-head', [
              m('div', [m('span.eyebrow', 'LIVE CHECK'), m('h2', '证明检查')]),
              m('span.check-total', { class: errors ? 'has-error' : '' }, errors + warnings),
            ]),
            m('div.check-summary-bars', [
              m('span', { style: { width: `${Math.max(8, 100 - errors * 24 - warnings * 12)}%` } }),
            ]),
            m('p', errors ? '修正错误后再保存为定稿。' : warnings ? '结构有效，仍有待核对项。' : '当前结构与引用关系完整。'),
          ]),
        ]),
        m('section.editor-column', [
          m('div.editor-titlebar', [
            m('div', [
              m('input.title-input', { value: document.title, disabled: store.locked, oninput: (event: Event) => { store.update((item) => { item.title = (event.target as HTMLInputElement).value; }); } }),
              m('div.editor-meta', [`${document.author} · ${document.steps.length} 个步骤`, m('span.keyboard-hint', '拖动 ⠿ 排序')]),
            ]),
            m('div.export-actions', [
              m('button.button.is-small', { disabled: store.locked, title: store.locked ? '有待处理冲突，合并完成后才能导出' : '', onclick: () => download(`${document.title}.md`, exportMarkdown(document), 'text/markdown;charset=utf-8') }, '导出 Markdown'),
              m('button.button.is-small', { disabled: store.locked, title: store.locked ? '有待处理冲突，合并完成后才能导出' : '', onclick: () => download(`${document.title}.tex`, exportLatex(document), 'application/x-tex;charset=utf-8') }, '导出 LaTeX'),
            ]),
          ]),
          store.pendingMerge && m('div.merge-banner', [
            m('span', '当前显示的是自动合并中间稿，编辑已锁定。'),
            m('strong', `${store.conflictProgress.total - store.conflictProgress.done} 项同步骤冲突等待选择`),
            m('small', '完成后版本快照与 Markdown / LaTeX 导出均使用合并稿。'),
          ]),
          !store.online && !store.pendingMerge && m('div.offline-banner', [
            m('strong', `已断网：改动只保存在「${store.tabName}」本地稿`),
            m('span', '其他标签的改动不会覆盖本稿；点击「恢复连接并合并」按步骤合并。'),
          ]),
          m('section.goal-card', [
            m('div.goal-label', '证明目标'),
            m('div.goal-formula', renderRichText(`$${document.goal}$`)),
            m('input.formula-input', {
              value: document.goal,
              disabled: store.locked,
              onfocus: (event: Event) => { store.lastInput = event.target as HTMLInputElement; },
              oninput: (event: Event) => store.update((item) => { item.goal = (event.target as HTMLInputElement).value; }),
              'aria-label': '证明目标',
            }),
          ]),
          m('div.steps-toolbar', [
            m('div', [m('strong', '证明步骤'), m('span.steps-count', `${document.steps.length} 步`)]),
            m('div.steps-toolbar-actions', [
              m('button.button.is-small.is-white', { disabled: store.locked, onclick: () => { store.addStep('premise'); m.redraw(); } }, '＋ 前提'),
              m('button.button.is-small.is-white', { disabled: store.locked, onclick: () => { store.addStep('derivation'); m.redraw(); } }, '＋ 推导'),
              m('button.button.is-small.is-white', { disabled: store.locked, onclick: () => { store.addStep('goal'); m.redraw(); } }, '＋ 结论'),
            ]),
          ]),
          m('div.steps-list', document.steps.length === 0 && m('div.empty-state', '尚无步骤。按 Ctrl+Enter 开始添加。'), document.steps.map((step, index) => {
            const stepChecks = checks.filter((check) => check.stepId === step.id);
            return m('article.step-card', {
              'data-step': step.id,
              class: step.id === store.selectedStepId ? 'is-selected' : '',
              draggable: true,
              onclick: () => { store.selectStep(step.id); m.redraw(); },
              ondragstart: () => { store.dragStepId = step.id; },
              ondragover: (event: DragEvent) => event.preventDefault(),
              ondrop: (event: DragEvent) => { event.preventDefault(); store.moveStep(store.dragStepId, step.id); store.dragStepId = ''; m.redraw(); },
            }, [
              m('div.step-rail', [
                m('span.drag-handle', { title: '拖动排序' }, '⠿'),
                m('span.step-number', String(index + 1).padStart(2, '0')),
              ]),
              m('div.step-body', [
                m('div.step-head', [
                  m('span.tag', { class: step.type === 'goal' ? 'is-success' : step.type === 'premise' ? 'is-info' : 'is-light' }, typeLabel[step.type]),
                  m('span.rule-chip', step.rule),
                  m('span.step-id', `#${shortId(step.id)}`),
                  stepChecks.length > 0 && m('span.issue-badge', `${stepChecks.length} 项检查`),
                  m('button.step-menu', { onclick: (event: Event) => { event.stopPropagation(); store.removeStep(step.id); m.redraw(); }, title: '删除步骤' }, '×'),
                ]),
                m('div.step-statement', renderRichText(step.statement)),
                m('div.step-footer', [
                  m('span', step.references.length ? `依据：${step.references.map((reference) => {
                    const referenceIndex = document.steps.findIndex((item) => item.id === reference);
                    return referenceIndex >= 0 ? `步骤 ${referenceIndex + 1}` : `缺失 ${shortId(reference)}`;
                  }).join('、')}` : '独立前提'),
                  step.note && m('span.has-note', '含旁注'),
                  step.counterexample && m('span.has-counterexample', '含反例'),
                  step.alternative && m('span.has-branch', '含替代分支'),
                ]),
              ]),
            ]);
          })),
        ]),
        m('aside.right-rail', [
          selected ? m('section.panel.inspector', [
            m('div.panel-heading', [m('span', '步骤检查器'), m('span.inspector-step', `#${shortId(selected.id)}`)]),
            m('label.field-label', '步骤类型'),
            m('div.select.is-fullwidth', m('select', { value: selected.type, disabled: store.locked, onchange: (event: Event) => store.updateStep({ type: (event.target as HTMLSelectElement).value as ProofStep['type'] }) }, Object.entries(typeLabel).map(([value, label]) => m('option', { value }, label)))),
            m('label.field-label', '推理规则'),
            m('div.select.is-fullwidth', m('select', { value: selected.rule, disabled: store.locked, onchange: (event: Event) => store.updateStep({ rule: (event.target as HTMLSelectElement).value }) }, RULES.map((rule) => m('option', { value: rule }, rule)))),
            m('label.field-label', '命题或推导式'),
            m('textarea.textarea.formula-textarea', {
              value: selected.statement,
              rows: 4,
              disabled: store.locked,
              onfocus: (event: Event) => { store.lastInput = event.target as HTMLTextAreaElement; },
              oninput: (event: Event) => store.updateStep({ statement: (event.target as HTMLTextAreaElement).value }),
            }),
            m('div.formula-toolbar', snippets.map((snippet) => m('button.formula-key', {
              disabled: store.locked,
              title: `插入 ${snippet.label}`,
              onclick: (event: Event) => {
                event.preventDefault();
                const input = store.lastInput;
                if (!input) return;
                const start = input.selectionStart ?? input.value.length;
                const end = input.selectionEnd ?? start;
                const next = input.value.slice(0, start) + snippet.value + input.value.slice(end);
                input.value = next;
                if (input instanceof HTMLTextAreaElement) store.updateStep({ statement: next });
                else store.update((document) => { document.goal = next; });
                input.focus();
                const cursor = start + snippet.value.length;
                input.setSelectionRange(cursor, cursor);
                m.redraw();
              },
            }, snippet.label))),
            m('label.field-label', '引用步骤'),
            m('div.reference-list', document.steps.filter((step) => step.id !== selected.id).map((step) => m('label.reference-item', [
              m('input', {
                type: 'checkbox',
                disabled: store.locked,
                checked: selected.references.includes(step.id),
                onchange: (event: Event) => {
                  const checked = (event.target as HTMLInputElement).checked;
                  const references = checked ? [...selected.references, step.id] : selected.references.filter((id) => id !== step.id);
                  store.updateStep({ references });
                },
              }),
              m('span', `步骤 ${document.steps.indexOf(step) + 1}`),
              m('small', step.statement.replace(/\$/g, '')),
            ]))),
            m('div.field-grid', [
              m('div', [m('label.field-label', '旁注'), m('textarea.textarea.is-small', { rows: 2, disabled: store.locked, value: selected.note, placeholder: '记录思路或条件', oninput: (event: Event) => store.updateStep({ note: (event.target as HTMLTextAreaElement).value }) })]),
              m('div', [m('label.field-label', '反例 / 边界情况'), m('textarea.textarea.is-small', { rows: 2, disabled: store.locked, value: selected.counterexample, placeholder: '尝试寻找反例', oninput: (event: Event) => store.updateStep({ counterexample: (event.target as HTMLTextAreaElement).value }) })]),
              m('div', [m('label.field-label', '替代分支'), m('textarea.textarea.is-small', { rows: 2, disabled: store.locked, value: selected.alternative, placeholder: '另一种可行推导', oninput: (event: Event) => store.updateStep({ alternative: (event.target as HTMLTextAreaElement).value }) })]),
            ]),
            m('button.button.is-small.is-white.is-fullwidth.add-symbol', {
              disabled: store.locked,
              onclick: () => {
                const symbol = window.prompt('输入符号名称');
                if (!symbol) return;
                const meaning = window.prompt('输入符号含义') ?? '待补充';
                store.update((document) => { document.symbols[symbol] = meaning; });
                m.redraw();
              },
            }, '＋ 登记新符号'),
          ]) : m('section.panel.inspector', m('p.empty-copy', '选择一个步骤进行检查。')),
          m('section.panel.symbol-panel', [
            m('div.panel-heading', [m('span', '符号表'), m('span.count-badge', Object.keys(document.symbols).length)]),
            m('div.symbol-list', Object.entries(document.symbols).map(([symbol, meaning]) => m('div.symbol-row', [
              m('code', symbol),
              m('input.symbol-meaning', { value: meaning, disabled: store.locked, oninput: (event: Event) => store.update((item) => { item.symbols[symbol] = (event.target as HTMLInputElement).value; }) }),
            ]))),
          ]),
          m('section.panel.checks-panel', [
            m('div.panel-heading', [m('span', '检查结果'), m('span.count-badge', checks.length)]),
            m('div.check-list', checks.map((check) => m('button.check-item', {
              class: check.severity,
              onclick: () => { if (check.stepId) { store.selectStep(check.stepId); globalThis.document.querySelector(`[data-step="${check.stepId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } m.redraw(); },
            }, [
              m('span.check-icon', check.severity === 'error' ? '×' : check.severity === 'warning' ? '!' : '✓'),
              m('span', [m('strong', check.title), m('small', check.detail)]),
            ]))),
          ]),
          m('section.shortcut-card', [
            m('span.eyebrow', 'KEYBOARD'),
            m('p', [m('kbd', 'Ctrl'), ' + ', m('kbd', 'Enter'), ' 新步骤']),
            m('p', [m('kbd', 'Alt'), ' + ', m('kbd', '↑↓'), ' 切换步骤']),
            m('p', [m('kbd', 'Ctrl'), ' + ', m('kbd', 'Z'), ' 撤销']),
          ]),
        ]),
      ]),
      conflictOverlay(),
      selectedVersion && m('div.diff-overlay', { onclick: () => { store.compareVersionId = ''; m.redraw(); } }, [
        m('section.diff-dialog', { onclick: (event: Event) => event.stopPropagation() }, [
          m('header.diff-head', [
            m('div', [m('span.eyebrow', 'VERSION DIFF'), m('h2', `${selectedVersion.name} ↔ 当前版本`)]),
            m('button.delete', { onclick: () => { store.compareVersionId = ''; m.redraw(); } }),
          ]),
          m('div.diff-summary', [
            m('span.tag.is-danger', `删除 ${diff.filter((item) => item.kind === 'removed').length}`),
            m('span.tag.is-success', `新增 ${diff.filter((item) => item.kind === 'added').length}`),
            m('span.tag.is-warning', `修改 ${diff.filter((item) => item.kind === 'changed').length}`),
            m('span.tag.is-light', `未变 ${diff.filter((item) => item.kind === 'same').length}`),
          ]),
          m('div.diff-table', [
            m('div.diff-row.diff-header', [m('span', '位置'), m('span', '旧版本'), m('span', '当前版本')]),
            ...diff.map((item) => m('div.diff-row', { class: `is-${item.kind}` }, [
              m('span.diff-label', item.label),
              m('span', item.before || '—'),
              m('span', item.after || '—'),
            ])),
          ]),
        ]),
      ]),
      store.toast && m('div.toast-notification', store.toast),
    ]);
  }
}

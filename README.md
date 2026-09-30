# 格致 · 数学证明步骤编写与检查工具

一个完全在浏览器运行的数学证明工作台。使用步骤、引用和推理规则组织证明，实时检查结构与符号，并保留版本快照。

## 功能

- 逐步录入前提、推导和结论，选择推理规则并维护步骤引用。
- 检查未定义符号、缺失引用、循环引用和未证明目标。
- 为步骤记录旁注、反例和替代分支。
- 公式快捷输入、KaTeX 实时渲染、原生拖拽排序与键盘导航。
- 文档级撤销/重做，`localStorage` 自动保存，多版本文档管理。
- 保存版本快照并进行逐步差异比较。
- 导出 Markdown 或 LaTeX 证明稿。

## 技术栈

- Mithril 2
- TypeScript
- Bulma
- KaTeX
- Vite

## 本地开发

```bash
npm install
npm run dev
```

浏览器打开终端输出的开发地址。数据保存在当前浏览器的 `localStorage` 中。

## 生产构建

```bash
npm run build
npm run preview
```

构建产物位于 `dist/`。

## 键盘操作

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl/Cmd + Enter` | 添加推导步骤 |
| `Ctrl/Cmd + Shift + Enter` | 添加结论步骤 |
| `Alt + ↑ / ↓` | 切换当前步骤 |
| `Ctrl/Cmd + Z` | 撤销 |
| `Ctrl/Cmd + Shift + Z` 或 `Ctrl/Cmd + Y` | 重做 |
| `Ctrl/Cmd + S` | 立即保存 |
| `Delete` | 删除当前步骤（编辑框外） |

## Docker

镜像内由 nginx 监听容器端口 `80`，不包含或硬编码宿主端口。

```bash
docker build -t math-proof-editor .
docker run --rm -p 10014:80 math-proof-editor
```

宿主端口 `10014` 仅用于本地运行示例，实际编排端口以根端口表为准。

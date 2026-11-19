// The item definition as a tree: one row per node, labelled with how its parent reaches it (case values,
// thresholds, true/false, fallback). The branch the test inputs take is marked, the models it renders too.
import { ArrowDown, ArrowUp, Box, ChevronDown, ChevronRight, CircleSlash, FileJson, GitBranch, Layers, ListTree, Plus, Sparkles, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../../app/store';
import { shortId } from '../../core/minecraft/items/registry';
import { childrenOf, joinPath } from '../../core/minecraft/items/tree';
import type { ItemModelNode, Json } from '../../core/minecraft/items/types';
import { validateItemDefinition, type ItemIssue } from '../../core/minecraft/items/validate';
import type { Doc } from '../../core/types';
import { useT, type Dictionary } from '../../i18n';
import { dispatch } from '../actions';
import { iconButton } from './fieldEditors';
import { evaluateDoc, selectNode, useInputs, useItemUi, useSelectedPath } from './itemStore';

type ItemsText = Dictionary['items'];

const kindIcon: Record<ItemModelNode['kind'], ReactNode> = {
  model: <Box size={13} strokeWidth={1.75} />,
  composite: <Layers size={13} strokeWidth={1.75} />,
  condition: <GitBranch size={13} strokeWidth={1.75} />,
  select: <ListTree size={13} strokeWidth={1.75} />,
  range_dispatch: <ListTree size={13} strokeWidth={1.75} />,
  special: <Sparkles size={13} strokeWidth={1.75} />,
  empty: <CircleSlash size={13} strokeWidth={1.75} />,
  bundle_selected_item: <Box size={13} strokeWidth={1.75} />,
  unknown: <TriangleAlert size={13} strokeWidth={1.75} />,
};

export const whenText = (when: Json): string => (Array.isArray(when) ? (when as Json[]) : [when]).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');

/** One line describing a node. */
export function nodeTitle(node: ItemModelNode, t: ItemsText): string {
  switch (node.kind) {
    case 'model':
      return node.model ? shortId(node.model) : t.noModel;
    case 'composite':
      return t.kinds.composite;
    case 'condition':
      return `${t.kinds.condition}: ${shortId(node.property)}`;
    case 'select':
      return `${t.kinds.select}: ${shortId(node.property)}`;
    case 'range_dispatch':
      return `${t.kinds.range_dispatch}: ${shortId(node.property)}`;
    case 'special':
      return `${t.kinds.special}: ${shortId(node.special.type)}`;
    case 'unknown':
      return node.type;
    default:
      return t.kinds[node.kind];
  }
}

/** How the parent reaches a child, from the last step of its path. */
function stepLabel(parent: ItemModelNode, step: string, t: ItemsText): string {
  const [key, index] = step.split('/');
  const i = Number(index);
  if (key === 'on_true') return t.onTrue;
  if (key === 'on_false') return t.onFalse;
  if (key === 'fallback') return t.fallback;
  if (key === 'cases' && parent.kind === 'select') return whenText(parent.cases[i].when);
  if (key === 'entries' && parent.kind === 'range_dispatch') return `≥ ${parent.entries[i].threshold}`;
  return `#${i + 1}`;
}

interface TreeContext {
  docId: string;
  selected: string | null;
  visited: ReadonlySet<string>;
  rendered: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  toggle(path: string): void;
  t: ItemsText;
}

function PartButtons({ parentPath, index, count }: { parentPath: string; index: number; count: number }) {
  const t = useT().items;
  return (
    <span className="ml-auto hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
      <button type="button" className={iconButton} disabled={index === 0} title={t.moveUp} aria-label={t.moveUp} onClick={(e) => (e.stopPropagation(), void dispatch('item.move_child', { path: parentPath, from: index, to: index - 1 }))}>
        <ArrowUp size={12} />
      </button>
      <button type="button" className={iconButton} disabled={index === count - 1} title={t.moveDown} aria-label={t.moveDown} onClick={(e) => (e.stopPropagation(), void dispatch('item.move_child', { path: parentPath, from: index, to: index + 1 }))}>
        <ArrowDown size={12} />
      </button>
      <button type="button" className={iconButton} title={t.removePart} aria-label={t.removePart} onClick={(e) => (e.stopPropagation(), void dispatch('item.remove_child', { path: parentPath, index }))}>
        <Trash2 size={12} />
      </button>
    </span>
  );
}

function partCount(node: ItemModelNode): number {
  return node.kind === 'select' ? node.cases.length : node.kind === 'range_dispatch' ? node.entries.length : node.kind === 'composite' ? node.models.length : 0;
}

function TreeRow({ node, path, label, depth, parent, ctx }: { node: ItemModelNode; path: string; label: string; depth: number; parent: { node: ItemModelNode; path: string; index: number | null } | null; ctx: TreeContext }) {
  const children = childrenOf(node);
  const open = !ctx.collapsed.has(path);
  const selected = ctx.selected === path;
  const onBranch = ctx.visited.has(path);
  const shown = ctx.rendered.has(path);
  const canAdd = node.kind === 'select' || node.kind === 'range_dispatch' || node.kind === 'composite';
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={children.length > 0 ? open : undefined}>
      <div
        className={`group relative flex h-7 cursor-default items-center gap-1 rounded-md pr-1 text-[calc(12.5px*var(--font-scale))] ${selected ? 'bg-raised text-text ring-1 ring-line-strong ring-inset' : 'text-dim hover:bg-raised/60 hover:text-text'}`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        onClick={() => selectNode(ctx.docId, path)}
      >
        {onBranch && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-accent" />}
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? ctx.t.collapse : ctx.t.expand}
          className={`flex size-4 shrink-0 items-center justify-center text-faint ${children.length > 0 ? '' : 'invisible'}`}
          onClick={(e) => (e.stopPropagation(), ctx.toggle(path))}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className={`max-w-[45%] shrink-0 truncate rounded px-1 font-mono text-[calc(11.5px*var(--font-scale))] ${onBranch ? 'bg-accent/15 text-accent' : 'bg-ink text-faint'}`} title={label}>
          {label}
        </span>
        <span className={`shrink-0 ${node.kind === 'unknown' ? 'text-danger' : shown ? 'text-accent' : 'text-faint'}`}>{kindIcon[node.kind]}</span>
        <span className={`min-w-0 truncate ${node.kind === 'model' ? 'font-mono text-[calc(12px*var(--font-scale))]' : ''} ${node.kind === 'model' && !node.model ? 'text-danger' : ''}`} title={nodeTitle(node, ctx.t)}>
          {nodeTitle(node, ctx.t)}
        </span>
        {shown && <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[calc(10.5px*var(--font-scale))] text-accent">{ctx.t.shown}</span>}
        {canAdd && (
          <button
            type="button"
            className={`${iconButton} ml-auto hidden group-hover:flex group-focus-within:flex`}
            title={ctx.t.addPart[node.kind as 'select']}
            aria-label={ctx.t.addPart[node.kind as 'select']}
            onClick={(e) => {
              e.stopPropagation();
              void dispatch('item.add_child', { path }).then((r) => r && selectNode(ctx.docId, (r as { path: string }).path));
            }}
          >
            <Plus size={13} />
          </button>
        )}
        {parent && parent.index !== null && <PartButtons parentPath={parent.path} index={parent.index} count={partCount(parent.node)} />}
      </div>
      {open && children.length > 0 && (
        <ul role="group">
          {children.map((c) => {
            const [key, index] = c.step.split('/');
            return (
              <TreeRow
                key={c.step}
                node={c.node}
                path={joinPath(path, c.step)}
                label={stepLabel(node, c.step, ctx.t)}
                depth={depth + 1}
                parent={{ node, path, index: key === 'cases' || key === 'entries' || key === 'models' ? Number(index) : null }}
                ctx={ctx}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function issueText(issue: ItemIssue, t: ItemsText): string {
  return t.issues[issue.code](issue.subject ?? '');
}

function Issues({ doc, issues }: { doc: Doc; issues: readonly ItemIssue[] }) {
  const t = useT().items;
  if (issues.length === 0) return <p className="px-2 py-1.5 text-[calc(12px*var(--font-scale))] text-faint">{t.noIssues}</p>;
  return (
    <ul className="flex flex-col gap-0.5">
      {issues.map((issue, i) => (
        <li key={i}>
          <button
            type="button"
            className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[calc(12px*var(--font-scale))] leading-snug hover:bg-raised"
            title={issue.message}
            onClick={() => selectNode(doc.id, issue.path)}
          >
            <TriangleAlert size={13} strokeWidth={2} className={`mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-danger' : 'text-accent'}`} />
            <span className="min-w-0 text-dim">
              <span className="font-mono text-faint">{issue.path === null ? t.file : issue.path || t.root}</span> {issueText(issue, t)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The left pane of an item definition document: file row, node tree and the check results. */
export function ItemTreePane() {
  const doc = useApp(selectActiveDoc);
  const t = useT().items;
  const inputs = useInputs(doc.id);
  const selected = useSelectedPath(doc.id);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const item = doc.state.item;
  const evaluation = useMemo(() => evaluateDoc(doc, inputs), [doc, inputs]);
  const issues = useMemo(() => (item ? validateItemDefinition(item.definition, item.version) : []), [item]);
  if (!item || !evaluation) return null;
  const ctx: TreeContext = {
    docId: doc.id,
    selected,
    visited: new Set(evaluation.visited),
    rendered: new Set(evaluation.rendered.map((r) => r.path)),
    collapsed,
    toggle: (path) =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    t,
  };
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <section aria-label={t.treeTitle} className="flex h-full min-h-0 flex-col border-r border-line bg-panel">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <FileJson size={15} strokeWidth={1.75} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate font-mono text-[calc(12.5px*var(--font-scale))] text-text" title={`assets/${item.namespace}/items/${item.id}.json`}>
          {item.namespace}:{item.id}
        </span>
        <span className="shrink-0 rounded bg-ink px-1.5 text-[calc(11px*var(--font-scale))] text-faint">{item.version}+</span>
        <button
          type="button"
          className={`${iconButton} ml-auto`}
          title={t.wizard.replaceTitle}
          aria-label={t.wizard.replaceTitle}
          onClick={() => useItemUi.setState({ wizard: { namespace: item.namespace, itemId: item.id, base: '', mode: 'range', version: item.version, fromModel: false, replace: true } })}
        >
          <Wand2 size={14} />
        </button>
      </header>
      <div
        role="tree"
        aria-label={t.treeTitle}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
            const match = /^(.*?)\/?(cases|entries|models)\/(\d+)$/.exec(selected);
            if (match) {
              e.preventDefault();
              e.stopPropagation();
              void dispatch('item.remove_child', { path: match[1], index: Number(match[3]) }).then(() => selectNode(doc.id, match[1]));
            }
          }
        }}
      >
        <div
          className={`mb-0.5 flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-[calc(12.5px*var(--font-scale))] ${selected === null ? 'bg-raised text-text ring-1 ring-line-strong ring-inset' : 'text-dim hover:bg-raised/60 hover:text-text'}`}
          onClick={() => selectNode(doc.id, null)}
        >
          <FileJson size={13} strokeWidth={1.75} className="text-faint" />
          {t.fileSettings}
        </div>
        <ul role="group">
          <TreeRow node={item.definition.model} path="" label={t.modelKey} depth={0} parent={null} ctx={ctx} />
        </ul>
      </div>
      <footer className="max-h-[35%] shrink-0 overflow-y-auto border-t border-line p-1.5">
        <h3 className="px-1.5 pb-1 text-[calc(12px*var(--font-scale))] font-semibold text-dim">
          {t.check} {issues.length > 0 && <span className={errors > 0 ? 'text-danger' : 'text-accent'}>({issues.length})</span>}
        </h3>
        <Issues doc={doc} issues={issues} />
      </footer>
    </section>
  );
}

import { own } from './state';
import type { DocState } from './types';

/**
 * References to objects, groups and materials as commands accept them: an id, or a name.
 *
 * An entry that is an existing id (an own key of the record, never something inherited from
 * Object.prototype) is that thing. Anything else is a name pattern: the exact name, or a glob with
 * `*` (any run of characters, also none) and `?` (exactly one character). Matching is case-sensitive
 * and always against the whole name. A name that exists literally wins over reading it as a glob, so
 * an object that is really called `a*` can still be addressed.
 */

/** The shared sentence for command descriptions that take such references. */
export const REFS_HINT = 'ids, exact names or glob patterns such as "Belt *"';

const MAX_LISTED = 5;

/** True if the text contains a glob wildcard (`*` or `?`). */
export function isGlob(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/** A predicate for a glob pattern (`*`, `?`; everything else literal; case-sensitive; whole string). */
export function globMatcher(pattern: string): (text: string) => boolean {
  if (!isGlob(pattern)) return (text) => text === pattern;
  // Not a regular expression: patterns come from MCP clients, and a regex with many `*` can take
  // exponential time. This is the classic two-pointer match, at worst pattern length x text length.
  const p = pattern.replace(/\*+/g, '*');
  return (text) => {
    let t = 0;
    let i = 0;
    let star = -1; // position of the last * seen in the pattern
    let mark = 0; // text position that * is currently assumed to end before
    while (t < text.length) {
      if (i < p.length && (p[i] === '?' || (p[i] !== '*' && p[i] === text[t]))) {
        i++;
        t++;
      } else if (i < p.length && p[i] === '*') {
        star = i++;
        mark = t;
      } else if (star >= 0) {
        // Let the last * take one more character and try again from there.
        i = star + 1;
        t = ++mark;
      } else {
        return false;
      }
    }
    while (i < p.length && p[i] === '*') i++;
    return i === p.length;
  };
}

interface Named {
  readonly id: string;
  readonly name: string;
}

/** Ids of the entries whose name is exactly `pattern`, or, if there is none and it is a glob, that match the glob. In `order`. */
function matchNames(record: Readonly<Record<string, Named>>, order: readonly string[], pattern: string): string[] {
  const exact = order.filter((id) => own(record, id)?.name === pattern);
  if (exact.length > 0 || !isGlob(pattern)) return exact;
  const matches = globMatcher(pattern);
  return order.filter((id) => {
    const entry = own(record, id);
    return entry !== undefined && matches(entry.name);
  });
}

function quote(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function listCandidates(record: Readonly<Record<string, Named>>, ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED).map((id) => `${quote(record[id].name)} (${id})`);
  const rest = ids.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

function notFound(kind: string, ref: string): string {
  const what = kind[0].toUpperCase() + kind.slice(1);
  return isGlob(ref)
    ? `${what} ${quote(ref)} does not exist: no ${kind} has this id and the pattern matches no ${kind} name (names are case-sensitive)`
    : `${what} ${quote(ref)} does not exist: no ${kind} has this id or name (names are case-sensitive)`;
}

function resolveOne(kind: string, record: Readonly<Record<string, Named>>, order: readonly string[], ref: string): string {
  if (own(record, ref)) return ref;
  const matches = matchNames(record, order, ref);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(notFound(kind, ref));
  throw new Error(
    `${quote(ref)} matches ${matches.length} ${kind}s, but exactly one is needed here: ${listCandidates(record, matches)}. Use an id or a more specific name.`,
  );
}

/**
 * Resolves a list of object references to object ids: every entry is an id or a name pattern, and a
 * pattern stands for ALL objects it matches (in outliner order). The result has no duplicates and keeps
 * the order of first appearance. Throws if an entry matches nothing.
 */
export function resolveObjectIds(state: DocState, refs: readonly string[]): string[] {
  const result = new Set<string>();
  for (const ref of refs) {
    if (own(state.objects, ref)) {
      result.add(ref);
      continue;
    }
    const matches = matchNames(state.objects, state.order, ref);
    if (matches.length === 0) throw new Error(notFound('object', ref));
    for (const id of matches) result.add(id);
  }
  return [...result];
}

/** Resolves one object reference (id or name pattern) to its id. Throws unless exactly one object matches. */
export function resolveObjectId(state: DocState, ref: string): string {
  return resolveOne('object', state.objects, state.order, ref);
}

/** Resolves one group reference (id, exact name or glob) to its id. Throws unless exactly one group matches. */
export function resolveGroupId(state: DocState, ref: string): string {
  return resolveOne('group', state.groups, state.groupOrder, ref);
}

/** Resolves one material reference (id, exact name or glob) to its id. Throws unless exactly one material matches. */
export function resolveMaterialId(state: DocState, ref: string): string {
  return resolveOne('material', state.materials, Object.keys(state.materials), ref);
}

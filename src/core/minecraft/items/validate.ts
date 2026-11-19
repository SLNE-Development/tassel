// Checks an item definition against what its target version accepts.
import {
  fieldsIn,
  findModelType,
  findProperty,
  findSelectProperty,
  findSpecialModel,
  findTintSource,
  normalizeId,
  rootFields,
  shortId,
  type FieldSpec,
  type PropertyKind,
} from './registry';
import { joinPath, walk } from './tree';
import type { Fields, ItemDefinition, Json } from './types';

export type ItemIssueCode =
  | 'unknownType'
  | 'unknownProperty'
  | 'unknownTint'
  | 'unknownSpecial'
  | 'unknownField'
  | 'missingModel'
  | 'invalidResource'
  | 'missingField'
  | 'invalidField'
  | 'invalidWhen'
  | 'duplicateWhen'
  | 'noCases'
  | 'noFallback'
  | 'duplicateThreshold'
  | 'emptyComposite';

export interface ItemIssue {
  readonly severity: 'error' | 'warning';
  readonly code: ItemIssueCode;
  /** Node path ("" = root model); null for the file's root keys. */
  readonly path: string | null;
  /** What the issue is about: a key, a value, a tint index ... */
  readonly subject?: string;
  /** English, for MCP clients. */
  readonly message: string;
}

const RESOURCE = /^([a-z0-9_.-]+:)?[a-z0-9_.\-/]+$/;
export const isResourceLocation = (value: string): boolean => RESOURCE.test(value);

function checkValue(spec: FieldSpec, value: Json): boolean {
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && (spec.min === undefined || value >= spec.min);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value) && (spec.min === undefined || (spec.minExclusive ? value > spec.min : value >= spec.min));
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && (spec.options ?? []).includes(value);
    case 'resource':
      return typeof value === 'string' && isResourceLocation(value);
    case 'color':
      return (typeof value === 'number' && Number.isInteger(value)) || (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number'));
    case 'json':
      return true;
  }
}

export function validateItemDefinition(def: ItemDefinition, version: string): ItemIssue[] {
  const issues: ItemIssue[] = [];
  const add = (severity: ItemIssue['severity'], code: ItemIssueCode, path: string | null, message: string, subject?: string) =>
    issues.push({ severity, code, path, message, ...(subject !== undefined ? { subject } : {}) });
  const where = (path: string | null) => (path === null ? 'the file' : path === '' ? 'the root model' : `"${path}"`);

  /** Known fields: required present, values valid; unknown keys reported as warnings. */
  const checkFields = (fields: Fields, specs: readonly FieldSpec[], path: string | null, owner: string) => {
    const known = fieldsIn(specs, version);
    for (const spec of known) {
      if (!Object.hasOwn(fields, spec.key)) {
        if (spec.required) add('error', 'missingField', path, `${owner} in ${where(path)} needs "${spec.key}"`, spec.key);
      } else if (!checkValue(spec, fields[spec.key])) {
        add('error', 'invalidField', path, `"${spec.key}" of ${owner} in ${where(path)} is not a valid ${spec.kind}${spec.options ? ` (one of ${spec.options.join(', ')})` : ''}`, spec.key);
      }
    }
    for (const key of Object.keys(fields)) {
      if (!known.some((s) => s.key === key)) add('warning', 'unknownField', path, `${owner} in ${where(path)} has a key "${key}" that ${version} does not know; it is kept as it is`, key);
    }
  };

  const checkModelRef = (ref: string, path: string, key: string) => {
    if (!ref.trim()) add('error', 'missingModel', path, `${where(path)} has no model reference ("${key}")`, key);
    else if (!isResourceLocation(ref)) add('error', 'invalidResource', path, `"${ref}" in ${where(path)} is not a valid resource location (lower case a-z, 0-9, _ . - /)`, key);
  };

  checkFields(def.fields, rootFields, null, 'The item definition');

  for (const { path, node } of walk(def)) {
    if (node.kind === 'unknown' || !findModelType(node.type, version)) {
      add('warning', 'unknownType', path, `${where(path)} has type "${node.type}" which ${version} does not know (or whose structure is broken); it is kept as it is`, node.type);
      continue;
    }
    switch (node.kind) {
      case 'model':
        checkModelRef(node.model, path, 'model');
        checkFields(node.fields, [], path, 'The model');
        (node.tints ?? []).forEach((tint, i) => {
          const spec = findTintSource(tint.type, version);
          const tintPath = path;
          if (!spec) add('warning', 'unknownTint', tintPath, `Tint ${i} of ${where(path)} has type "${tint.type}" which ${version} does not know`, String(i));
          else checkFields(tint.fields, spec.fields, tintPath, `Tint ${i} (${shortId(spec.id)})`);
        });
        break;
      case 'composite':
        checkFields(node.fields, [], path, 'The composite');
        if (node.models.length === 0) add('warning', 'emptyComposite', path, `The composite ${where(path)} has no models and renders nothing`);
        break;
      case 'condition':
      case 'select':
      case 'range_dispatch': {
        const kind: PropertyKind = node.kind;
        const spec = findProperty(kind, node.property, version);
        if (!spec) {
          add('warning', 'unknownProperty', path, `${where(path)} uses property "${node.property}" which ${version} does not know for ${shortId(node.type)}`, node.property);
          break;
        }
        checkFields(node.fields, spec.fields, path, `Property ${shortId(spec.id)}`);
        if (node.kind === 'select') {
          if (node.cases.length === 0) add('error', 'noCases', path, `The select ${where(path)} has no cases; Minecraft rejects an empty case list`);
          const values = findSelectProperty(node.property, version)!.values;
          const seen = new Set<string>();
          node.cases.forEach((c, i) => {
            const list = Array.isArray(c.when) ? (c.when as Json[]) : [c.when];
            if (list.length === 0) add('error', 'invalidWhen', joinPath(path, 'cases', i), `Case ${i} of ${where(path)} has an empty "when" list`, String(i));
            for (const v of list) {
              const key = JSON.stringify(v);
              if (seen.has(key)) add('warning', 'duplicateWhen', joinPath(path, 'cases', i), `Case ${i} of ${where(path)} repeats the value ${key}; only the first case with it is used`, key);
              seen.add(key);
              const ok =
                values.kind === 'json' ||
                (typeof v === 'string' && (values.kind === 'string' || (values.kind === 'resource' ? isResourceLocation(v) : (values.options ?? []).includes(v))));
              if (!ok) add('error', 'invalidWhen', joinPath(path, 'cases', i), `Case ${i} of ${where(path)} has the value ${key}, which ${shortId(spec.id)} never reports${values.options ? ` (valid: ${values.options.join(', ')})` : ''}`, key);
            }
          });
          if (!node.fallback) add('warning', 'noFallback', path, `The select ${where(path)} has no fallback: unmatched values show the missing model`);
        }
        if (node.kind === 'range_dispatch') {
          const seen = new Set<number>();
          node.entries.forEach((e, i) => {
            if (seen.has(e.threshold)) add('warning', 'duplicateThreshold', joinPath(path, 'entries', i), `Entry ${i} of ${where(path)} repeats the threshold ${e.threshold}`, String(e.threshold));
            seen.add(e.threshold);
          });
          // Only custom_model_data can be negative; for the other properties a threshold of 0 or less catches everything.
          const coversAll = normalizeId(node.property) !== 'minecraft:custom_model_data' && node.entries.some((e) => e.threshold <= 0);
          if (!node.fallback && !coversAll) add('warning', 'noFallback', path, `The range dispatch ${where(path)} has no fallback: values below the lowest threshold show the missing model`);
        }
        break;
      }
      case 'special': {
        checkModelRef(node.base, path, 'base');
        const spec = findSpecialModel(node.special.type, version);
        if (!spec) add('warning', 'unknownSpecial', path, `${where(path)} uses special model "${node.special.type}" which ${version} does not know`, node.special.type);
        else checkFields(node.special.fields, spec.fields, path, `Special model ${shortId(spec.id)}`);
        checkFields(node.fields, [], path, 'The special node');
        break;
      }
      case 'empty':
      case 'bundle_selected_item':
        checkFields(node.fields, [], path, `The ${shortId(node.type)} node`);
        break;
    }
  }
  return issues;
}

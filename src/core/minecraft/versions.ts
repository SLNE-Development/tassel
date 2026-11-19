// Minecraft Java versions that Tessel can target, and what each one supports.
//
// Versions are listed oldest first. Everything version-dependent is a "ranged" entry: it applies from
// `since` up to, but not including, `until`. To support a new version, append it to `javaVersions` and add
// entries only for what changed (a capability entry with `since: '<new>'`, an export/import rule with
// `since` / `until`); the entries of older versions stay untouched, so their output cannot change.

export interface JavaVersion {
  /** e.g. '26.3'. Stored in documents (`JavaModelSettings.version`). */
  readonly id: string;
  /** For the version picker, e.g. '26.3+'. */
  readonly label: string;
}

export const javaVersions: readonly JavaVersion[] = [{ id: '26.3', label: '26.3+' }];

/** The version new documents target: the newest one. */
export const DEFAULT_VERSION = javaVersions[javaVersions.length - 1].id;

export interface Ranged {
  /** First version the entry applies to. */
  readonly since: string;
  /** First version it no longer applies to (exclusive); absent = all later versions. */
  readonly until?: string;
}

export function versionIndex(id: string): number {
  const index = javaVersions.findIndex((v) => v.id === id);
  if (index < 0) throw new Error(`Unknown Minecraft Java version "${id}". Known versions: ${javaVersions.map((v) => v.id).join(', ')}`);
  return index;
}

export const isJavaVersion = (id: string): boolean => javaVersions.some((v) => v.id === id);

/** Whether a ranged entry applies to the version. */
export function inRange(entry: Ranged, version: string): boolean {
  const v = versionIndex(version);
  return v >= versionIndex(entry.since) && (entry.until === undefined || v < versionIndex(entry.until));
}

/** What a version's block/item models can express. */
export interface JavaCapabilities {
  /** Element rotation on all three axes at any angle (else: one axis, `rotationLimit`, `rotationStep`). */
  readonly freeRotation: boolean;
  /** Largest absolute single-axis angle, when rotation is not free. */
  readonly rotationLimit: number;
  /** Angle step when rotation is not free (0 = any). */
  readonly rotationStep: number;
  readonly lightEmission: boolean;
  readonly shadeDirectionOverride: boolean;
  /** Element coordinates must lie within this range of px on every axis. */
  readonly coordinateRange: readonly [number, number];
  readonly guiLight: boolean;
  /** "groups" may be written into the model (ignored by the game, read back by editors). */
  readonly groups: boolean;
}

/** Capability changes, oldest first; a version's capabilities are all entries in range merged in order. */
const capabilityEntries: readonly (Ranged & Partial<JavaCapabilities>)[] = [
  {
    since: '26.3',
    freeRotation: true,
    rotationLimit: 180,
    rotationStep: 0,
    lightEmission: true,
    shadeDirectionOverride: true,
    coordinateRange: [-16, 32],
    guiLight: true,
    groups: true,
  },
];

export function capabilities(version: string): JavaCapabilities {
  let merged: Partial<JavaCapabilities> = {};
  for (const entry of capabilityEntries) {
    if (!inRange(entry, version)) continue;
    const { since: _since, until: _until, ...caps } = entry;
    merged = { ...merged, ...caps };
  }
  return merged as JavaCapabilities;
}

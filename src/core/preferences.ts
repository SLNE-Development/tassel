import { z } from 'zod';

// App-wide preferences: not part of any document, not undoable, persisted between launches.
// Changed only through the `preferences.*` commands, so the UI and MCP clients share them.

export const themes = ['dark', 'light', 'system'] as const;
export const languages = ['de', 'en'] as const;
export type Language = (typeof languages)[number];

/** Every field has a default, so `preferencesSchema.parse({})` is the factory default. */
export const preferencesSchema = z.object({
  theme: z.enum(themes).default('dark').describe('Colour theme; "system" follows the operating system.'),
  language: z.enum(languages).default('de').describe('UI language.'),
  uiScale: z.number().min(0.75).max(1.5).default(1).describe('Scale of the whole interface (1 = 100 %).'),
  fontScale: z.number().min(0.85).max(1.3).default(1).describe('Scale of text only, on top of uiScale.'),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#e9b949')
    .describe('Accent colour as #rrggbb (selection highlights, active controls).'),
  showGrid: z.boolean().default(true).describe('Show the ground grid in the viewport.'),
  showAxes: z.boolean().default(true).describe('Show the X / Z axis lines in the viewport.'),
  fieldOfView: z.number().min(20).max(100).default(40).describe('Vertical field of view of the viewport camera in degrees.'),
  orbitSpeed: z.number().min(0.25).max(3).default(1).describe('Orbit sensitivity of the viewport camera.'),
  zoomSpeed: z.number().min(0.25).max(3).default(1).describe('Zoom sensitivity of the viewport camera.'),
  invertZoom: z.boolean().default(false).describe('Reverse the mouse-wheel zoom direction.'),
  undoSteps: z.number().int().min(10).max(1000).default(200).describe('Undo steps kept per document.'),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultPreferences: Preferences = preferencesSchema.parse({});

/** Parses stored preferences. Unknown or invalid fields fall back to their defaults one by one. */
export function parsePreferences(raw: unknown): Preferences {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...defaultPreferences };
  for (const [key, schema] of Object.entries(preferencesSchema.shape)) {
    const parsed = schema.safeParse(input[key]);
    if (input[key] !== undefined && parsed.success) result[key] = parsed.data;
  }
  return result as Preferences;
}

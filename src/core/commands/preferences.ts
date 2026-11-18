import { z } from 'zod';
import { defaultPreferences, preferencesSchema } from '../preferences';
import { defineCommand } from './registry';

export const preferencesCommands = [
  defineCommand({
    id: 'preferences.get',
    title: 'Einstellungen abfragen',
    description: 'Get the app-wide preferences (theme, language, UI and font scale, accent colour, viewport and undo settings).',
    params: z.object({}),
    run(ctx) {
      return ctx.get().preferences;
    },
  }),

  defineCommand({
    id: 'preferences.set',
    title: 'Einstellungen ändern',
    description:
      'Change app-wide preferences. Pass only the fields to change. They apply immediately, are saved between launches and are not part of undo.',
    // Without the defaults: omitted fields stay as they are.
    params: z.object(
      Object.fromEntries(Object.entries(preferencesSchema.shape).map(([key, schema]) => [key, schema.unwrap().optional()])),
    ) as unknown as z.ZodObject<{ [K in keyof typeof preferencesSchema.shape]: z.ZodOptional<z.ZodType<z.infer<(typeof preferencesSchema.shape)[K]>>> }>,
    run(ctx, p) {
      const changes = Object.fromEntries(Object.entries(p).filter(([, value]) => value !== undefined));
      ctx.set((app) => ({ ...app, preferences: { ...app.preferences, ...changes } }));
      return ctx.get().preferences;
    },
  }),

  defineCommand({
    id: 'preferences.reset',
    title: 'Einstellungen zurücksetzen',
    description: 'Reset all preferences to their defaults.',
    params: z.object({}),
    run(ctx) {
      ctx.set((app) => ({ ...app, preferences: defaultPreferences }));
      return defaultPreferences;
    },
  }),
];

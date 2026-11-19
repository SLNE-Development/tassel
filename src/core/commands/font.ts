import { z } from 'zod';
import { defineCommand } from './registry';

export const fontCommands = [
  defineCommand({
    id: 'font.list',
    title: 'Schriften auflisten',
    history: false,
    description:
      'List the fonts scene_add_text can use: the font families installed on this computer, sorted by name. Each entry is { family, styles, monospaced }; family is the exact name to pass as font, styles are the styles the family has as { style, weight, italic } with style one of regular, bold, italic, bold-italic (bold = weight 600 and above; weight runs from 100 thin to 900 black), which is what bold / italic of scene_add_text choose from. search keeps only the families whose name contains that text (case does not matter), e.g. "segoe"; use it, the full list has a few hundred entries. limit caps the number of families returned (default 100); count is the number that matched and truncated says whether some were left out. The built-in font "default" always exists, is not part of the list, and is reported as builtin. available is false outside the desktop app (browser), where no system fonts can be used and families is empty. Changes nothing in the document.',
    params: z.object({
      search: z.string().max(200).optional().describe('Only families whose name contains this text, ignoring case.'),
      limit: z.number().int().min(1).max(2000).default(100).describe('Most families to return.'),
    }),
    async run(ctx, p) {
      const fonts = ctx.services.fonts;
      const all = fonts ? await fonts.list() : [];
      const search = p.search?.trim().toLowerCase() ?? '';
      const matching = search ? all.filter((f) => f.family.toLowerCase().includes(search)) : all;
      return {
        available: !!fonts,
        builtin: 'default',
        count: matching.length,
        truncated: matching.length > p.limit,
        families: matching.slice(0, p.limit),
      };
    },
  }),
];

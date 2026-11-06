import { z } from 'zod';
export const importPreviewSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      rows: z.number(),
      columns: z.array(z.string()),
    }),
  ),
  changes: z.object({
    products_added: z.number(),
    products_updated: z.number(),
    policies_added: z.number(),
    policies_updated: z.number(),
  }),
  errors: z.array(
    z.object({ sheet: z.string(), row: z.number(), message: z.string() }),
  ),
  samples: z.array(
    z.object({ sheet: z.string(), row: z.number(), summary: z.string() }),
  ),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

import { z } from 'zod';

export const replyBodyMarker = '{{답장}}';
export const replyTemplateSchema = z
  .object({
    template: z
      .string()
      .trim()
      .max(4000)
      .refine(
        (value) => !value || value.split(replyBodyMarker).length === 2,
        '답장 본문을 넣을 위치에 {{답장}}을 한 번 써 주세요.',
      ),
  })
  .strict();

export function renderReplyTemplate(template: string, body: string) {
  return template.replace(replyBodyMarker, () => body);
}

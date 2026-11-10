import type {
  ExtractionField,
  ExtractionSource,
} from '../../src/domain/http-contract.js';

export function extractionExcerpts(
  messages: readonly { id?: string; role: string; text: string }[],
  sources: readonly ExtractionSource[],
  field: ExtractionField,
) {
  const excerpts: Array<ExtractionSource & { text: string }> = [];
  for (const source of sources) {
    if (source.field !== field) continue;
    const message = messages.find(
      ({ id, role }) => id === source.message_id && role === 'customer',
    );
    if (
      !message ||
      source.start < 0 ||
      source.end <= source.start ||
      source.end > message.text.length
    )
      return [];
    excerpts.push({
      ...source,
      text: message.text.slice(source.start, source.end),
    });
  }
  return excerpts;
}

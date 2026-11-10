import type {
  ExtractionField,
  ExtractionSource,
} from '../../src/domain/http-contract.js';

export const extractionLabels: Record<ExtractionField, string> = {
  'order_draft.recipient.name': '받는 사람',
  'order_draft.recipient.phone_raw': '연락처',
  'order_draft.recipient.address_raw': '주소',
  'order_draft.recipient.postal_code': '우편번호',
  'order_draft.depositor_name': '입금자명',
  'payment_claim.depositor_name': '입금자명',
};

export function ExtractionText({
  text,
  sources,
}: {
  text: string;
  sources: ExtractionSource[];
}) {
  const ranges = sources.filter(
    ({ start, end }) => start >= 0 && start < end && end <= text.length,
  );
  if (!ranges.length) return text;
  const bounds = [
    ...new Set([
      0,
      text.length,
      ...ranges.flatMap(({ start, end }) => [start, end]),
    ]),
  ].sort((a, b) => a - b);
  return bounds.slice(0, -1).map((start, i) => {
    const end = bounds[i + 1]!;
    const fields = ranges
      .filter((range) => range.start <= start && range.end >= end)
      .map(({ field }) => field);
    const part = text.slice(start, end);
    return fields.length ? (
      <mark
        key={start}
        tabIndex={-1}
        data-extraction-fields={fields.join(' ')}
        title={fields.map((field) => extractionLabels[field]).join(', ')}
      >
        {part}
      </mark>
    ) : (
      part
    );
  });
}

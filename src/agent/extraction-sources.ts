import type {
  ExtractionField,
  ExtractionSource,
} from '../domain/http-contract.js';
import type { Message } from '../storage/store.js';
import {
  addressFromCustomer,
  customerSegments,
  locatePaymentStatement,
} from './customer-text.js';
import type { AgentRun } from './types.js';

type Segment = {
  message_id: string;
  request_id: string;
  start: number;
  text: string;
};
type Range = { start: number; end: number };
type Hit = { segment: Segment; range: Range };

const literal = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+');
const wordEnd = /[\p{L}\p{M}\p{N}]$/u;
const wordStart = /^[\p{L}\p{M}\p{N}]/u;
const particle =
  /^(?:으로|로|이에요|이예요|예요|입니다|이요|요|은|는|이|가|을|를)(?![\p{L}\p{M}\p{N}])/u;

function matches(text: string, pattern: string, allowParticle = false) {
  return [...text.matchAll(new RegExp(pattern, 'dgu'))].filter((match) => {
    const [start, end] = match.indices![0]!;
    return (
      !wordEnd.test(text.slice(0, start)) &&
      (!wordStart.test(text.slice(end)) ||
        (allowParticle && particle.test(text.slice(end))))
    );
  });
}

function locateValue(
  segments: Segment[],
  value: string,
  field: ExtractionField,
  sameName: boolean,
): Hit | undefined {
  const candidates = segments.flatMap((segment) =>
    matches(segment.text, literal(value), true).flatMap((match) => {
      const [start, end] = match.indices![0]!;
      const before = segment.text.slice(0, start);
      const after = segment.text.slice(end);
      if (
        field === 'order_draft.recipient.phone_raw' &&
        (/\d[-()]$/u.test(before) || /^[-()]\d/u.test(after))
      )
        return [];
      const depositor =
        /(?:입금자(?:명)?|입금은|송금은)\s*[:：]?\s*$/u.test(before) ||
        /^(?:\s*(?:이름|명의)으로)/u.test(after);
      const recipient =
        /(?:수령인|수령자|받는\s*분|받는\s*사람|성함)\s*[:：]?\s*$/u.test(
          before,
        );
      return [{ segment, range: { start, end }, depositor, recipient }];
    }),
  );
  if (field === 'order_draft.depositor_name') {
    const labeled = candidates.findLast(({ depositor }) => depositor);
    if (labeled || sameName) return labeled;
    const eligible = candidates.filter(({ recipient }) => !recipient);
    return eligible.length === 1 ? eligible[0] : undefined;
  }
  if (field === 'order_draft.recipient.name') {
    const eligible = candidates.filter(({ depositor }) => !depositor);
    return (
      eligible.findLast(({ recipient }) => recipient) ??
      (eligible.length === 1 ? eligible[0] : undefined)
    );
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function indexAddress(segment: Segment) {
  let compact = '';
  const offsets: number[] = [];
  for (const chunk of segment.text.matchAll(/\S+/gu)) {
    compact += chunk[0];
    for (let i = 0; i < chunk[0].length; i++) offsets.push(chunk.index! + i);
  }
  const range = (start: number, length: number): Range => ({
    start: offsets[start]!,
    end: offsets[start + length - 1]! + 1,
  });
  function find(value: string, before = compact.length) {
    for (
      let start = compact.lastIndexOf(value, before - value.length);
      start >= 0 && start + value.length <= before;
      start = start > 0 ? compact.lastIndexOf(value, start - 1) : -1
    ) {
      const hit = range(start, value.length);
      const after = segment.text.slice(hit.end);
      if (
        !wordEnd.test(segment.text.slice(0, hit.start)) &&
        (!wordStart.test(after) || particle.test(after))
      )
        return { start, range: hit };
    }
  }
  return { segment, compact, range, find };
}

function locateAddress(segments: Segment[], value: string): Hit[] {
  if (
    !addressFromCustomer(
      segments.map(({ text }) => text),
      value,
    )
  )
    return [];
  const address = value.replace(/\s+/gu, '');
  const indexed = segments.map(indexAddress);
  const units = [...address.matchAll(/\d+(?:동|호|층)/gu)];
  for (let index = indexed.length - 1; index >= 0; index--) {
    const current = indexed[index]!;
    const direct = current.find(address);
    const corrections = [
      ...current.compact.matchAll(/(\d+(?:동|호|층))말고(\d+(?:동|호|층))/dgu),
    ].reverse();
    for (const correction of corrections) {
      const [, from, to] = correction;
      if (!from || !to || from.at(-1) !== to.at(-1)) continue;
      const [newStart, newEnd] = correction.indices![2]!;
      if (direct && direct.start >= newEnd) break;
      if (units.some(([unit]) => unit === from)) return [];
      const replaced = units.filter(([unit]) => unit === to);
      if (replaced.length !== 1) continue;
      const unitStart = replaced[0]!.index!;
      const original =
        address.slice(0, unitStart) +
        from +
        address.slice(unitStart + to.length);
      for (let previous = index; previous >= 0; previous--) {
        const base = indexed[previous]!;
        const source = base.find(
          original,
          previous === index ? correction.index : undefined,
        );
        if (!source) continue;
        // Map the unchanged pieces back to the raw text and omit the superseded unit.
        const old = base.range(source.start + unitStart, from.length);
        return [
          ...[
            { start: source.range.start, end: old.start },
            { start: old.end, end: source.range.end },
          ]
            .filter(({ start, end }) => start < end)
            .map((range) => ({ segment: base.segment, range })),
          {
            segment: current.segment,
            range: current.range(newStart, to.length),
          },
        ];
      }
    }
    if (direct) return [{ segment: current.segment, range: direct.range }];
  }
  return [];
}

function locateClaimName(
  segments: Segment[],
  requestId: string,
  value: string,
): Hit | undefined {
  const latest = segments.filter(({ request_id }) => request_id === requestId);
  const claim = locatePaymentStatement(
    latest.map(({ text }) => text).join('\n'),
  );
  if (claim?.depositor?.name !== value) return;
  let start = claim.depositor.start;
  for (const segment of latest) {
    if (start >= 0 && start + value.length <= segment.text.length)
      return { segment, range: { start, end: start + value.length } };
    start -= segment.text.length + 1;
  }
}

export function extractionSources(
  run: AgentRun,
  messages: Message[],
): ExtractionSource[] {
  if (run.status !== 'succeeded' || !run.analysis) return [];
  const history = new Map(
    run.input.history.flatMap(({ role, request_id, text }) =>
      role === 'customer' ? [[request_id, text] as const] : [],
    ),
  );
  const segments: Segment[] = messages.flatMap((message) =>
    message.role === 'customer' &&
    message.conversation_id === run.conversation_id &&
    history.get(message.request_id) === message.text
      ? customerSegments(message.text).map(({ text, start }) => ({
          text,
          start,
          message_id: message.id,
          request_id: message.request_id,
        }))
      : [],
  );
  const { order_draft: draft, payment_claim: payment } = run.analysis;
  const fields: [ExtractionField, string | null | undefined][] = [
    ['order_draft.recipient.name', draft?.recipient.name],
    ['order_draft.recipient.phone_raw', draft?.recipient.phone_raw],
    ['order_draft.recipient.address_raw', draft?.recipient.address_raw],
    ['order_draft.recipient.postal_code', draft?.recipient.postal_code],
    ['order_draft.depositor_name', draft?.depositor_name],
    ['payment_claim.depositor_name', payment?.depositor_name],
  ];
  return fields.flatMap(([field, raw]) => {
    const value = raw?.trim();
    if (!value) return [];
    const hits =
      field === 'order_draft.recipient.address_raw'
        ? locateAddress(segments, value)
        : [
            field === 'payment_claim.depositor_name'
              ? locateClaimName(segments, run.request_id, value)
              : locateValue(
                  segments,
                  value,
                  field,
                  draft?.recipient.name?.trim() === value,
                ),
          ];
    return hits.flatMap((hit) =>
      hit
        ? [
            {
              field,
              message_id: hit.segment.message_id,
              start: hit.segment.start + hit.range.start,
              end: hit.segment.start + hit.range.end,
            },
          ]
        : [],
    );
  });
}

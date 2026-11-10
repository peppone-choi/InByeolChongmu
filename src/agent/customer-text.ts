import type { RunInput } from './types.js';

export function customerTexts(input: RunInput, latest = false): string[] {
  return input.history
    .filter(
      ({ role, request_id }) =>
        role === 'customer' && (!latest || request_id === input.request_id),
    )
    .flatMap(({ text }) => {
      let customer = true;
      const segments: string[] = [];
      for (const part of text.split(/^(\[고객\]|\[판매자\])/m)) {
        if (part === '[고객]' || part === '[판매자]')
          customer = part === '[고객]';
        else if (customer && part.trim()) segments.push(part);
      }
      return segments;
    });
}

export const compactText = (value: string) =>
  value.normalize('NFKC').replace(/\s+/gu, '');

export function mentionsRecipient(text: string, name: string): boolean {
  const needle = name.normalize('NFKC').trim().toLocaleLowerCase('ko');
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}@_])${escaped}(?:인데요|이에요|예요|이요|요|입니다|님)?(?![\\p{L}\\p{N}_]|\\s*(?:이름으로|명의로))`,
    'u',
  ).test(text.normalize('NFKC').toLocaleLowerCase('ko'));
}

const paymentMention =
  /(?:입금|송금)\s*(?:은\s*)?(?:못\s*했|안\s*했|아직|전이|했|햇|드렸|완료)|(?:[\d,]{4,}(?:\s*원)?|이름으로|명의로)\s*(?:넣었|보냈)/gu;

function isPaymentQuestion(text: string, match: RegExpMatchArray): boolean {
  const ending = text.slice(match.index! + match[0].length);
  return /^(?:나요|는지|는가|습니까|인가요|인지|일까요|을까요|을까|(?:어(?:요|용)?|아요|지(?:요)?|죠|요|습니다|음)?[ \t]*[?？])/u.test(
    ending,
  );
}

export function hasPaymentQuestion(text: string): boolean {
  for (const match of text.matchAll(paymentMention))
    if (isPaymentQuestion(text, match)) return true;
  return false;
}

export function paymentStatement(texts: readonly string[]) {
  const text = texts.join('\n');
  const asserted = (match: RegExpMatchArray) => !isPaymentQuestion(text, match);
  const statements = [...text.matchAll(paymentMention)].filter(asserted);
  const last = statements.at(-1)?.[0];
  if (!last || /못\s*했|안\s*했|아직|전이/u.test(last)) return undefined;
  const names = [
    ...text.matchAll(
      /(?:^|\s)([\p{L}][\p{L}\p{M}·.-]{1,79})\s*(?:이름으로|명의로)\s*(?:[\d,]+\s*(?:원\s*)?)?(?:입금\s*)?(?:했|햇|넣었|보냈|드렸|완료)/gmu,
    ),
  ].filter(asserted);
  const name = names.at(-1)?.[1];
  return {
    depositor_name:
      name && !/^(제|내|본인|남편|아내|가족|친구)$/u.test(name) ? name : null,
    customer_claimed_paid: true as const,
  };
}

export function addressFromCustomer(texts: string[], value: string): boolean {
  const address = compactText(value);
  if (/^\d+(?:동|호|층)$/.test(address)) return false;
  // A later explicit unit correction may complete an address split across turns.
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = compactText(texts[index]!);
    if (text.includes(address)) return true;
    for (const [, from, to] of text.matchAll(
      /(\d+(?:동|호|층))말고(\d+(?:동|호|층))/gu,
    )) {
      if (!from || !to || from.at(-1) !== to.at(-1)) continue;
      const previous = texts.slice(0, index).map(compactText);
      const stale = address.lastIndexOf(from);
      if (
        stale >= 0 &&
        !/\d/.test(address[stale - 1] ?? '') &&
        previous.some((prior) => prior.includes(address))
      )
        return false;
      const offset = address.lastIndexOf(to);
      if (offset < 0 || /\d/.test(address[offset - 1] ?? '')) continue;
      const original =
        address.slice(0, offset) + from + address.slice(offset + to.length);
      if (previous.some((prior) => prior.includes(original))) return true;
    }
  }
  return false;
}

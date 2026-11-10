import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  evaluateResponse,
  evaluationDatasetSchema,
} from '../src/agent/evaluation.js';
import { analysisSchema } from '../src/domain/schema.js';

const readSample = (file: string): unknown =>
  JSON.parse(readFileSync('docs/samples/' + file, 'utf8'));

test('the evaluation manifest covers 40 unique cases and maps fixture attachments to HTTP metadata', () => {
  const { cases } = evaluationDatasetSchema.parse(readSample('dm-cases.json'));
  assert.equal(cases.length, 40);
  assert.deepEqual(
    cases.find((sample) => sample.case_id === 'DM-013')?.input.attachments,
    [{ type: 'image' }],
  );
  assert.equal(
    cases.find((sample) => sample.case_id === 'DM-020')?.input.customer_handle,
    '',
  );
});

test('fixed responses score quantities by SKU and keep draft review separate from automatic checks', () => {
  const { cases } = evaluationDatasetSchema.parse(readSample('dm-cases.json'));
  const expected = cases.find(
    (sample) => sample.case_id === 'DM-002',
  )!.expected;
  const analysis = analysisSchema.parse(readSample('analysis-example.json'));
  const response = {
    analysis,
    conversation_id: 'sample-room',
    replayed: false,
  };
  analysis.order_draft!.items.reverse();

  const correct = evaluateResponse(expected, 200, response, true);
  assert.ok(Object.values(correct.checks).every(Boolean));
  assert.equal(correct.outcome, 'manual_review');

  analysis.order_draft!.items[0]!.quantity = 2;
  analysis.order_draft!.recipient.name = null;
  const mismatch = evaluateResponse(expected, 200, response, false);
  assert.equal(mismatch.outcome, 'failed');
  assert.equal(mismatch.checks.quantities, false);
  assert.equal(mismatch.checks['extracted_fields.recipient.name'], false);
  assert.equal(mismatch.checks.sources_unchanged, false);
});

test('an HTTP rejection without an analysis cannot satisfy analysis expectations', () => {
  const { cases } = evaluationDatasetSchema.parse(readSample('dm-cases.json'));
  const expected = cases.find(
    (sample) => sample.case_id === 'DM-020',
  )!.expected;
  const result = evaluateResponse(
    expected,
    422,
    { error: { code: 'INVALID_INPUT' } },
    true,
  );
  assert.equal(result.outcome, 'failed');
  assert.equal(result.checks.http_status, true);
  assert.equal(result.checks.classification, false);
  assert.equal(result.model_calls, null);
  assert.equal(result.error_code, 'INVALID_INPUT');
});

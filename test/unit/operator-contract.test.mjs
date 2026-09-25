import test from 'node:test';
import assert from 'node:assert/strict';
import { CHATGPT_WORK_CAPABILITIES, englishOperatorInstruction } from '../../lib/operator-contract.js';
import { createOperatorReceipt } from '../../lib/operator-receipt.js';

test('operator manifest enables agreed autonomous feature-branch work', () => {
  assert.equal(CHATGPT_WORK_CAPABILITIES.language, 'en-US');
  assert.equal(CHATGPT_WORK_CAPABILITIES.autonomy.feature_branch_edits, true);
  assert.equal(CHATGPT_WORK_CAPABILITIES.autonomy.feature_branch_commits, true);
  assert.equal(CHATGPT_WORK_CAPABILITIES.autonomy.builds, true);
  assert.equal(CHATGPT_WORK_CAPABILITIES.autonomy.tests, true);
});

test('English operator instruction covers user-facing surfaces', () => {
  const prompt = englishOperatorInstruction();
  assert.match(prompt, /English/);
  assert.match(prompt, /approval/i);
  assert.match(prompt, /receipts/i);
});

test('receipt is explicitly reviewable evidence, not implicit verification', () => {
  const receipt = createOperatorReceipt({
    session_id:'s1',status:'completed',summary:'Implemented',
    changed_files:['src/a.ts'],commits:['abc'],tests:[],builds:[],tool_operations:[],unresolved:[],review_ready:true,
  });
  assert.equal(receipt.language,'en-US');
  assert.equal(receipt.review_ready,true);
});

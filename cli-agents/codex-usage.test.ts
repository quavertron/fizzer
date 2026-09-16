import test from 'node:test';
import assert from 'node:assert/strict';
import { codexUsageStats } from './cli-agent.js';

test('Codex last request and cumulative usage stay distinct; cache is a subset', () => {
  const stats = codexUsageStats({last: {inputTokens:100, cachedInputTokens:80, outputTokens:7, totalTokens:107}, total:{inputTokens:900, cachedInputTokens:700, outputTokens:50}, modelContextWindow:1000});
  assert.equal(stats.usageScope, 'request');
  assert.equal(stats.contextUsed,100);
  assert.equal(stats.inputTokens,100);
  assert.equal(stats.uncachedInputTokens,20);
  assert.equal(stats.cumulativeInputTokens,900);
  assert.equal(stats.cumulativeCachedInputTokens,700);
  assert.equal(stats.contextWindow,1000);
});
test('Cumulative-only receipt never becomes per-request cost or context occupancy', () => {
  const stats=codexUsageStats({total_token_usage:{input_tokens:900,cached_input_tokens:700,output_tokens:50}});
  assert.equal(stats.usageScope,'session');
  assert.equal(stats.inputTokens,undefined);
  assert.equal(stats.contextUsed,undefined);
  assert.equal(stats.cumulativeInputTokens,900);
});
test('Flat turn totals keep their declared scope; reasoning is not added to output again', () => {
  const stats=codexUsageStats({input_tokens:100,cached_input_tokens:80,output_tokens:7,reasoning_output_tokens:5,total_tokens:107},'turn');
  assert.equal(stats.outputTokens,7);
  assert.equal(stats.usageScope,'turn');
  assert.equal(stats.contextUsed,undefined);
  assert.equal(stats.uncachedInputTokens,20);
});

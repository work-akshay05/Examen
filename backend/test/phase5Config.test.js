import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = { JWT_SECRET: 'a-test-secret-that-is-at-least-32-characters-long', NODE_ENV: 'test' };

test('Phase 5 configuration defaults to honest GST-unavailable and labeled mock Tally providers', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.GST_VERIFICATION_PROVIDER, 'none');
  assert.equal(config.TALLY_PROVIDER, 'mock');
  assert.deepEqual(config.TALLY_MOCK_RECORDS, []);
  assert.equal(config.OPENAI_MODEL, 'gpt-4.1-mini');
});

test('mock Tally fixtures are parsed as structured records and invalid JSON is rejected', () => {
  const record = { id: 'fixture', invoiceNumber: 'INV-1', vendor: { name: 'Example' } };
  const config = loadConfig({ ...baseEnv, TALLY_MOCK_RECORDS: JSON.stringify([record]) });
  assert.deepEqual(config.TALLY_MOCK_RECORDS, [record]);
  assert.throws(() => loadConfig({ ...baseEnv, TALLY_MOCK_RECORDS: 'not-json' }), /TALLY_MOCK_RECORDS/);
});

test('missing OpenAI credentials remain an optional configuration state', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.OPENAI_API_KEY, undefined);
});

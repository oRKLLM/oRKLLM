import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeaders, toolName } from '../src/mcp.js';

describe('resolveHeaders', () => {
  test('none / undefined → no auth headers', () => {
    assert.deepEqual(resolveHeaders({ auth: { type: 'none' } }), {});
    assert.deepEqual(resolveHeaders({}), {});
  });

  test('bearer → Authorization: Bearer <token>', () => {
    assert.deepEqual(resolveHeaders({ auth: { type: 'bearer', token: 'abc.def' } }), {
      Authorization: 'Bearer abc.def',
    });
  });

  test('bearer with empty token → no header', () => {
    assert.deepEqual(resolveHeaders({ auth: { type: 'bearer', token: '' } }), {});
  });

  test('apikey → custom header name/value', () => {
    assert.deepEqual(resolveHeaders({ auth: { type: 'apikey', headerName: 'X-API-Key', value: 'k123' } }), {
      'X-API-Key': 'k123',
    });
  });

  test('basic → base64(user:pass)', () => {
    const out = resolveHeaders({ auth: { type: 'basic', username: 'u', password: 'p' } });
    assert.equal(out.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  test('custom → headers map passed through', () => {
    assert.deepEqual(resolveHeaders({ auth: { type: 'custom', headers: { 'X-A': '1', 'X-B': '2' } } }), {
      'X-A': '1', 'X-B': '2',
    });
  });

  test('legacy plain headers map still works (no auth)', () => {
    assert.deepEqual(resolveHeaders({ headers: { Authorization: 'Bearer legacy' } }), {
      Authorization: 'Bearer legacy',
    });
  });

  test('explicit headers override auth-derived headers', () => {
    const out = resolveHeaders({ auth: { type: 'bearer', token: 'x' }, headers: { Authorization: 'override' } });
    assert.equal(out.Authorization, 'override');
  });
});

describe('toolName', () => {
  test('namespaces and sanitizes', () => {
    assert.equal(toolName({ name: 'My Server' }, 'do.thing'), 'mcp__My_Server__do_thing');
  });
});

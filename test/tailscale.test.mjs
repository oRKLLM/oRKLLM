import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serveUrlFromDNSName, summarizeStatus, scrubKey } from '../src/tailscale.js';

describe('serveUrlFromDNSName', () => {
  test('strips the trailing dot and prefixes https', () => {
    assert.equal(serveUrlFromDNSName('khazad-dum.tail1234.ts.net.'), 'https://khazad-dum.tail1234.ts.net');
  });
  test('works without a trailing dot', () => {
    assert.equal(serveUrlFromDNSName('host.tail.ts.net'), 'https://host.tail.ts.net');
  });
  test('null/empty → null', () => {
    assert.equal(serveUrlFromDNSName(null), null);
    assert.equal(serveUrlFromDNSName(''), null);
  });
});

describe('summarizeStatus', () => {
  test('Running node with Self.DNSName → loggedIn + serveUrl', () => {
    const s = summarizeStatus({ BackendState: 'Running', Self: { DNSName: 'board.tail.ts.net.' } });
    assert.equal(s.loggedIn, true);
    assert.equal(s.backendState, 'Running');
    assert.equal(s.serveUrl, 'https://board.tail.ts.net');
  });
  test('Stopped node → not logged in', () => {
    const s = summarizeStatus({ BackendState: 'Stopped', Self: {} });
    assert.equal(s.loggedIn, false);
    assert.equal(s.serveUrl, null);
  });
  test('null status → safe defaults', () => {
    assert.deepEqual(summarizeStatus(null), { loggedIn: false, backendState: null, dnsName: null, serveUrl: null });
  });
});

describe('scrubKey', () => {
  test('redacts the auth key wherever it appears', () => {
    assert.equal(scrubKey('failed using tskey-abc123 to auth', 'tskey-abc123'), 'failed using tskey-*** to auth');
  });
  test('no key → message unchanged', () => {
    assert.equal(scrubKey('some error', null), 'some error');
  });
});

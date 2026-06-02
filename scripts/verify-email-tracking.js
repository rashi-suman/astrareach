'use strict';
/**
 * Quick sanity check for injectTracking (no server/Redis).
 * Run: node scripts/verify-email-tracking.js
 */
const assert = require('assert');
const { injectTracking } = require('../services/trackingService');

const ccId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const booking = 'https://book.example.com/call';

function runCase(label, html, checks) {
  const out = injectTracking(html, ccId, booking, false);
  for (const [msg, fn] of checks) {
    assert.ok(fn(out), `${label}: ${msg}`);
  }
}

runCase('double-quoted lowercase href', '<html><body><a href="https://a.com/x">Go</a></body></html>', [
  ['click redirect present', (o) => o.includes(`/t/c/${ccId}`) && o.includes('https%3A%2F%2Fa.com%2Fx')],
  ['open pixel before body close', (o) => /\/t\/o\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.test(o)],
]);

runCase('uppercase HREF', '<html><body><A HREF="https://b.com/y">Go</A></body></html>', [
  ['wrapped uppercase link', (o) => o.includes(`/t/c/${ccId}`) && o.includes('b.com')],
]);

runCase('single-quoted href', "<html><body><a href='https://c.com/z'>Go</a></body></html>", [
  ['single-quote href wrapped', (o) => o.includes(`/t/c/${ccId}`) && o.includes('c.com')],
]);

runCase('href with spaces', '<html><body><a href = "https://d.com/">Go</a></body></html>', [
  ['spaced href wrapped', (o) => o.includes(`/t/c/${ccId}`) && o.includes('d.com')],
]);

runCase('booking link type', `<html><body><a href="${booking}">Book</a></body></html>`, [
  ['booked type in redirect', (o) => o.includes('type=booked')],
]);

// Already-wrapped links must not double-wrap
const pre = `<html><body><a href="http://localhost:3000/t/c/${ccId}?u=test">x</a></body></html>`;
assert.ok(injectTracking(pre, ccId, '', false).includes('href="http://localhost:3000/t/c/'), 'no double-wrap');

console.log('verify-email-tracking: all assertions passed');

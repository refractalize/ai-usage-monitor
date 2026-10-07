import assert from 'node:assert/strict';
import test from 'node:test';
import { dayAt } from '../server/analytics.ts';
import { displayTimeZone, validTimeZone } from '../server/timezone.ts';

test('browser timezone takes precedence; invalid input safely falls back', () => {
  assert.equal(
    displayTimeZone('http://localhost/?tz=America%2FLos_Angeles', 'UTC'),
    'America/Los_Angeles',
  );
  assert.equal(displayTimeZone('http://localhost/?tz=invalid', 'Europe/Paris'), 'Europe/Paris');
  assert.equal(displayTimeZone('http://localhost/', 'invalid'), 'UTC');
  assert.equal(validTimeZone(''), null);
});
test('local date boundaries follow the viewer and daylight-saving transitions', () => {
  const winter = Date.parse('2026-01-05T07:30:00Z') / 1000;
  assert.equal(dayAt(winter, 'America/Los_Angeles'), '2026-01-04');
  assert.equal(dayAt(winter, 'UTC'), '2026-01-05');
  const summer = Date.parse('2026-07-05T07:30:00Z') / 1000;
  assert.equal(dayAt(summer, 'America/Los_Angeles'), '2026-07-05');
});

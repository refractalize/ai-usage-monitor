import assert from 'node:assert/strict';
import test from 'node:test';
import { dayAt } from '../server/analytics.ts';

test('local date boundaries follow the viewer and daylight-saving transitions', () => {
  const winter = Date.parse('2026-01-05T07:30:00Z') / 1000;
  assert.equal(dayAt(winter, 'America/Los_Angeles'), '2026-01-04');
  assert.equal(dayAt(winter, 'UTC'), '2026-01-05');
  const summer = Date.parse('2026-07-05T07:30:00Z') / 1000;
  assert.equal(dayAt(summer, 'America/Los_Angeles'), '2026-07-05');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMemory, memoryEnvironment, memoryWarning, memoryBudget, recommendSegment, estimateCutMemory } from '../src/memory.js';

test('estimates grow with files and conversion overhead', () => {
  assert.equal(estimateMemory(100e6, 0), 656e6);
  assert.ok(estimateMemory(100e6, 50e6) > estimateMemory(100e6, 0));
  assert.ok(estimateMemory(100e6, 50e6, true) > estimateMemory(100e6, 50e6));
});

test('iPhone, iPad and desktop-mode iPad use the requested 1.5 GB threshold', () => {
  for (const device of [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) {
    const environment = memoryEnvironment(device);
    assert.equal(environment.isIOS, true);
    assert.equal(memoryWarning(1.5e9, environment), '');
    assert.match(memoryWarning(1.5e9 + 1, environment), /解像度を下げるか分割してください/);
  }
  assert.equal(memoryEnvironment({ platform: 'MacIntel', maxTouchPoints: 0 }).isIOS, false);
});

test('device memory is approximate GiB, not available RAM', () => {
  const environment = memoryEnvironment({ deviceMemory: 4 });
  assert.equal(environment.deviceBytes, 4 * 1024 ** 3);
  assert.match(memoryWarning(environment.deviceBytes, environment), /処理目安/);
  assert.match(memoryWarning(environment.deviceBytes + 1, environment), /端末のメモリ容量/);
  for (const deviceMemory of [undefined, 0, -1, NaN, Infinity]) {
    const unknown = memoryEnvironment({ deviceMemory });
    assert.equal(unknown.deviceBytes, null);
    assert.equal(memoryWarning(2e9, unknown), '');
  }
});

test('warns before total RAM is exhausted and caps unknown devices', () => {
  const phone = memoryEnvironment({ userAgent: 'Android', deviceMemory: 4 });
  assert.equal(memoryBudget(phone), 1e9);
  assert.match(memoryWarning(1.1e9, phone), /処理目安/);
  assert.match(memoryWarning(3e9, memoryEnvironment({})), /処理目安/);
  assert.match(memoryWarning(600e6, memoryEnvironment({ userAgent: 'iPhone' }),
    { width: 3840, height: 2160, transcode: true }), /高解像度/);
});

test('recommended seconds account for duration, file size, RAM and headroom', () => {
  const environment = memoryEnvironment({ userAgent: 'iPhone' });
  const plan = recommendSegment(2e9, 600, environment, { kind: 'video' });
  assert.ok(plan.count > 3);
  assert.ok(estimateCutMemory(2e9, 600, plan.seconds) <= plan.target);
  assert.ok(recommendSegment(4e9, 600, environment).seconds < plan.seconds);
  assert.ok(recommendSegment(2e9, 1200, environment).seconds > plan.seconds);
  assert.ok(recommendSegment(2e9, 600, memoryEnvironment({ deviceMemory: 1 })).seconds < plan.seconds);
  assert.equal(recommendSegment(1e9, NaN, environment), null);
  assert.equal(recommendSegment(1e9, 0, environment), null);
  assert.equal(recommendSegment(100, 0.5, environment).seconds, 0.5);
  assert.equal(recommendSegment(1e9, 600, memoryEnvironment({ deviceMemory: 0.5 })).feasible, false);
});

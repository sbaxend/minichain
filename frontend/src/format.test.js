import { describe, expect, test } from 'vitest';
import { bestNode, formatWork, hashPrefix, relationToBest, shortHash, splitLeadingZeros, timeAgo } from './format.js';
import { networkFixture } from './test/fixtures.js';

describe('format helpers', () => {
  test('shortHash keeps the start and end', () => {
    expect(shortHash('0123456789abcdef0123456789')).toBe('0123456789…456789');
    expect(shortHash('abc')).toBe('abc');
    expect(shortHash(undefined)).toBe('');
  });

  test('shortHash with tail 0 does not return the whole hash', () => {
    expect(shortHash('0123456789abcdef0123456789', 4, 0)).toBe('0123…');
  });

  test('hashPrefix', () => {
    expect(hashPrefix('006a3f77abcd')).toBe('006a3f');
  });

  test('splitLeadingZeros separates the proof-of-work prefix', () => {
    expect(splitLeadingZeros('000abc')).toEqual(['000', 'abc']);
    expect(splitLeadingZeros('abc')).toEqual(['', 'abc']);
  });

  test('formatWork handles BigInt strings', () => {
    expect(formatWork('123456789012345678901234567890')).toBe('123,456,789,012,345,678,901,234,567,890');
    expect(formatWork('not a number')).toBe('not a number');
  });

  test('timeAgo', () => {
    expect(timeAgo(10_000, 15_000)).toBe('5s ago');
    expect(timeAgo(0, 15_000)).toBe('');
    expect(timeAgo(0 + 1, 1 + 120_000)).toBe('2m ago');
  });

  test('bestNode picks most work; relationToBest detects forks', () => {
    const { nodes } = networkFixture({ forked: true });
    const best = bestNode(nodes);
    expect(best.id).toBe('alice'); // ties go to the first node
    expect(relationToBest(nodes[1], best)).toBe('synced');
    expect(relationToBest(nodes[2], best)).toBe('diverged');
    const behind = { ...nodes[0], tipHash: nodes[0].recent[1].hash };
    expect(relationToBest(behind, best)).toBe('behind');
  });
});

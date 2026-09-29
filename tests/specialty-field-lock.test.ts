import { describe, expect, it } from 'vitest';
import { boxDistance, pickLockTarget, type LockBox } from '@/lib/specialty-field-lock';

const box = (x: number, y: number, w = 100, h = 24): LockBox => ({ x, y, w, h });

describe('pickLockTarget — the word you are heading for stops, it does not flee', () => {
  const boxes = [box(100, 100), box(300, 100), box(100, 200)];

  it('is -1 with no pointer, or nothing within reach', () => {
    expect(pickLockTarget(boxes, null, -1)).toBe(-1);
    expect(pickLockTarget(boxes, { x: 700, y: 700 }, -1)).toBe(-1);
  });

  it('locks the nearest word once the pointer is within reach', () => {
    expect(pickLockTarget(boxes, { x: 190, y: 100 }, -1)).toBe(0);
    expect(pickLockTarget(boxes, { x: 250, y: 105 }, -1)).toBe(1);
  });

  it('standing on a word always wins, even over the current lock', () => {
    expect(pickLockTarget(boxes, { x: 300, y: 100 }, 0)).toBe(1);
  });

  it('holds the lock across the gap between words instead of flickering', () => {
    // 60px from word 0's box edge is inside the release distance: still word 0.
    const p = { x: 100 + 50 + 60, y: 100 };
    expect(pickLockTarget(boxes, p, 0)).toBe(0);
  });

  it('lets go once the pointer has clearly moved away', () => {
    expect(pickLockTarget(boxes, { x: 100 + 50 + 130, y: 400 }, 0)).toBe(-1);
  });

  it('switches early only when a rival is far nearer than the locked word', () => {
    // Pointer between word 0 (locked) and word 1, much closer to word 1's box.
    const p = { x: 235, y: 100 };
    expect(boxDistance(boxes[1], p.x, p.y)).toBeLessThan(boxDistance(boxes[0], p.x, p.y) * 0.5);
    expect(pickLockTarget(boxes, p, 0)).toBe(1);
  });

  it('approaching a word never hands the lock to a different word on the way in', () => {
    // Walk the pointer straight at word 1 from the right; the lock must be word 1 the whole way
    // once it is acquired, and must never be lost before the pointer is on it.
    let locked = -1;
    for (let x = 460; x >= 300; x -= 4) {
      locked = pickLockTarget(boxes, { x, y: 100 }, locked);
      if (x <= 300 + 50 + 60) expect(locked).toBe(1);
    }
    expect(locked).toBe(1);
  });
});

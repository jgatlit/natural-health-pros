/**
 * Which specialty the cursor is "on" — decided once per pointer move, with hysteresis.
 *
 * WHY THIS EXISTS. The field used to shove every word within 150px of the cursor AWAY from it. That
 * is exactly backwards for a list you are meant to click: the nearer you got to the word you wanted,
 * the faster it left. The fix is not a weaker push, it is a different rule per element:
 *
 *   • the word the cursor is heading for is LOCKED — it stops, and never moves while it is locked;
 *   • every other word makes ROOM for it (they move away from the locked word, not from the cursor),
 *     so the spread is kept without anything running from the pointer.
 *
 * "Heading for" is the word whose box is nearest the pointer, within `reach`. Two things keep the
 * lock from flickering as the pointer crosses the gaps between words: the current lock is held
 * until the pointer is `release` px away, and a rival only takes over early when the pointer is
 * actually over it, or is much nearer to it than to the locked word.
 */

export type LockBox = { x: number; y: number; w: number; h: number };

export const LOCK_REACH = 64;
export const LOCK_RELEASE = 82;

/** Distance from a point to a centred box; 0 when the point is inside it. */
export function boxDistance(box: LockBox, px: number, py: number): number {
  const dx = Math.max(Math.abs(box.x - px) - box.w / 2, 0);
  const dy = Math.max(Math.abs(box.y - py) - box.h / 2, 0);
  return Math.hypot(dx, dy);
}

export function pickLockTarget(
  boxes: readonly LockBox[],
  pointer: { x: number; y: number } | null,
  locked: number,
  reach = LOCK_REACH,
  release = LOCK_RELEASE,
): number {
  if (!pointer) return -1;

  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const d = boxDistance(boxes[i], pointer.x, pointer.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }

  const lockedD = locked >= 0 && boxes[locked] ? boxDistance(boxes[locked], pointer.x, pointer.y) : Infinity;

  // Standing on a word always wins, whatever was locked before.
  if (bestD === 0) return best;
  // Otherwise keep the current lock while the pointer is still close, unless a rival is far nearer.
  if (locked >= 0 && lockedD <= release && !(bestD < lockedD * 0.5 - 4)) return locked;
  return bestD <= reach ? best : -1;
}

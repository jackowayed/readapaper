/** Pure arithmetic char-offset ↔ fraction mapping (unified progress, v1).
 *
 * v1 is intentionally DOM-free: read mode renders sanitized HTML while TTS
 * consumes plain `text`, so exact HTML↔text alignment needs markers we don't
 * have yet. `fraction * text.length` is coarse but predictable.
 */

function safeLength(textLength: number): number {
  if (!Number.isFinite(textLength) || textLength <= 0) return 0;
  return Math.floor(textLength);
}

/** Clamp a char offset to `[0, textLength]`; rounds, empty text → 0, NaN → 0. */
export function clampOffset(offset: number, textLength: number): number {
  const len = safeLength(textLength);
  if (len === 0) return 0;
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.round(offset), 0), len);
}

/** Canonical offset → derived `progress` mirror (`offset / max(1, len)`). */
export function offsetToFraction(offset: number, textLength: number): number {
  const len = safeLength(textLength);
  if (len === 0) return 0;
  return clampOffset(offset, len) / len;
}

/** Derived `progress` mirror → canonical char offset. */
export function fractionToOffset(fraction: number, textLength: number): number {
  const len = safeLength(textLength);
  if (len === 0) return 0;
  if (!Number.isFinite(fraction)) return 0;
  return clampOffset(Math.round(fraction * len), len);
}

// ── useBlink hook (CC-aligned: returns [ref, isVisible]) ──
// Based on CC 2.1.88 vendor/cc-tui/hooks/useBlink.ts
// Adapted: uses setInterval (no ClockContext in TriRLC Ink setup),
//           but returns [ref, isVisible] matching CC API signature.
import { useState, useEffect, useRef, useCallback } from 'react';
import type { DOMElement } from '../fork.js';

const BLINK_INTERVAL_MS = 600;

export function useBlink(
  enabled: boolean,
  intervalMs: number = BLINK_INTERVAL_MS,
): [ref: (element: DOMElement | null) => void, isVisible: boolean] {
  const [isVisible, setIsVisible] = useState(true);
  const elementRef = useRef<DOMElement | null>(null);

  const ref = useCallback((element: DOMElement | null) => {
    elementRef.current = element;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsVisible(true); // solid when not blinking
      return;
    }
    const id = setInterval(() => setIsVisible(v => !v), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  return [ref, isVisible];
}

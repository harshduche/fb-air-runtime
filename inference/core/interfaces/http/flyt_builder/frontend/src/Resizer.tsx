// Vertical gutter that resizes the adjacent panel width. Mousedown on
// the gutter captures document mouse events until mouseup, translating
// deltaX into width updates on the parent state.

import { useCallback, useEffect, useRef } from "react";

type Props = {
  /** Current width of the panel this gutter resizes. */
  width: number;
  onChange: (next: number) => void;
  /** Minimum / maximum pixels. */
  min?: number;
  max?: number;
  /** "left" = drag right grows the left-hand panel.
   *  "right" = drag right shrinks the right-hand panel (gutter sits on
   *  its left edge). */
  side: "left" | "right";
};

export function Resizer({ width, onChange, min = 180, max = 640, side }: Props) {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const s = startRef.current;
      if (!s) return;
      const delta = e.clientX - s.x;
      const next = side === "left" ? s.w + delta : s.w - delta;
      onChange(Math.max(min, Math.min(max, next)));
    },
    [onChange, min, max, side],
  );

  const onMouseUp = useCallback(() => {
    startRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, w: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return <div className="resizer" onMouseDown={onMouseDown} />;
}

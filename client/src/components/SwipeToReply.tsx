import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Reply } from 'lucide-react';

/** Swipe-left → reply (mobile/touch). Touch/pen only so desktop drag-select stays clean. */
const SWIPE_REPLY_MAX = 72;
const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_AXIS_SLOP = 12;

/** Active horizontal swipe count — virtualization must not unmount mid-capture. */
let activeSwipeGestures = 0;
function beginSwipeGesture(): void {
  activeSwipeGestures += 1;
}
function endSwipeGesture(): void {
  activeSwipeGestures = Math.max(0, activeSwipeGestures - 1);
}
export function swipeGestureActive(): boolean {
  return activeSwipeGestures > 0;
}

/**
 * DOM-driven swipe: no React setState during vertical pan or per-frame drag.
 * Horizontal capture must always release: unmount mid-swipe (list virtualization)
 * or a lost pointerup can leave the app unclickable until restart.
 */
export function SwipeToReply({
  onReply,
  children,
  className = '',
  style,
  title,
  messageId,
  onClick,
  onContextMenu,
  allowSwipeFrom,
}: {
  onReply: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  messageId?: string;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Interactive row surfaces that should still start a swipe (for example, a fold toggle). */
  allowSwipeFrom?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const axisRef = useRef<'h' | 'v' | null>(null);
  const offsetRef = useRef(0);
  const armedRef = useRef(false);
  const capturingRef = useRef(false);
  const finishedRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const windowEndRef = useRef<(() => void) | null>(null);

  const paint = useCallback((offset: number, dragging: boolean) => {
    const content = contentRef.current;
    const hint = hintRef.current;
    const root = rootRef.current;
    if (content) {
      content.style.transition = dragging ? 'none' : 'transform 160ms ease-out';
      content.style.transform = offset ? `translate3d(${-offset}px, 0, 0)` : '';
    }
    if (hint) {
      const progress = Math.min(1, offset / SWIPE_REPLY_THRESHOLD);
      hint.style.opacity = String(progress);
      hint.style.transform = `scale(${0.75 + progress * 0.25})`;
    }
    if (root) {
      root.classList.toggle('is-dragging', dragging);
      const armed = offset >= SWIPE_REPLY_THRESHOLD;
      if (armed !== armedRef.current) {
        armedRef.current = armed;
        root.classList.toggle('is-armed', armed);
      }
    }
  }, []);

  const releaseCapture = useCallback((pointerId?: number) => {
    const root = rootRef.current;
    if (!root || pointerId == null) return;
    try {
      if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId);
    } catch { /* ignore */ }
  }, []);

  const detachWindowEnd = useCallback(() => {
    windowEndRef.current?.();
    windowEndRef.current = null;
  }, []);

  const completeGesture = useCallback((committed: boolean, animate: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const pointerId = startRef.current?.pointerId;
    releaseCapture(pointerId);
    if (capturingRef.current) {
      capturingRef.current = false;
      endSwipeGesture();
    }
    detachWindowEnd();
    startRef.current = null;
    axisRef.current = null;
    offsetRef.current = 0;
    if (!animate) {
      paint(0, false);
    } else {
      paint(0, true);
      requestAnimationFrame(() => paint(0, false));
    }
    if (committed) {
      // A successful drag that began on a fold button must not also toggle it.
      // Browser-generated click follows pointerup in the same task. Clear on
      // the next task so a deliberate tap immediately afterward still works.
      suppressNextClickRef.current = true;
      window.setTimeout(() => { suppressNextClickRef.current = false; }, 0);
      try { navigator.vibrate?.(12); } catch { /* ignore */ }
      onReply();
    }
  }, [detachWindowEnd, onReply, paint, releaseCapture]);

  useEffect(() => () => {
    finishedRef.current = true;
    const start = startRef.current;
    releaseCapture(start?.pointerId);
    if (capturingRef.current) {
      capturingRef.current = false;
      endSwipeGesture();
    }
    detachWindowEnd();
  }, [detachWindowEnd, releaseCapture]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    const interactive = target?.closest('a, button, input, textarea, select, .cascade-run-panel, pre, code');
    const allowed = allowSwipeFrom ? target?.closest(allowSwipeFrom) : null;
    if (interactive && !allowed) return;
    // Only the innermost reply surface should own a nested mission/trace gesture.
    event.stopPropagation();
    finishedRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    axisRef.current = null;
    offsetRef.current = 0;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || event.pointerId !== start.pointerId || finishedRef.current) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!axisRef.current) {
      if (Math.abs(dx) < SWIPE_AXIS_SLOP && Math.abs(dy) < SWIPE_AXIS_SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        axisRef.current = 'v';
        startRef.current = null;
        return;
      }
      axisRef.current = 'h';
      if (!capturingRef.current) {
        capturingRef.current = true;
        beginSwipeGesture();
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch { /* ignore */ }
      detachWindowEnd();
      const pointerId = event.pointerId;
      const onWinEnd = (ev: Event) => {
        const pe = ev as PointerEvent;
        if ('pointerId' in pe && pe.pointerId !== pointerId) return;
        const committed = ev.type === 'pointerup'
          && axisRef.current === 'h'
          && offsetRef.current >= SWIPE_REPLY_THRESHOLD;
        completeGesture(committed, true);
      };
      window.addEventListener('pointerup', onWinEnd, true);
      window.addEventListener('pointercancel', onWinEnd, true);
      window.addEventListener('blur', onWinEnd);
      windowEndRef.current = () => {
        window.removeEventListener('pointerup', onWinEnd, true);
        window.removeEventListener('pointercancel', onWinEnd, true);
        window.removeEventListener('blur', onWinEnd);
      };
    }
    if (axisRef.current !== 'h') return;
    const next = Math.max(0, Math.min(SWIPE_REPLY_MAX, -dx));
    offsetRef.current = next;
    paint(next, true);
    event.preventDefault();
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || event.pointerId !== start.pointerId) {
      releaseCapture(event.pointerId);
      return;
    }
    const committed = axisRef.current === 'h' && offsetRef.current >= SWIPE_REPLY_THRESHOLD;
    completeGesture(committed, true);
  };

  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (start && event.pointerId === start.pointerId) completeGesture(false, true);
    else releaseCapture(event.pointerId);
  };

  return (
    <div
      ref={rootRef}
      className={`chat-swipe-row ${className}`}
      data-message-id={messageId}
      style={style}
      title={title}
      aria-label={title}
      role={title ? 'group' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (!windowEndRef.current && !finishedRef.current && (capturingRef.current || startRef.current)) {
          completeGesture(false, false);
        }
      }}
      onClickCapture={(event) => {
        if (!suppressNextClickRef.current) return;
        suppressNextClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div ref={hintRef} className="chat-swipe-reply-hint" aria-hidden="true">
        <Reply size={16} />
      </div>
      <div ref={contentRef} className="chat-swipe-content">
        {children}
      </div>
    </div>
  );
}

/**
 * useBehavioralDetection.ts
 * ─────────────────────────────────────────────────────────────────
 * Attaches real browser-native event listeners to detect proctoring
 * violations automatically — no manual simulation buttons needed.
 *
 * Detects:
 *   • Tab switch / window blur (via visibilitychange + blur/focus)
 *   • Copy/paste clipboard activity
 *   • Fullscreen exit (after the exam requests fullscreen)
 *   • Right-click attempts (context menu blocked + flagged)
 *
 * Debounce:
 *   All events are debounced by type — if the same event fires
 *   multiple times within DEBOUNCE_MS (1000ms), only the first
 *   one sends a WebSocket message to the backend.
 *
 * Lifecycle:
 *   Monitoring only starts when `startMonitoring()` is called
 *   (triggered by the "Start Exam" button in ExamPage). This
 *   prevents events from firing before the student is ready.
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { BehavioralEventType, ClipboardPayload } from '../types';

/** Minimum interval between same-type events (ms) */
const DEBOUNCE_MS = 1000;

/** Current state of each monitored signal */
export interface MonitoringState {
  /** Whether monitoring is actively listening for events */
  active: boolean;
  /** Whether the tab/window currently has focus */
  tabFocused: boolean;
  /** Whether the browser is currently in fullscreen mode */
  isFullscreen: boolean;
  /** Last clipboard action detected, if any */
  lastClipboard: { action: 'copy' | 'paste'; timestamp: string } | null;
  /** Count of right-click attempts blocked */
  rightClickCount: number;
}

interface UseBehavioralDetectionOptions {
  /** Function to send events over WebSocket — from useWebSocket hook */
  sendEvent: (type: BehavioralEventType, payload?: ClipboardPayload) => void;
  /** Current WebSocket connection status */
  wsStatus: string;
}

export function useBehavioralDetection({ sendEvent, wsStatus }: UseBehavioralDetectionOptions) {
  const [state, setState] = useState<MonitoringState>({
    active: false,
    tabFocused: true,
    isFullscreen: false,
    lastClipboard: null,
    rightClickCount: 0,
  });

  // Track debounce timestamps per event type
  const lastFiredRef = useRef<Record<string, number>>({});
  // Track whether monitoring is active (ref for use in callbacks)
  const activeRef = useRef(false);

  /**
   * Debounced event sender — skips if the same event type was sent
   * within the last DEBOUNCE_MS milliseconds.
   */
  const sendDebounced = useCallback(
    (type: BehavioralEventType, payload?: ClipboardPayload) => {
      if (!activeRef.current) return;
      if (wsStatus !== 'open') return;

      const now = Date.now();
      const key = payload ? `${type}:${payload.action}` : type;
      const lastFired = lastFiredRef.current[key] ?? 0;

      if (now - lastFired < DEBOUNCE_MS) return; // debounced — skip

      lastFiredRef.current[key] = now;
      sendEvent(type, payload);
    },
    [sendEvent, wsStatus]
  );

  // ─── Attach all event listeners when monitoring is active ─────────────────
  useEffect(() => {
    if (!state.active) return;

    // ── Tab visibility / focus ───────────────────────────────────────────
    const onVisibilityChange = () => {
      if (document.hidden) {
        setState((s) => ({ ...s, tabFocused: false }));
        sendDebounced('tab_switch');
      } else {
        setState((s) => ({ ...s, tabFocused: true }));
      }
    };

    const onBlur = () => {
      setState((s) => ({ ...s, tabFocused: false }));
      sendDebounced('tab_switch');
    };

    const onFocus = () => {
      setState((s) => ({ ...s, tabFocused: true }));
    };

    // ── Clipboard ────────────────────────────────────────────────────────
    const onCopy = () => {
      const timestamp = new Date().toISOString();
      setState((s) => ({ ...s, lastClipboard: { action: 'copy', timestamp } }));
      sendDebounced('clipboard_activity', { action: 'copy' });
    };

    const onPaste = () => {
      const timestamp = new Date().toISOString();
      setState((s) => ({ ...s, lastClipboard: { action: 'paste', timestamp } }));
      sendDebounced('clipboard_activity', { action: 'paste' });
    };

    // ── Fullscreen ───────────────────────────────────────────────────────
    const onFullscreenChange = () => {
      const isFs = !!document.fullscreenElement;
      setState((s) => ({ ...s, isFullscreen: isFs }));
      if (!isFs && activeRef.current) {
        sendDebounced('fullscreen_exit');
      }
    };

    // ── Right-click ──────────────────────────────────────────────────────
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setState((s) => ({ ...s, rightClickCount: s.rightClickCount + 1 }));
      sendDebounced('right_click_attempt');
    };

    // ── Register listeners ───────────────────────────────────────────────
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('contextmenu', onContextMenu);

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('contextmenu', onContextMenu);
    };
  }, [state.active, sendDebounced]);

  // ─── Start monitoring (called by "Start Exam" button) ─────────────────────
  const startMonitoring = useCallback(async () => {
    activeRef.current = true;

    // Request fullscreen
    try {
      await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[useBehavioralDetection] Fullscreen request failed:', err);
    }

    setState((s) => ({
      ...s,
      active: true,
      isFullscreen: !!document.fullscreenElement,
      tabFocused: !document.hidden,
      rightClickCount: 0,
      lastClipboard: null,
    }));
  }, []);

  // ─── Re-enter fullscreen (after exit) ─────────────────────────────────────
  const reenterFullscreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[useBehavioralDetection] Re-enter fullscreen failed:', err);
    }
  }, []);

  // ─── Stop monitoring (cleanup on unmount) ─────────────────────────────────
  const stopMonitoring = useCallback(() => {
    activeRef.current = false;
    setState((s) => ({ ...s, active: false }));
    // Exit fullscreen if active
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  return {
    monitoringState: state,
    startMonitoring,
    stopMonitoring,
    reenterFullscreen,
  };
}

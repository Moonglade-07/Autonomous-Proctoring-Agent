/**
 * useWebSocket.ts
 * ─────────────────────────────────────────────────────────────────
 * Custom React hook that manages a persistent WebSocket connection
 * to the Cloudflare Durable Object at /api/exam/:sessionId.
 *
 * Returns:
 *   • sendEvent(type, payload?) — sends a behavioral event to the DO
 *   • status                    — 'connecting' | 'open' | 'closed' | 'error'
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BehavioralEventType, ClipboardPayload, VisionEventPayload, ThumbnailPayload, WSOutboundMsg } from '../types';

type WSStatus = 'connecting' | 'open' | 'closed' | 'error';

interface UseWebSocketOptions {
  sessionId: string;
  examId?: string;
  studentName?: string;
  onMessage: (msg: WSOutboundMsg) => void;
}

export function useWebSocket({ sessionId, examId, studentName, onMessage }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WSStatus>('connecting');
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Determine WebSocket URL — same host, /api/exam/:sessionId?examId=...&name=...
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    if (examId) params.set('examId', examId);
    if (studentName) params.set('name', studentName);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const wsUrl = `${protocol}//${window.location.host}/api/exam/${sessionId}${qs}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      if (mountedRef.current) setStatus('open');
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WSOutboundMsg;
        if (mountedRef.current) onMessage(msg);
      } catch {
        console.error('[useWebSocket] Failed to parse message', evt.data);
      }
    };

    ws.onerror = () => {
      if (mountedRef.current) setStatus('error');
    };

    ws.onclose = () => {
      if (mountedRef.current) {
        setStatus('closed');
        // Auto-reconnect after 3 seconds
        reconnectTimeout.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 3000);
      }
    };
  }, [sessionId, examId, studentName, onMessage]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [connect]);

  /**
   * Send a behavioral event to the Durable Object.
   * Optionally includes a payload (e.g., clipboard action details or thumbnail).
   */
  const sendEvent = useCallback(
    (
      eventType: BehavioralEventType,
      payload?: ClipboardPayload | VisionEventPayload | ThumbnailPayload
    ) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const msg: {
          eventType: BehavioralEventType;
          payload?: ClipboardPayload | VisionEventPayload | ThumbnailPayload;
        } = { eventType };
        if (payload) msg.payload = payload;
        wsRef.current.send(JSON.stringify(msg));
      } else {
        console.warn('[useWebSocket] Cannot send — WebSocket not open');
      }
    },
    []
  );

  return { sendEvent, status };
}

/**
 * useWebSocket.ts
 * ─────────────────────────────────────────────────────────────────
 * Custom React hook that manages a persistent WebSocket connection
 * to the Cloudflare Durable Object at /api/exam/:sessionId.
 *
 * Returns:
 *   • sendEvent(type) — sends a behavioral event to the DO
 *   • status          — 'connecting' | 'open' | 'closed' | 'error'
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BehavioralEventType, WSOutboundMsg } from '../types';

type WSStatus = 'connecting' | 'open' | 'closed' | 'error';

interface UseWebSocketOptions {
  sessionId: string;
  onMessage: (msg: WSOutboundMsg) => void;
}

export function useWebSocket({ sessionId, onMessage }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WSStatus>('connecting');
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Determine WebSocket URL — same host, /api/exam/:sessionId
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/exam/${sessionId}`;

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
  }, [sessionId, onMessage]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [connect]);

  /** Send a behavioral event to the Durable Object */
  const sendEvent = useCallback((eventType: BehavioralEventType) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ eventType }));
    } else {
      console.warn('[useWebSocket] Cannot send — WebSocket not open');
    }
  }, []);

  return { sendEvent, status };
}

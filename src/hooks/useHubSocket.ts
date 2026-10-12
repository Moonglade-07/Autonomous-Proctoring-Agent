/**
 * useHubSocket.ts
 * ─────────────────────────────────────────────────────────────────
 * Custom React hook for the professor dashboard that manages a
 * persistent WebSocket connection to ExamHubDO at /api/hub/:examId.
 *
 * Returns:
 *   • sessions  — Record<sessionId, SessionSummary> (live)
 *   • alerts    — HubAlert[] (last 100, newest first)
 *   • status    — connection status badge
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionSummary, HubAlert, HubOutboundMsg } from '../types';

type WSStatus = 'connecting' | 'open' | 'closed' | 'error';

interface UseHubSocketOptions {
  examId: string;
}

export function useHubSocket({ examId }: UseHubSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WSStatus>('connecting');
  const [sessions, setSessions] = useState<Record<string, SessionSummary>>({});
  const [alerts, setAlerts] = useState<HubAlert[]>([]);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/hub/${encodeURIComponent(examId)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      if (mountedRef.current) setStatus('open');
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as HubOutboundMsg;
        if (!mountedRef.current) return;

        if (msg.type === 'snapshot') {
          setSessions(msg.sessions);
          // alerts newest-first
          setAlerts([...msg.alerts].reverse().slice(0, 100));
        } else if (msg.type === 'session_update' || msg.type === 'session_updated') {
          setSessions((prev) => ({ ...prev, [msg.summary.sessionId]: msg.summary }));
        } else if (msg.type === 'session_removed') {
          setSessions((prev) => {
            const next = { ...prev };
            delete next[msg.sessionId];
            return next;
          });
        } else if (msg.type === 'alert') {
          setAlerts((prev) => [msg.alert, ...prev].slice(0, 100));
        }
      } catch {
        console.error('[useHubSocket] Failed to parse message', evt.data);
      }
    };

    ws.onerror = () => {
      if (mountedRef.current) setStatus('error');
    };

    ws.onclose = () => {
      if (mountedRef.current) {
        setStatus('closed');
        reconnectTimeout.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 3000);
      }
    };
  }, [examId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { sessions, alerts, status };
}

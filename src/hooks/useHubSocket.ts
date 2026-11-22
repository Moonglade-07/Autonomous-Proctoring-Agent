/**
 * useHubSocket.ts
 * ─────────────────────────────────────────────────────────────────
 * Custom React hook for the professor dashboard that manages a
 * persistent WebSocket connection to ExamHubDO at /api/hub/:examId.
 *
 * Returns:
 *   • sessions        — Record<sessionId, SessionSummary> (live)
 *   • alerts          — HubAlert[] (last 100, newest first)
 *   • status          — connection status badge
 *   • sendCommand     — Phase 3b: issue a command to a student session
 *   • commandResults  — Phase 3b: recent command delivery results/acks
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  SessionSummary,
  HubAlert,
  HubOutboundMsg,
  InterventionAction,
  Intervention,
} from '../types';

type WSStatus = 'connecting' | 'open' | 'closed' | 'error';

/** Result of a professor command (delivery acknowledgement). */
export interface CommandResult {
  sessionId: string;
  action: InterventionAction;
  status: 'delivered' | 'queued' | 'error' | 'noop';
  message: string;
  timestamp: string;
}

/** Acknowledgement received from a student back to the professor. */
export interface CommandAckRecord {
  interventionId: string;
  sessionId: string;
  action: InterventionAction;
  acknowledgedAt: string;
}

interface UseHubSocketOptions {
  examId: string;
}

export function useHubSocket({ examId }: UseHubSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WSStatus>('connecting');
  const [sessions, setSessions] = useState<Record<string, SessionSummary>>({});
  const [alerts, setAlerts] = useState<HubAlert[]>([]);
  const [commandResults, setCommandResults] = useState<CommandResult[]>([]);
  const [commandAcks, setCommandAcks] = useState<CommandAckRecord[]>([]);
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
        } else if (msg.type === 'command_result') {
          // Phase 3b: store command delivery result
          const result: CommandResult = {
            sessionId: msg.sessionId,
            action: msg.action,
            status: msg.status,
            message: msg.message,
            timestamp: new Date().toISOString(),
          };
          setCommandResults((prev) => [result, ...prev].slice(0, 50));
        } else if (msg.type === 'command_ack') {
          // Phase 3b: student acknowledged a command
          const ack: CommandAckRecord = {
            interventionId: msg.interventionId,
            sessionId: msg.sessionId,
            action: msg.action,
            acknowledgedAt: msg.acknowledgedAt,
          };
          setCommandAcks((prev) => [ack, ...prev].slice(0, 50));
          // Also update interventions on the session summary
          setSessions((prev) => {
            const session = prev[msg.sessionId];
            if (!session) return prev;
            const updatedInterventions = (session.interventions ?? []).map(
              (inv: Intervention) =>
                inv.id === msg.interventionId
                  ? { ...inv, acknowledgedAt: msg.acknowledgedAt }
                  : inv
            );
            return {
              ...prev,
              [msg.sessionId]: { ...session, interventions: updatedInterventions },
            };
          });
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

  /**
   * Phase 3b: Issue a professor command to a student session.
   * Sends a 'command' message over the hub WebSocket.
   *
   * @param sessionId - Target student session
   * @param action    - 'warn' | 'pause' | 'resume' | 'force_submit'
   * @param message   - Optional custom message (for warnings)
   */
  const sendCommand = useCallback(
    (sessionId: string, action: InterventionAction, message?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[useHubSocket] Cannot send command — WebSocket not open');
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'command',
          sessionId,
          action,
          message,
        })
      );
    },
    []
  );

  return { sessions, alerts, status, sendCommand, commandResults, commandAcks };
}

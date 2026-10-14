import { useEffect, useRef, useState } from 'react';
import { sessionsApi } from '@/shared/lib/api';
import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';
import type { ExecutionProcess } from 'shared/types';

export interface AiOwner {
  executor: string;
  variant: string | null;
  model: string | null;
  isReview: boolean;
}

const EXECUTOR_LABEL: Record<string, string> = {
  CLAUDE_CODE: 'Claude',
  CODEX: 'Codex',
  GEMINI: 'Gemini',
  CURSOR_AGENT: 'Cursor',
  OPENCODE: 'OpenCode',
  AMP: 'Amp',
  QWEN_CODE: 'Qwen',
  COPILOT: 'Copilot',
  DROID: 'Droid',
};

function shortModel(model: string): string {
  let m = model.split('/').pop() ?? model;
  m = m.replace(/^(claude|gpt|gemini)-/i, '');
  return m.replace(/(\d)-(\d)/g, '$1.$2');
}

export function formatAiOwner(o: AiOwner): string {
  const parts = [EXECUTOR_LABEL[o.executor] ?? o.executor];
  if (o.model) parts.push(shortModel(o.model));
  if (o.variant) parts.push(o.variant);
  return `${o.isReview ? '🔍' : '🤖'} ${parts.join(' · ')}`;
}

/** Read the initial snapshot of a session's execution processes, then close. */
export function fetchSessionProcesses(sessionId: string): Promise<ExecutionProcess[]> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let done = false;
    const finish = (list: ExecutionProcess[]) => {
      if (done) return;
      done = true;
      ws?.close();
      resolve(list);
    };
    setTimeout(() => finish([]), 5000);
    const params = new URLSearchParams({ session_id: sessionId });
    void openLocalApiWebSocket(
      `/api/execution-processes/stream/session/ws?${params.toString()}`
    )
      .then((sock) => {
        ws = sock;
        if (done) sock.close();
        sock.addEventListener('message', (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(ev.data);
            if (!msg.JsonPatch) return;
            const out: ExecutionProcess[] = [];
            for (const op of msg.JsonPatch as {
              path: string;
              value?: unknown;
            }[]) {
              const v = op.value as
                Record<string, ExecutionProcess> | ExecutionProcess | undefined;
              if (!v) continue;
              if (op.path === '/execution_processes') {
                out.push(
                  ...Object.values(v as Record<string, ExecutionProcess>)
                );
              } else if (op.path.startsWith('/execution_processes/')) {
                out.push(v as ExecutionProcess);
              }
            }
            finish(out);
          } catch {
            finish([]);
          }
        });
        sock.addEventListener('error', () => finish([]));
      })
      .catch(() => finish([]));
  });
}

async function loadOwner(workspaceId: string): Promise<AiOwner | null> {
  const sessions = await sessionsApi.getByWorkspace(workspaceId);
  const sorted = [...sessions].sort(
    (a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  const latest = sorted[0];
  if (!latest) return null;
  const procs = await fetchSessionProcesses(latest.id);
  const agentProcs = procs
    .filter((p) => p.executor_action?.typ?.type !== 'ScriptRequest')
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  const typ = agentProcs[0]?.executor_action?.typ;
  const cfg =
    typ && typ.type !== 'ScriptRequest' ? typ.executor_config : undefined;
  const executor = cfg?.executor ?? latest.executor;
  if (!executor) return null;
  const variant = cfg?.variant ?? null;
  return {
    executor: String(executor),
    variant,
    model: cfg?.model_id ?? null,
    isReview:
      typ?.type === 'ReviewRequest' ||
      /review/i.test(variant ?? '') ||
      /^리뷰/.test(latest.name ?? ''),
  };
}

/**
 * AI owner (latest coding-agent session) per local workspace id.
 * Refreshes every 60s; `refreshKey` changes force a reload.
 */
export function useAiOwners(
  workspaceIds: string[],
  refreshKey: string
): Map<string, AiOwner> {
  const [owners, setOwners] = useState<Map<string, AiOwner>>(new Map());
  const [tick, setTick] = useState(0);
  const idsKey = [...new Set(workspaceIds)].sort().join(',');
  const inflight = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!idsKey || inflight.current) return;
    inflight.current = true;
    let cancelled = false;
    (async () => {
      const next = new Map<string, AiOwner>();
      const ids = idsKey.split(',');
      for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(
          ids.slice(i, i + 4).map(async (id) => {
            try {
              const o = await loadOwner(id);
              if (o) next.set(id, o);
            } catch {
              /* ignore */
            }
          })
        );
      }
      inflight.current = false;
      if (!cancelled) setOwners(next);
    })();
    return () => {
      cancelled = true;
      inflight.current = false;
    };
  }, [idsKey, refreshKey, tick]);

  return owners;
}

import { useEffect, useRef } from 'react';
import { sessionsApi } from '@/shared/lib/api';
import { fetchSessionProcesses } from './useAiOwners';
import {
  buildRunFailureMessage,
  collectProcessErrors,
  postFailureCommentOnce,
  wasFailureCommented,
} from '@/shared/lib/issueFailureComments';

export interface RunWatchTarget {
  issueId: string;
  simpleId: string;
  workspaceId: string;
  latestProcessStatus?: string;
  latestProcessCompletedAt?: string;
}

// Only failures that ended shortly before the board was opened (or later)
// get a comment, so old failures are not back-filled in bulk.
const LOOKBACK_MS = 30 * 60 * 1000;

/**
 * Leave an "⚠️ 실행 실패" issue comment when any agent run in a workspace
 * linked to the issue ends failed/killed. Review runs started from the card
 * are commented by the review watcher and skipped here via the shared keys.
 */
export function useRunFailureComments(targets: RunWatchTarget[]) {
  const mountedAt = useRef(Date.now());
  const handled = useRef(new Set<string>());

  useEffect(() => {
    for (const t of targets) {
      if (
        t.latestProcessStatus !== 'failed' &&
        t.latestProcessStatus !== 'killed'
      )
        continue;
      const completed = t.latestProcessCompletedAt
        ? new Date(t.latestProcessCompletedAt).getTime()
        : 0;
      if (completed < mountedAt.current - LOOKBACK_MS) continue;
      const marker = `${t.workspaceId}:${t.latestProcessCompletedAt ?? ''}:${t.issueId}`;
      if (handled.current.has(marker)) continue;
      handled.current.add(marker);
      void (async () => {
        try {
          const sessions = await sessionsApi.getByWorkspace(t.workspaceId);
          const latest = [...sessions].sort(
            (a, b) =>
              new Date(b.updated_at).getTime() -
              new Date(a.updated_at).getTime()
          )[0];
          if (!latest) return;
          const procs = await fetchSessionProcesses(latest.id);
          const failed = procs
            .filter(
              (p) =>
                String(p.status) === 'failed' || String(p.status) === 'killed'
            )
            .sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            )[0];
          if (!failed) return;
          // review watcher uses the same key, so card reviews aren't doubled
          if (wasFailureCommented(`proc:${failed.id}`)) return;
          const reason =
            String(failed.status) === 'killed'
              ? '에이전트 실행이 중단(killed)되었어요. 직접 중지했거나 백엔드가 재시작되었을 수 있어요.'
              : '';
          const { errors } = await collectProcessErrors(failed.id);
          const typ = failed.executor_action?.typ?.type;
          const stage =
            typ === 'ScriptRequest'
              ? '설정/정리 스크립트'
              : typ === 'ReviewRequest'
                ? '리뷰 실행'
                : '에이전트 실행';
          await postFailureCommentOnce(
            `proc:${failed.id}`,
            t.issueId,
            buildRunFailureMessage({
              simpleId: t.simpleId,
              stage: `${stage} (${latest.executor ?? '?'})`,
              reason:
                errors.slice(-5).join('\n') ||
                reason ||
                `프로세스가 상태 '${String(failed.status)}'(으)로 끝났고 오류 메시지가 남지 않았어요.`,
              workspaceUrl: `${window.location.origin}/workspaces/${t.workspaceId}`,
              retryHint:
                '작업 공간에서 후속 메시지로 다시 시도하거나 카드에서 작업을 다시 시작해 주세요.',
            })
          );
        } catch (err) {
          handled.current.delete(marker);
          console.error('run failure comment check failed:', err);
        }
      })();
    }
  }, [targets]);
}

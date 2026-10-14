import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { sessionsApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';

const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const COLLAPSE_KEY = 'vk.unlinkedWorkspaces.collapsed';

type Status = 'approval' | 'failed' | 'running' | 'done' | 'idle';

function statusOf(w: SidebarWorkspace): Status {
  if (w.hasPendingApproval) return 'approval';
  if (w.isRunning) return 'running';
  if (w.latestProcessStatus === 'failed' || w.latestProcessStatus === 'killed')
    return 'failed';
  if (w.latestProcessStatus === 'completed') return 'done';
  return 'idle';
}

const STATUS_LABEL: Record<Status, { text: string; cls: string }> = {
  approval: { text: '승인 대기', cls: 'bg-amber-500/20 text-amber-600' },
  failed: { text: '실패', cls: 'bg-red-500/20 text-red-600' },
  running: { text: '실행 중', cls: 'bg-blue-500/20 text-blue-600' },
  done: { text: '완료', cls: 'bg-green-500/20 text-green-700' },
  idle: { text: '대기', cls: 'bg-secondary text-low' },
};

function needsAction(w: SidebarWorkspace, s: Status): boolean {
  return (
    s === 'approval' ||
    s === 'failed' ||
    !!w.needsUserInput ||
    (s === 'done' && !!w.hasUnseenActivity)
  );
}

function rank(w: SidebarWorkspace, s: Status): number {
  if (needsAction(w, s)) return 0;
  if (s === 'running') return 1;
  return 2;
}

function lastActivity(w: SidebarWorkspace): number {
  return new Date(w.latestProcessCompletedAt ?? w.updatedAt).getTime();
}

/**
 * Board section listing local (non-archived) workspaces that are not linked
 * to any issue, so everything in progress is visible from the kanban board.
 * Note: local workspaces carry no project id, so these are not project-scoped.
 */
export function UnlinkedWorkspacesSection() {
  const { activeWorkspaces } = useWorkspaceContext();
  const { workspaces: projectWorkspaces } = useProjectContext();
  const appNavigation = useAppNavigation();
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) === '1'
  );
  const [showAll, setShowAll] = useState(false);
  const [executors, setExecutors] = useState<Record<string, string>>({});

  const linkedLocalIds = useMemo(() => {
    const set = new Set<string>();
    for (const w of projectWorkspaces) {
      if (w.issue_id && w.local_workspace_id) set.add(w.local_workspace_id);
    }
    return set;
  }, [projectWorkspaces]);

  const all = useMemo(() => {
    return activeWorkspaces
      .filter((w) => !w.isArchived && !linkedLocalIds.has(w.id))
      .map((w) => ({ w, s: statusOf(w) }))
      .sort(
        (a, b) =>
          rank(a.w, a.s) - rank(b.w, b.s) ||
          lastActivity(b.w) - lastActivity(a.w)
      );
  }, [activeWorkspaces, linkedLocalIds]);

  const now = Date.now();
  const recent = all.filter(
    ({ w, s }) => rank(w, s) < 2 || now - lastActivity(w) < RECENT_MS
  );
  const shown = showAll ? all : recent;
  const hiddenCount = all.length - recent.length;
  const actionCount = all.filter(({ w, s }) => needsAction(w, s)).length;
  const runningCount = all.filter(({ s }) => s === 'running').length;

  const shownIds = shown.map(({ w }) => w.id).join(',');
  useEffect(() => {
    if (collapsed) return;
    const missing = shownIds
      .split(',')
      .filter((id) => id && !(id in executors));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const found: Record<string, string> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            const sessions = await sessionsApi.getByWorkspace(id);
            const latest = [...sessions].sort(
              (a, b) =>
                new Date(b.updated_at).getTime() -
                new Date(a.updated_at).getTime()
            )[0];
            found[id] = latest?.executor ?? '';
          } catch {
            found[id] = '';
          }
        })
      );
      if (!cancelled) setExecutors((prev) => ({ ...prev, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [shownIds, collapsed, executors]);

  if (all.length === 0) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };

  return (
    <div className="px-double pb-base">
      <div className="rounded-md border border-border bg-secondary/40 px-base py-half">
        <div className="flex items-center gap-base text-sm">
          <button
            type="button"
            onClick={toggle}
            className="font-medium text-normal hover:underline"
          >
            {collapsed ? '▸' : '▾'} 이슈 없는 작업 공간 ({all.length})
          </button>
          {actionCount > 0 && (
            <span className="rounded px-1 text-xs bg-orange-500/20 text-orange-600">
              👤 내 액션 필요 {actionCount}
            </span>
          )}
          {runningCount > 0 && (
            <span className="text-xs text-low">실행 중 {runningCount}</span>
          )}
          <span
            className="text-xs text-low"
            title="로컬 작업 공간에는 프로젝트 정보가 없어서 모든 프로젝트의 이슈 미연결 작업 공간을 보여줘요."
          >
            · 전체 프로젝트 기준
          </span>
          {!collapsed && (hiddenCount > 0 || showAll) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="ml-auto text-xs text-low hover:underline"
            >
              {showAll ? '최근 것만 보기' : `모두 보기 (+${hiddenCount})`}
            </button>
          )}
        </div>
        {!collapsed && (
          <div className="mt-half flex gap-base overflow-x-auto pb-half">
            {shown.length === 0 && (
              <span className="text-xs text-low">
                최근 3일 내 활동한 작업 공간이 없어요.
              </span>
            )}
            {shown.map(({ w, s }) => {
              const label = STATUS_LABEL[s];
              const action = needsAction(w, s);
              const exec = executors[w.id];
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => appNavigation.goToWorkspace(w.id)}
                  title={w.name}
                  className={cn(
                    'shrink-0 w-[240px] text-left rounded border bg-primary px-base py-half hover:bg-secondary',
                    action ? 'border-orange-500' : 'border-border'
                  )}
                >
                  <div className="truncate text-sm text-normal">{w.name}</div>
                  <div className="truncate text-xs text-low">{w.branch}</div>
                  <div className="mt-half flex flex-wrap items-center gap-1 text-xs">
                    <span className={cn('rounded px-1', label.cls)}>
                      {label.text}
                    </span>
                    {exec && <span className="text-low">{exec}</span>}
                    {action && (
                      <span className="rounded px-1 bg-orange-500/20 text-orange-600">
                        👤 내 액션 필요
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

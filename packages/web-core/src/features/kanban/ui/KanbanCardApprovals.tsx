import { useState, type MouseEvent } from 'react';
import type { ApprovalInfo } from 'shared/types';
import { approvalsApi, executionProcessesApi } from '@/shared/lib/api';

function describeTool(toolName: string): string {
  const mcp = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    const server = mcp[1] === 'vibe_kanban' ? '칸반' : mcp[1];
    return `${server} 도구 사용: ${mcp[2]}`;
  }
  const known: Record<string, string> = {
    Bash: '터미널 명령 실행',
    Edit: '파일 수정',
    MultiEdit: '파일 여러 곳 수정',
    Write: '파일 쓰기',
    WebFetch: '웹 페이지 읽기',
    WebSearch: '웹 검색',
    ExitPlanMode: '계획 승인 후 실행 시작',
  };
  return known[toolName] ?? toolName;
}

interface Props {
  approvals: ApprovalInfo[];
  onOpenDetails: () => void;
}

export function KanbanCardApprovals({ approvals, onOpenDetails }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const run = async (
    e: MouseEvent,
    a: ApprovalInfo,
    action: 'approve' | 'deny' | 'stop'
  ) => {
    e.stopPropagation();
    setBusy(a.approval_id);
    setError(null);
    try {
      if (action === 'stop') {
        await executionProcessesApi.stopExecutionProcess(
          a.execution_process_id
        );
      } else {
        await approvalsApi.respond(a.approval_id, {
          execution_process_id: a.execution_process_id,
          status:
            action === 'approve'
              ? { status: 'approved' }
              : { status: 'denied', reason: '칸반 보드에서 거절함' },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="mb-half flex flex-col gap-half rounded-sm border border-orange-500/40 bg-orange-500/10 p-half"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {approvals.map((a) => (
        <div key={a.approval_id} className="flex flex-col gap-half">
          <div className="text-xs font-medium text-orange-700 dark:text-orange-300">
            {a.is_question ? '🟠 에이전트 질문에 답 필요' : '⚠ 승인 필요'}:{' '}
            {describeTool(a.tool_name)}
          </div>
          {a.tool_name !== describeTool(a.tool_name) && (
            <div className="text-[11px] text-low break-all">{a.tool_name}</div>
          )}
          <div className="flex flex-wrap gap-half">
            {!a.is_question && (
              <>
                <button
                  type="button"
                  disabled={busy === a.approval_id}
                  onClick={(e) => run(e, a, 'approve')}
                  className="rounded-sm bg-green-600 px-base py-[2px] text-xs text-white hover:bg-green-700 disabled:opacity-50"
                >
                  승인
                </button>
                <button
                  type="button"
                  disabled={busy === a.approval_id}
                  onClick={(e) => run(e, a, 'deny')}
                  className="rounded-sm bg-secondary px-base py-[2px] text-xs text-normal hover:bg-primary disabled:opacity-50 border"
                >
                  거절
                </button>
              </>
            )}
            <button
              type="button"
              disabled={busy === a.approval_id}
              onClick={(e) => run(e, a, 'stop')}
              className="rounded-sm bg-red-600 px-base py-[2px] text-xs text-white hover:bg-red-700 disabled:opacity-50"
            >
              작업 중단
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails();
              }}
              className="px-half py-[2px] text-xs text-low underline hover:text-normal"
            >
              {a.is_question ? '답하러 가기' : '자세히'}
            </button>
          </div>
        </div>
      ))}
      {error && <div className="text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

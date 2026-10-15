import {
  blockerMessage,
  fetchUnfinishedBlockers,
  showBlockerToast,
} from '@/shared/lib/blockerGuard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { CreateAndStartWorkspaceRequest } from 'shared/types';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import {
  buildRunFailureMessage,
  postFailureCommentOnce,
} from '@/shared/lib/issueFailureComments';

interface CreateWorkspaceParams {
  data: CreateAndStartWorkspaceRequest;
  linkToIssue?: {
    remoteProjectId: string;
    issueId: string;
    simpleId?: string;
  };
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  const createWorkspace = useMutation({
    mutationFn: async ({ data, linkToIssue }: CreateWorkspaceParams) => {
      const guardIssueId =
        linkToIssue?.issueId ?? data.linked_issue?.issue_id ?? null;
      if (guardIssueId) {
        const blockers = await fetchUnfinishedBlockers(guardIssueId);
        if (blockers.length) {
          const msg = blockerMessage(blockers, '시작할');
          showBlockerToast(msg);
          const err = new Error(msg);
          err.name = 'BlockedByPredecessor';
          throw err;
        }
      }
      const { workspace } = await workspacesApi.createAndStart(data);

      if (linkToIssue && workspace) {
        try {
          await workspacesApi.linkToIssue(
            workspace.id,
            linkToIssue.remoteProjectId,
            linkToIssue.issueId
          );
        } catch (linkError) {
          console.error('Failed to link workspace to issue:', linkError);
        }
      }

      return { workspace };
    },
    onSuccess: () => {
      // Invalidate workspace summaries so they refresh with the new workspace included
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      // Ensure create-mode defaults refetch the latest session/model selection.
      queryClient.invalidateQueries({ queryKey: ['workspaceCreateDefaults'] });
    },
    onError: (err, vars) => {
      console.error('Failed to create workspace:', err);
      const issueId =
        vars.linkToIssue?.issueId ?? vars.data.linked_issue?.issue_id;
      if (!issueId) return;
      // Blocked by predecessors: toast already shown, not a run failure.
      if (err instanceof Error && err.name === 'BlockedByPredecessor') return;
      const reason = err instanceof Error ? err.message : String(err);
      // one comment per distinct error per issue per minute (double clicks)
      const key = `start:${issueId}:${Math.floor(Date.now() / 60000)}:${reason.slice(0, 80)}`;
      void postFailureCommentOnce(
        key,
        issueId,
        buildRunFailureMessage({
          simpleId: vars.linkToIssue?.simpleId || vars.data.name || '작업 시작',
          stage: '작업 시작(작업 공간 생성) 단계',
          reason,
          retryHint:
            '카드에서 작업 시작을 다시 눌러 주세요. 저장소·브랜치·실행 프리셋을 함께 확인해 주세요.',
        })
      );
    },
  });

  return { createWorkspace };
}

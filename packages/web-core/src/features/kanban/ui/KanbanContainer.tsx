import {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  type MouseEvent,
  Fragment,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useOrgContext } from '@/shared/hooks/useOrgContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useActions } from '@/shared/hooks/useActions';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { cn } from '@/shared/lib/utils';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  useUiPreferencesStore,
  resolveKanbanProjectState,
  KANBAN_ASSIGNEE_FILTER_VALUES,
  KANBAN_PROJECT_VIEW_IDS,
  type KanbanFilterState,
  type KanbanSortField,
} from '@/shared/stores/useUiPreferencesStore';
import {
  useKanbanFilters,
  PRIORITY_ORDER,
} from '../model/hooks/useKanbanFilters';
import {
  bulkUpdateIssues,
  createIssueComment,
  type BulkUpdateIssueItem,
} from '@/shared/lib/remoteApi';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';
import { PlusIcon, DotsThreeIcon } from '@phosphor-icons/react';
import { Actions } from '@/shared/actions';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  openKanbanIssueComposer,
  type ProjectIssueCreateOptions,
  useKanbanIssueComposer,
} from '@/shared/stores/useKanbanIssueComposerStore';
import type { OrganizationMemberWithProfile } from 'shared/types';
import {
  KanbanProvider,
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  type DropResult,
} from '@vibe/ui/components/KanbanBoard';
import { KanbanCardContent } from '@vibe/ui/components/KanbanCardContent';
import {
  IssueWorkspaceCard,
  type WorkspaceWithStats,
  type WorkspacePr,
} from '@vibe/ui/components/IssueWorkspaceCard';
import { resolveRelationshipsForIssue } from '@/shared/lib/resolveRelationships';
import { KanbanFilterBar } from '@vibe/ui/components/KanbanFilterBar';
import { ViewNavTabs } from '@vibe/ui/components/ViewNavTabs';
import { IssueListView } from '@vibe/ui/components/IssueListView';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { KanbanFiltersDialog } from '@/shared/dialogs/kanban/KanbanFiltersDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { SearchableTagDropdownContainer } from '@/shared/components/SearchableTagDropdownContainer';
import type { IssuePriority } from 'shared/remote-types';
import { useIssueMultiSelect } from '@/shared/hooks/useIssueMultiSelect';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import { BulkActionBarContainer } from './BulkActionBarContainer';
import { KanbanCardApprovals } from './KanbanCardApprovals';
import { UnlinkedWorkspacesSection } from './UnlinkedWorkspacesSection';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { executionProcessesApi, sessionsApi } from '@/shared/lib/api';
import type { ApprovalInfo } from 'shared/types';
import { BaseCodingAgent } from 'shared/types';

const areStringSetsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
};

const areKanbanFiltersEqual = (
  left: KanbanFilterState,
  right: KanbanFilterState
): boolean => {
  if (left.searchQuery.trim() !== right.searchQuery.trim()) {
    return false;
  }

  if (!areStringSetsEqual(left.priorities, right.priorities)) {
    return false;
  }

  if (!areStringSetsEqual(left.assigneeIds, right.assigneeIds)) {
    return false;
  }

  if (!areStringSetsEqual(left.tagIds, right.tagIds)) {
    return false;
  }

  return (
    left.sortField === right.sortField &&
    left.sortDirection === right.sortDirection
  );
};

function LoadingState() {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-low">{t('states.loading')}</p>
    </div>
  );
}

/**
 * KanbanContainer displays the kanban board using data from ProjectContext and OrgContext.
 * Must be rendered within both OrgProvider and ProjectProvider.
 */
export function KanbanContainer() {
  const isMobile = useIsMobile();
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const routeState = useCurrentKanbanRouteState();

  // Get data from contexts (set up by WorkspacesLayout)
  const {
    projectId,
    issues,
    statuses,
    tags,
    issueAssignees,
    issueTags,
    issueRelationships,
    getTagObjectsForIssue,
    getTagsForIssue,
    getPullRequestsForIssue,
    getWorkspacesForIssue,
    getRelationshipsForIssue,
    issuesById,
    insertIssueTag,
    removeIssueTag,
    insertTag,
    pullRequests,
    isLoading: projectLoading,
  } = useProjectContext();

  const {
    projects,
    membersWithProfilesById,
    isLoading: orgLoading,
  } = useOrgContext();
  const { activeWorkspaces } = useWorkspaceContext();
  const { userId } = useAuth();

  // Get project name by finding the project matching current projectId
  const projectName = projects.find((p) => p.id === projectId)?.name ?? '';

  const selectedKanbanIssueId = routeState.issueId;
  const issueComposerKey = useMemo(
    () => buildKanbanIssueComposerKey(routeState.hostId, projectId),
    [routeState.hostId, projectId]
  );
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const isIssueComposerOpen = issueComposer !== null;
  const openIssue = useCallback(
    (issueId: string) => {
      if (isIssueComposerOpen) {
        closeKanbanIssueComposer(issueComposerKey);
      }

      appNavigation.goToProjectIssue(projectId, issueId);
    },
    [isIssueComposerOpen, issueComposerKey, appNavigation, projectId]
  );
  const openIssueWorkspace = useCallback(
    (issueId: string, workspaceAttemptId: string) => {
      appNavigation.goToProjectIssueWorkspace(
        projectId,
        issueId,
        workspaceAttemptId
      );
    },
    [appNavigation, projectId]
  );
  const startCreate = useCallback(
    (options?: ProjectIssueCreateOptions) => {
      openKanbanIssueComposer(issueComposerKey, options);
    },
    [issueComposerKey]
  );

  // Get setter and executor from ActionsContext
  const {
    setDefaultCreateStatusId,
    executeAction,
    openPrioritySelection,
    openAssigneeSelection,
  } = useActions();
  const openProjectsGuide = useCallback(() => {
    executeAction(Actions.ProjectsGuide);
  }, [executeAction]);

  const projectViewSelection = useUiPreferencesStore(
    (s) => s.kanbanProjectViewSelections[projectId]
  );
  const projectViewPreferencesById = useUiPreferencesStore(
    (s) => s.kanbanProjectViewPreferences[projectId]
  );
  const setKanbanProjectView = useUiPreferencesStore(
    (s) => s.setKanbanProjectView
  );
  const setKanbanProjectViewFilters = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewFilters
  );
  const setKanbanProjectViewShowSubIssues = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewShowSubIssues
  );
  const setKanbanProjectViewShowWorkspaces = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewShowWorkspaces
  );
  const setKanbanProjectViewHideBlocked = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewHideBlocked
  );
  const clearKanbanProjectViewPreferences = useUiPreferencesStore(
    (s) => s.clearKanbanProjectViewPreferences
  );
  const resolvedProjectState = useMemo(
    () => resolveKanbanProjectState(projectViewSelection),
    [projectViewSelection]
  );
  const {
    activeViewId,
    filters: defaultKanbanFilters,
    showSubIssues: defaultShowSubIssues,
    showWorkspaces: defaultShowWorkspaces,
    hideBlocked: defaultHideBlocked,
  } = resolvedProjectState;
  const projectViewPreferences = projectViewPreferencesById?.[activeViewId];
  const kanbanFilters = projectViewPreferences?.filters ?? defaultKanbanFilters;
  const showSubIssues =
    projectViewPreferences?.showSubIssues ?? defaultShowSubIssues;
  const showWorkspaces =
    projectViewPreferences?.showWorkspaces ?? defaultShowWorkspaces;
  const hideBlocked = projectViewPreferences?.hideBlocked ?? defaultHideBlocked;

  const hasActiveFilters = useMemo(
    () =>
      !areKanbanFiltersEqual(kanbanFilters, defaultKanbanFilters) ||
      showSubIssues !== defaultShowSubIssues ||
      showWorkspaces !== defaultShowWorkspaces ||
      hideBlocked !== defaultHideBlocked,
    [
      kanbanFilters,
      defaultKanbanFilters,
      showSubIssues,
      defaultShowSubIssues,
      showWorkspaces,
      defaultShowWorkspaces,
      hideBlocked,
      defaultHideBlocked,
    ]
  );
  const shouldAnimateCreateButton = issues.length === 0;

  // Compute resolved status IDs for the blocked filter.
  // A blocking issue is considered resolved when it's in:
  // - The last visible status (rightmost kanban column, e.g. "Done")
  // - Any hidden status (terminal states like "Cancelled" that don't appear as columns)
  const firstVisibleStatusId = useMemo(
    () =>
      [...statuses]
        .filter((s) => !s.hidden)
        .sort((a, b) => a.sort_order - b.sort_order)[0]?.id,
    [statuses]
  );

  const doneStatusIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of statuses) {
      if (s.hidden) ids.add(s.id);
    }
    const sorted = statuses
      .filter((s) => !s.hidden)
      .sort((a, b) => a.sort_order - b.sort_order);
    const lastVisible = sorted[sorted.length - 1];
    if (lastVisible) ids.add(lastVisible.id);
    return ids;
  }, [statuses]);

  // Issues blocked by at least one unresolved blocking issue.
  const blockedIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of issueRelationships) {
      if (r.relationship_type !== 'blocking') continue;
      const blocker = issuesById.get(r.issue_id);
      if (blocker && !doneStatusIds.has(blocker.status_id)) {
        ids.add(r.related_issue_id);
      }
    }
    return ids;
  }, [issueRelationships, issuesById, doneStatusIds]);

  const { filteredIssues } = useKanbanFilters({
    issues,
    issueAssignees,
    issueTags,
    issueRelationships,
    issuesById,
    doneStatusIds,
    filters: kanbanFilters,
    showSubIssues,
    hideBlocked,
    currentUserId: userId,
  });

  const setKanbanSearchQuery = useCallback(
    (searchQuery: string) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        searchQuery,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanPriorities = useCallback(
    (priorities: IssuePriority[]) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        priorities,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanAssignees = useCallback(
    (assigneeIds: string[]) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        assigneeIds,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanTags = useCallback(
    (tagIds: string[]) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        tagIds,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanSort = useCallback(
    (sortField: KanbanSortField, sortDirection: 'asc' | 'desc') => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        sortField,
        sortDirection,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setShowSubIssues = useCallback(
    (show: boolean) => {
      setKanbanProjectViewShowSubIssues(projectId, activeViewId, show);
    },
    [activeViewId, projectId, setKanbanProjectViewShowSubIssues]
  );

  const setShowWorkspaces = useCallback(
    (show: boolean) => {
      setKanbanProjectViewShowWorkspaces(projectId, activeViewId, show);
    },
    [activeViewId, projectId, setKanbanProjectViewShowWorkspaces]
  );

  const setHideBlocked = useCallback(
    (hide: boolean) => {
      setKanbanProjectViewHideBlocked(projectId, activeViewId, hide);
    },
    [activeViewId, projectId, setKanbanProjectViewHideBlocked]
  );

  const clearKanbanFilters = useCallback(() => {
    clearKanbanProjectViewPreferences(projectId, activeViewId);
  }, [activeViewId, clearKanbanProjectViewPreferences, projectId]);

  const handleKanbanProjectViewChange = useCallback(
    (viewId: string) => {
      setKanbanProjectView(projectId, viewId);
    },
    [projectId, setKanbanProjectView]
  );
  const kanbanViewMode = useUiPreferencesStore((s) => s.kanbanViewMode);
  const listViewStatusFilter = useUiPreferencesStore(
    (s) => s.listViewStatusFilter
  );
  const setKanbanViewMode = useUiPreferencesStore((s) => s.setKanbanViewMode);
  const setListViewStatusFilter = useUiPreferencesStore(
    (s) => s.setListViewStatusFilter
  );
  // Reset view mode when navigating projects
  const prevProjectIdRef = useRef<string | null>(null);

  // Track when drag-drop sync is in progress to prevent flicker
  const isSyncingRef = useRef(false);

  useEffect(() => {
    if (
      prevProjectIdRef.current !== null &&
      prevProjectIdRef.current !== projectId
    ) {
      setKanbanViewMode('kanban');
      setListViewStatusFilter(null);
    }

    prevProjectIdRef.current = projectId;
  }, [projectId, setKanbanViewMode, setListViewStatusFilter]);

  // Sort all statuses for display settings
  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order),
    [statuses]
  );

  // Filter statuses: visible (non-hidden) for kanban, hidden for tabs
  const visibleStatuses = useMemo(
    () => sortedStatuses.filter((s) => !s.hidden),
    [sortedStatuses]
  );

  // Map status ID to 1-based column index for sort_order calculation
  const statusColumnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    visibleStatuses.forEach((status, index) => {
      map.set(status.id, index + 1);
    });
    return map;
  }, [visibleStatuses]);

  const hiddenStatuses = useMemo(
    () => sortedStatuses.filter((s) => s.hidden),
    [sortedStatuses]
  );

  const defaultCreateStatusId = useMemo(() => {
    if (kanbanViewMode === 'kanban') {
      return visibleStatuses[0]?.id;
    }
    if (listViewStatusFilter) {
      return listViewStatusFilter;
    }
    return sortedStatuses[0]?.id;
  }, [kanbanViewMode, visibleStatuses, listViewStatusFilter, sortedStatuses]);

  // Update default create status for command bar based on current tab
  useEffect(() => {
    setDefaultCreateStatusId(defaultCreateStatusId);
  }, [defaultCreateStatusId, setDefaultCreateStatusId]);

  const createAssigneeIds = useMemo(() => {
    const assigneeIds = new Set<string>();

    for (const assigneeId of kanbanFilters.assigneeIds) {
      if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.UNASSIGNED) {
        continue;
      }

      if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.SELF) {
        if (userId) {
          assigneeIds.add(userId);
        }
        continue;
      }

      assigneeIds.add(assigneeId);
    }

    return [...assigneeIds];
  }, [kanbanFilters.assigneeIds, userId]);

  // Get statuses to display in list view (all or filtered to one)
  const listViewStatuses = useMemo(() => {
    if (listViewStatusFilter) {
      return sortedStatuses.filter((s) => s.id === listViewStatusFilter);
    }
    return sortedStatuses;
  }, [sortedStatuses, listViewStatusFilter]);

  // Track items as arrays of IDs grouped by status
  const [items, setItems] = useState<Record<string, string[]>>({});
  const [isFiltersDialogOpen, setIsFiltersDialogOpen] = useState(false);
  const [reviewStartingIds, setReviewStartingIds] = useState<Set<string>>(
    () => new Set()
  );
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  // Outcome of reviews started from the card in this browser session.
  const [reviewOutcomes, setReviewOutcomes] = useState<
    Record<string, 'running' | 'pass' | 'fail'>
  >({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  // Watch a started review process until it ends, then leave an issue comment
  // with the result (failure reason + what the user must do, or a pass note).
  const watchReviewProcess = useCallback(
    async (issueId: string, simpleId: string, processId: string) => {
      setReviewOutcomes((p) => ({ ...p, [issueId]: 'running' }));
      const deadline = Date.now() + 3 * 60 * 60 * 1000;
      let status = 'running';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const ep = await executionProcessesApi.getDetails(processId);
          status = String(ep.status);
          if (status !== 'running') break;
        } catch {
          /* transient; keep polling */
        }
      }
      if (status === 'running') return; // gave up watching
      type Entry = {
        type?: string;
        content?: { entry_type?: { type?: string }; content?: string };
      };
      const entries = await new Promise<Entry[]>((resolve) => {
        const c = streamJsonPatchEntries<Entry>(
          `/api/execution-processes/${processId}/normalized-logs/ws`,
          {
            onFinished: (all) => {
              c.close();
              resolve(all);
            },
            onError: () => {
              c.close();
              resolve([]);
            },
          }
        );
        setTimeout(() => {
          c.close();
          resolve([]);
        }, 20000);
      });
      const norm = entries
        .filter((e) => e?.type === 'NORMALIZED_ENTRY' && e.content)
        .map((e) => ({
          kind: e.content?.entry_type?.type ?? '',
          text: (e.content?.content ?? '').trim(),
        }));
      const lastAssistant = [...norm]
        .reverse()
        .find((e) => e.kind === 'assistant_message' && e.text)?.text;
      const errors = norm
        .filter((e) => e.kind === 'error_message' && e.text)
        .map((e) => e.text);
      const truncate = (t: string, n: number) =>
        t.length > n ? `${t.slice(0, n)}\n…(이하 생략, 리뷰 세션에서 전체 확인)` : t;
      const execFailed =
        status === 'failed' || status === 'killed' || !lastAssistant;
      let message: string;
      let outcome: 'pass' | 'fail';
      if (execFailed) {
        outcome = 'fail';
        const reason =
          errors.join('\n') ||
          (status === 'killed'
            ? '리뷰 프로세스가 중단(killed)되었어요.'
            : `리뷰 프로세스가 결과 없이 종료되었어요 (상태: ${status}).`);
        message = [
          `⚠️ 리뷰 실행 실패 (${simpleId})`,
          '',
          '**원인**',
          '```',
          truncate(reason, 1500),
          '```',
          '',
          '**👤 내가 해야 할 일**',
          '- [ ] 원인을 확인해 주세요 (Codex 실행 파일·버전, 권한, 네트워크 등).',
          '- [ ] 원인을 해결한 뒤 카드의 "🔍 리뷰 승인하고 시작"을 다시 눌러 주세요.',
          '- [ ] 원인을 모르겠으면 이 댓글을 Grok Bot에게 전달해 주세요.',
        ].join('\n');
      } else if (lastAssistant!.startsWith('🔴')) {
        outcome = 'fail';
        message = [
          `🔴 리뷰 실패 · 수정 필요 (${simpleId})`,
          '',
          '**리뷰 지적 사항 요약**',
          truncate(lastAssistant!, 3000),
          '',
          '**👤 내가 해야 할 일**',
          '- [ ] 위 🔴/🟡 지적 사항을 확인해 주세요.',
          '- [ ] 작업 세션에 수정을 요청하거나(후속 요청) 직접 수정해 주세요.',
          '- [ ] 수정이 끝나면 이슈를 In review로 옮기고 리뷰를 다시 승인해 주세요.',
        ].join('\n');
      } else {
        outcome = 'pass';
        message = [
          `✅ 리뷰 통과 (${simpleId})`,
          '',
          truncate(lastAssistant!, 800),
          '',
          '**👤 내가 해야 할 일**',
          '- [ ] 결과를 최종 확인하고 PR 병합 또는 Done 이동을 결정해 주세요.',
        ].join('\n');
      }
      setReviewOutcomes((p) => ({ ...p, [issueId]: outcome }));
      try {
        await createIssueComment(issueId, message);
        setReviewNotes((p) => ({
          ...p,
          [issueId]:
            outcome === 'pass'
              ? '✅ 리뷰 통과 · 결과를 이슈 댓글에 남겼어요'
              : '🔴 리뷰 실패 · 원인과 할 일을 이슈 댓글에 남겼어요',
        }));
      } catch (err) {
        setReviewErrors((prev) => ({
          ...prev,
          [issueId]: `리뷰 결과 댓글 작성 실패: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }));
      }
    },
    []
  );

  // Start a Codex REVIEW session for an issue in "In review" once the user
  // approves it on the card. Uses the issue's own workspace, or the parent
  // issue's workspace when the sub-issue was handled there.
  const startIssueReview = useCallback(
    async (
      issue: { id: string; simple_id: string; title: string; description?: string | null },
      localWorkspaceId: string,
      viaParent: boolean
    ) => {
      setReviewStartingIds((prev) => new Set(prev).add(issue.id));
      setReviewErrors((prev) => {
        const next = { ...prev };
        delete next[issue.id];
        return next;
      });
      try {
        const session = await sessionsApi.create({
          workspace_id: localWorkspaceId,
          executor: BaseCodingAgent.CODEX,
          name: `리뷰 ${issue.simple_id}`,
        });
        const additional = [
          `[리뷰 대상 이슈] ${issue.simple_id} (issue_id: ${issue.id}) ${issue.title}`,
          viaParent
            ? '이 이슈는 상위 이슈의 작업 공간에서 처리되었다. 변경분 중 이 이슈 범위에 해당하는 부분만 리뷰한다.'
            : '',
          '[리뷰 기준] 1) 이슈 설명의 "완료 조건"·"세부 실행 항목" 2) 연결된 openspec 명세(openspec/changes/<id>/) 3) 위가 없으면 일반 기준(보안·부작용·누락·테스트).',
          '[이슈 설명]',
          (issue.description ?? '').slice(0, 6000),
          '[결과 형식] 첫 줄을 `✅ 리뷰 통과` 또는 `🔴 수정 필요`로 시작하고, 지적 사항을 심각도(🔴/🟡/🟢)별 표로 정리한다.',
          '[상태 처리] 수정 필요이면 칸반 도구로 이 이슈를 In progress로 옮긴다. 통과이면 상태는 바꾸지 않는다(사람이 최종 확인). 이슈 댓글은 칸반 화면이 최종 응답을 읽어 자동으로 남기므로, 최종 응답에 지적 사항 요약과 "👤 내가 해야 할 일" 체크리스트를 반드시 포함한다.',
        ]
          .filter(Boolean)
          .join('\n');
        const reviewProcess = await sessionsApi.startReview(session.id, {
          executor_config: {
            executor: BaseCodingAgent.CODEX,
            variant: 'REVIEW',
            model_id: 'gpt-6.1-sol',
          },
          additional_prompt: additional,
          use_all_workspace_commits: true,
        });
        void watchReviewProcess(issue.id, issue.simple_id, reviewProcess.id);
      } catch (err) {
        setReviewOutcomes((p) => ({ ...p, [issue.id]: 'fail' }));
        setReviewErrors((prev) => ({
          ...prev,
          [issue.id]: err instanceof Error ? err.message : '리뷰 시작 실패',
        }));
      } finally {
        setReviewStartingIds((prev) => {
          const next = new Set(prev);
          next.delete(issue.id);
          return next;
        });
      }
    },
    [watchReviewProcess]
  );


  // Create a lookup map for issue data
  const issueMap = useMemo(() => {
    const map: Record<string, (typeof issues)[0]> = {};
    for (const issue of issues) {
      map[issue.id] = issue;
    }
    return map;
  }, [issues]);

  // Create a lookup map for issue assignees (issue_id -> OrganizationMemberWithProfile[])
  const issueAssigneesMap = useMemo(() => {
    const map: Record<string, OrganizationMemberWithProfile[]> = {};
    for (const assignee of issueAssignees) {
      const member = membersWithProfilesById.get(assignee.user_id);
      if (member) {
        if (!map[assignee.issue_id]) {
          map[assignee.issue_id] = [];
        }
        map[assignee.issue_id].push(member);
      }
    }
    return map;
  }, [issueAssignees, membersWithProfilesById]);

  const membersWithProfiles = useMemo(
    () => [...membersWithProfilesById.values()],
    [membersWithProfilesById]
  );

  const localWorkspacesById = useMemo(() => {
    const map = new Map<string, (typeof activeWorkspaces)[number]>();

    for (const workspace of activeWorkspaces) {
      map.set(workspace.id, workspace);
    }

    return map;
  }, [activeWorkspaces]);

  const prsByWorkspaceId = useMemo(() => {
    const map = new Map<string, WorkspacePr[]>();

    for (const pr of pullRequests) {
      if (!pr.workspace_id) continue;

      const prs = map.get(pr.workspace_id) ?? [];
      prs.push({
        number: pr.number,
        url: pr.url,
        status: pr.status as 'open' | 'merged' | 'closed',
      });
      map.set(pr.workspace_id, prs);
    }

    return map;
  }, [pullRequests]);

  // Pending approvals, resolved to their local workspace so they can be
  // answered directly from the board.
  const { pendingApprovals } = useApprovals();
  const [approvalWorkspace, setApprovalWorkspace] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    const unresolved = pendingApprovals.filter(
      (a) => !(a.execution_process_id in approvalWorkspace)
    );
    if (unresolved.length === 0) return;
    let cancelled = false;
    (async () => {
      const found: Record<string, string> = {};
      for (const a of unresolved) {
        try {
          const proc = await executionProcessesApi.getDetails(
            a.execution_process_id
          );
          const session = await sessionsApi.getById(proc.session_id);
          found[a.execution_process_id] = session.workspace_id;
        } catch {
          found[a.execution_process_id] = '';
        }
      }
      if (!cancelled) setApprovalWorkspace((prev) => ({ ...prev, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingApprovals, approvalWorkspace]);

  const approvalsByIssueId = useMemo(() => {
    const map = new Map<
      string,
      { approvals: ApprovalInfo[]; localWorkspaceId: string }
    >();
    if (pendingApprovals.length === 0) return map;
    for (const issue of issues) {
      for (const workspace of getWorkspacesForIssue(issue.id)) {
        const localId = workspace.local_workspace_id;
        if (workspace.archived || !localId) continue;
        const matched = pendingApprovals.filter(
          (a) => approvalWorkspace[a.execution_process_id] === localId
        );
        if (matched.length === 0) continue;
        const entry = map.get(issue.id) ?? {
          approvals: [],
          localWorkspaceId: localId,
        };
        entry.approvals.push(...matched);
        map.set(issue.id, entry);
      }
    }
    return map;
  }, [pendingApprovals, approvalWorkspace, issues, getWorkspacesForIssue]);

  // Agent activity per issue, shown as a badge on each card (independent of
  // the "show workspaces" view option).
  const agentStatusByIssueId = useMemo(() => {
    type AgentStatus = 'approval' | 'input' | 'running' | 'failed' | 'done';
    const rank: Record<AgentStatus, number> = {
      approval: 5,
      input: 4,
      running: 3,
      failed: 2,
      done: 1,
    };
    const map = new Map<string, AgentStatus>();
    for (const issue of issues) {
      let best: AgentStatus | null = null;
      for (const workspace of getWorkspacesForIssue(issue.id)) {
        if (workspace.archived || !workspace.local_workspace_id) continue;
        const local = localWorkspacesById.get(workspace.local_workspace_id);
        if (!local) continue;
        let st: AgentStatus | null = null;
        if (local.hasPendingApproval) st = 'approval';
        else if (local.isRunning) st = 'running';
        else if (
          local.latestProcessStatus === 'failed' ||
          local.latestProcessStatus === 'killed'
        )
          st = 'failed';
        else if (
          local.latestProcessStatus === 'completed' &&
          local.needsUserInput
        )
          st = 'input';
        else if (local.latestProcessStatus === 'completed') st = 'done';
        if (st && (!best || rank[st] > rank[best])) best = st;
      }
      if (best) map.set(issue.id, best);
    }
    return map;
  }, [issues, getWorkspacesForIssue, localWorkspacesById]);

  // Issues needing the user's action (approval, decision, result check,
  // open PR, review to approve, failed process/review).
  const actionNeededIssueIds = useMemo(() => {
    const set = new Set<string>();
    const needs = (st: string | undefined) =>
      st === 'approval' || st === 'input' || st === 'failed' || st === 'done';
    const hasLocalWs = (id: string) =>
      getWorkspacesForIssue(id).some(
        (w) => !w.archived && !!w.local_workspace_id
      );
    for (const issue of issues) {
      const id = issue.id;
      const own = agentStatusByIssueId.get(id);
      const statusName =
        statuses.find((x) => x.id === issue.status_id)?.name ?? '';
      // Finished/cancelled issues never need action.
      if (/done|complete|cancel|완료|취소/i.test(statusName)) continue;
      const parentSt = issue.parent_issue_id
        ? agentStatusByIssueId.get(issue.parent_issue_id)
        : undefined;
      const reviewBusy =
        reviewStartingIds.has(id) ||
        reviewOutcomes[id] === 'running' ||
        own === 'running' ||
        (!own && parentSt === 'running');
      if (
        approvalsByIssueId.has(id) ||
        needs(own) ||
        reviewOutcomes[id] === 'fail' ||
        getPullRequestsForIssue(id).some(
          (pr) => String(pr.status) !== 'merged' && String(pr.status) !== 'closed'
        ) ||
        (!own && !approvalsByIssueId.has(id) && needs(parentSt)) ||
        (/review/i.test(statusName) &&
          !reviewBusy &&
          (hasLocalWs(id) ||
            (!!issue.parent_issue_id && hasLocalWs(issue.parent_issue_id))))
      )
        set.add(id);
    }
    return set;
  }, [
    issues,
    statuses,
    agentStatusByIssueId,
    approvalsByIssueId,
    getPullRequestsForIssue,
    getWorkspacesForIssue,
    reviewStartingIds,
    reviewOutcomes,
  ]);

  // Sync items from filtered issues when they change
  useEffect(() => {
    // Skip rebuild during drag-drop sync to prevent flicker
    if (isSyncingRef.current) {
      return;
    }

    const { sortField, sortDirection } = kanbanFilters;
    const grouped: Record<string, string[]> = {};

    for (const status of statuses) {
      // Filter issues for this status
      let statusIssues = filteredIssues.filter(
        (i) => i.status_id === status.id
      );

      // Sort within column based on user preference
      statusIssues = [...statusIssues].sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case 'priority':
            comparison =
              (a.priority ? PRIORITY_ORDER[a.priority] : Infinity) -
              (b.priority ? PRIORITY_ORDER[b.priority] : Infinity);
            break;
          case 'created_at':
            comparison =
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime();
            break;
          case 'updated_at':
            comparison =
              new Date(a.updated_at).getTime() -
              new Date(b.updated_at).getTime();
            break;
          case 'title':
            comparison = a.title.localeCompare(b.title);
            break;
          case 'sort_order':
          default:
            comparison = a.sort_order - b.sort_order;
        }
        return sortDirection === 'desc' ? -comparison : comparison;
      });

      // Cards that need the user's action always float to the top
      // (stable: original order is kept within each group).
      const actionFirst = (list: typeof statusIssues) => [
        ...list.filter((i) => actionNeededIssueIds.has(i.id)),
        ...list.filter((i) => !actionNeededIssueIds.has(i.id)),
      ];

      // In the first column (To do), ready issues come before blocked ones.
      if (status.id === firstVisibleStatusId) {
        statusIssues = [
          ...actionFirst(statusIssues.filter((i) => !blockedIssueIds.has(i.id))),
          ...actionFirst(statusIssues.filter((i) => blockedIssueIds.has(i.id))),
        ];
      } else {
        statusIssues = actionFirst(statusIssues);
      }

      grouped[status.id] = statusIssues.map((i) => i.id);
    }
    setItems(grouped);
  }, [
    filteredIssues,
    statuses,
    kanbanFilters,
    firstVisibleStatusId,
    blockedIssueIds,
    actionNeededIssueIds,
  ]);

  const workspacesByIssueId = useMemo(() => {
    if (!showWorkspaces) {
      return new Map<string, WorkspaceWithStats[]>();
    }

    const map = new Map<string, WorkspaceWithStats[]>();

    for (const issue of issues) {
      const nonArchivedWorkspaces = getWorkspacesForIssue(issue.id)
        .filter(
          (workspace) =>
            !workspace.archived &&
            !!workspace.local_workspace_id &&
            localWorkspacesById.has(workspace.local_workspace_id)
        )
        .map((workspace) => {
          const localWorkspace = localWorkspacesById.get(
            workspace.local_workspace_id!
          );

          return {
            id: workspace.id,
            localWorkspaceId: workspace.local_workspace_id,
            name: workspace.name,
            archived: workspace.archived,
            filesChanged: workspace.files_changed ?? 0,
            linesAdded: workspace.lines_added ?? 0,
            linesRemoved: workspace.lines_removed ?? 0,
            prs: prsByWorkspaceId.get(workspace.id) ?? [],
            owner: membersWithProfilesById.get(workspace.owner_user_id) ?? null,
            updatedAt: workspace.updated_at,
            isOwnedByCurrentUser: workspace.owner_user_id === userId,
            isRunning: localWorkspace?.isRunning,
            hasPendingApproval: localWorkspace?.hasPendingApproval,
            hasRunningDevServer: localWorkspace?.hasRunningDevServer,
            hasUnseenActivity: localWorkspace?.hasUnseenActivity,
            latestProcessCompletedAt: localWorkspace?.latestProcessCompletedAt,
            latestProcessStatus: localWorkspace?.latestProcessStatus,
          };
        });

      if (nonArchivedWorkspaces.length > 0) {
        map.set(issue.id, nonArchivedWorkspaces);
      }
    }

    return map;
  }, [
    showWorkspaces,
    issues,
    getWorkspacesForIssue,
    localWorkspacesById,
    prsByWorkspaceId,
    membersWithProfilesById,
    userId,
  ]);

  // Calculate sort_order based on column index and issue position
  // Formula: 1000 * [COLUMN_INDEX] + [ISSUE_INDEX] (both 1-based)
  const calculateSortOrder = useCallback(
    (statusId: string, issueIndex: number): number => {
      const columnIndex = statusColumnIndexMap.get(statusId) ?? 1;
      return 1000 * columnIndex + (issueIndex + 1);
    },
    [statusColumnIndexMap]
  );

  // Simple onDragEnd handler - the library handles all visual movement
  const handleDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination } = result;

      // Dropped outside a valid droppable
      if (!destination) return;

      // No movement
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      ) {
        return;
      }

      const isManualSort = kanbanFilters.sortField === 'sort_order';

      // Block within-column reordering when not in manual sort mode
      // (cross-column moves are always allowed for status changes)
      if (source.droppableId === destination.droppableId && !isManualSort) {
        return;
      }

      const sourceId = source.droppableId;
      const destId = destination.droppableId;
      const isCrossColumn = sourceId !== destId;

      // Update local state and capture new items for bulk update
      let newItems: Record<string, string[]> = {};
      setItems((prev) => {
        const sourceItems = [...(prev[sourceId] ?? [])];
        const [moved] = sourceItems.splice(source.index, 1);

        if (!isCrossColumn) {
          // Within-column reorder
          sourceItems.splice(destination.index, 0, moved);
          newItems = { ...prev, [sourceId]: sourceItems };
        } else {
          // Cross-column move
          const destItems = [...(prev[destId] ?? [])];
          destItems.splice(destination.index, 0, moved);
          newItems = {
            ...prev,
            [sourceId]: sourceItems,
            [destId]: destItems,
          };
        }
        return newItems;
      });

      // Build bulk updates for all issues in affected columns
      const updates: BulkUpdateIssueItem[] = [];

      // Always update destination column
      const destIssueIds = newItems[destId] ?? [];
      destIssueIds.forEach((issueId, index) => {
        updates.push({
          id: issueId,
          changes: {
            status_id: destId,
            sort_order: calculateSortOrder(destId, index),
          },
        });
      });

      // Update source column if cross-column move
      if (isCrossColumn) {
        const sourceIssueIds = newItems[sourceId] ?? [];
        sourceIssueIds.forEach((issueId, index) => {
          updates.push({
            id: issueId,
            changes: {
              sort_order: calculateSortOrder(sourceId, index),
            },
          });
        });
      }

      // Perform bulk update
      isSyncingRef.current = true;
      bulkUpdateIssues(updates)
        .catch((err) => {
          console.error('Failed to bulk update sort order:', err);
        })
        .finally(() => {
          // Delay clearing flag to let Electric sync complete
          setTimeout(() => {
            isSyncingRef.current = false;
          }, 500);
        });
    },
    [kanbanFilters.sortField, calculateSortOrder]
  );

  // Multi-select support
  const {
    selectedIssueIds,
    isMultiSelectActive,
    handleIssueClick,
    handleCheckboxChange,
    clearSelection,
  } = useIssueMultiSelect();
  const setOrderedIssueIds = useIssueSelectionStore(
    (s) => s.setOrderedIssueIds
  );
  const setAnchor = useIssueSelectionStore((s) => s.setAnchor);

  // Compute ordered issue IDs for range selection
  const orderedIssueIds = useMemo(() => {
    const statusOrder =
      kanbanViewMode === 'kanban' ? visibleStatuses : listViewStatuses;
    return statusOrder.flatMap((status) => items[status.id] ?? []);
  }, [kanbanViewMode, visibleStatuses, listViewStatuses, items]);

  // Keep the store's ordered IDs in sync
  useEffect(() => {
    setOrderedIssueIds(orderedIssueIds);
  }, [orderedIssueIds, setOrderedIssueIds]);

  // Clear multi-selection when project or view mode changes
  useEffect(() => {
    clearSelection();
  }, [projectId, kanbanViewMode, clearSelection]);

  // Keep anchor in sync with the currently opened issue (e.g. from URL on
  // page load) so Shift/Cmd+Click on another issue includes it.
  useEffect(() => {
    if (selectedKanbanIssueId) {
      setAnchor(selectedKanbanIssueId);
    }
  }, [selectedKanbanIssueId, setAnchor]);

  const handleCardClick = useCallback(
    (issueId: string, e?: MouseEvent) => {
      if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        handleIssueClick(issueId, e);
      } else {
        if (selectedIssueIds.size > 0) {
          clearSelection();
        }
        // Set as anchor so Shift+Click from this issue works
        setAnchor(issueId);
        openIssue(issueId);
      }
    },
    [
      openIssue,
      handleIssueClick,
      selectedIssueIds.size,
      clearSelection,
      setAnchor,
    ]
  );

  const handleAddTask = useCallback(
    (statusId?: string) => {
      const createPayload = {
        statusId: statusId ?? defaultCreateStatusId,
        ...(createAssigneeIds.length > 0
          ? { assigneeIds: createAssigneeIds }
          : {}),
      };
      startCreate(createPayload);
    },
    [createAssigneeIds, defaultCreateStatusId, startCreate]
  );

  // Inline editing callbacks for kanban cards
  // When multi-select is active, apply to all selected issues
  const handleCardPriorityClick = useCallback(
    (issueId: string) => {
      const ids = isMultiSelectActive ? [...selectedIssueIds] : [issueId];
      openPrioritySelection(projectId, ids);
    },
    [projectId, openPrioritySelection, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardAssigneeClick = useCallback(
    (issueId: string) => {
      const ids = isMultiSelectActive ? [...selectedIssueIds] : [issueId];
      openAssigneeSelection(projectId, ids);
    },
    [projectId, openAssigneeSelection, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardMoreActionsClick = useCallback(
    (issueId: string) => {
      const ids = isMultiSelectActive ? [...selectedIssueIds] : [issueId];
      CommandBarDialog.show({
        page: 'issueActions',
        projectId,
        issueIds: ids,
      });
    },
    [projectId, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardTagToggle = useCallback(
    (issueId: string, tagId: string) => {
      const currentIssueTags = getTagsForIssue(issueId);
      const existing = currentIssueTags.find((it) => it.tag_id === tagId);
      if (existing) {
        removeIssueTag(existing.id);
      } else {
        insertIssueTag({ issue_id: issueId, tag_id: tagId });
      }
    },
    [getTagsForIssue, insertIssueTag, removeIssueTag]
  );

  const getResolvedRelationshipsForIssue = useCallback(
    (issueId: string) =>
      resolveRelationshipsForIssue(
        issueId,
        getRelationshipsForIssue(issueId),
        issuesById
      ),
    [getRelationshipsForIssue, issuesById]
  );

  const handleCreateTag = useCallback(
    (data: { name: string; color: string }): string => {
      const { data: newTag } = insertTag({
        project_id: projectId,
        name: data.name,
        color: data.color,
      });
      return newTag.id;
    },
    [insertTag, projectId]
  );

  const isLoading = projectLoading || orgLoading;

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col h-full space-y-base">
      <div
        className={cn(
          'px-double pt-double space-y-base',
          isMobile && 'px-base pt-base'
        )}
      >
        <div className="flex items-center gap-half">
          <h2 className={cn('text-2xl font-medium', isMobile && 'text-lg')}>
            {projectName}
          </h2>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                aria-label="Project menu"
              >
                <DotsThreeIcon className="size-icon-sm" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openProjectsGuide}>
                {t('kanban.openProjectsGuide', 'Projects guide')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => executeAction(Actions.ProjectSettings)}
              >
                {t('kanban.editProjectSettings', 'Edit project settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            'flex items-start gap-base',
            isMobile ? 'flex-col' : 'flex-wrap'
          )}
        >
          <ViewNavTabs
            activeView={kanbanViewMode}
            onViewChange={setKanbanViewMode}
            hiddenStatuses={hiddenStatuses}
            selectedStatusId={listViewStatusFilter}
            onStatusSelect={setListViewStatusFilter}
          />
          <KanbanFilterBar
            isFiltersDialogOpen={isFiltersDialogOpen}
            onFiltersDialogOpenChange={setIsFiltersDialogOpen}
            tags={tags}
            users={membersWithProfiles}
            activeViewId={activeViewId}
            onViewChange={handleKanbanProjectViewChange}
            viewIds={KANBAN_PROJECT_VIEW_IDS}
            projectId={projectId}
            currentUserId={userId}
            filters={kanbanFilters}
            showSubIssues={showSubIssues}
            showWorkspaces={showWorkspaces}
            hasActiveFilters={hasActiveFilters}
            onSearchQueryChange={setKanbanSearchQuery}
            onPrioritiesChange={setKanbanPriorities}
            onAssigneesChange={setKanbanAssignees}
            onTagsChange={setKanbanTags}
            onSortChange={setKanbanSort}
            onShowSubIssuesChange={setShowSubIssues}
            onShowWorkspacesChange={setShowWorkspaces}
            hideBlocked={hideBlocked}
            onHideBlockedChange={setHideBlocked}
            onClearFilters={clearKanbanFilters}
            onCreateIssue={handleAddTask}
            shouldAnimateCreateButton={shouldAnimateCreateButton}
            renderFiltersDialog={(props) => <KanbanFiltersDialog {...props} />}
            isMobile={isMobile}
          />
        </div>
      </div>

      <UnlinkedWorkspacesSection />

      {kanbanViewMode === 'kanban' ? (
        visibleStatuses.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-low">{t('kanban.noVisibleStatuses')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-x-auto px-double">
            <KanbanProvider onDragEnd={handleDragEnd}>
              {visibleStatuses.map((status) => {
                const issueIds = items[status.id] ?? [];
                const isSplitColumn = status.id === firstVisibleStatusId;
                const readyCount = isSplitColumn
                  ? issueIds.filter((id) => !blockedIssueIds.has(id)).length
                  : 0;
                const blockedCount = isSplitColumn
                  ? issueIds.length - readyCount
                  : 0;

                return (
                  <KanbanBoard key={status.id}>
                    <KanbanHeader>
                      <div className="border-t sticky border-b top-0 z-20 flex shrink-0 items-center justify-between gap-2 p-base bg-secondary">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: `hsl(${status.color})` }}
                          />
                          <p className="m-0 text-sm">{status.name}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddTask(status.id)}
                          className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                          aria-label="Add task"
                        >
                          <PlusIcon className="size-icon-xs" weight="bold" />
                        </button>
                      </div>
                    </KanbanHeader>
                    <KanbanCards id={status.id}>
                      {issueIds.map((issueId, index) => {
                        const issue = issueMap[issueId];
                        if (!issue) return null;
                        const issueWorkspaces =
                          workspacesByIssueId.get(issue.id) ?? [];
                        const workspaceIdsShownOnCard = new Set(
                          issueWorkspaces.map((workspace) => workspace.id)
                        );
                        const issueCardPullRequests = getPullRequestsForIssue(
                          issue.id
                        ).filter((pr) => {
                          if (!pr.workspace_id) {
                            return true;
                          }

                          // If this PR is already visible under a workspace card,
                          // do not render it again at the issue level.
                          return !workspaceIdsShownOnCard.has(pr.workspace_id);
                        });

                        const isBlockedCard =
                          isSplitColumn && blockedIssueIds.has(issue.id);
                        const showReadyHeader =
                          isSplitColumn && index === 0 && blockedCount > 0;
                        const showBlockedHeader =
                          isSplitColumn &&
                          isBlockedCard &&
                          index === readyCount;

                        return (
                          <Fragment key={issue.id}>
                          {showReadyHeader && (
                            <div className="px-base pt-half text-xs text-low">
                              바로 시작 가능 ({readyCount})
                            </div>
                          )}
                          {showBlockedHeader && (
                            <div className="px-base pt-base text-xs text-low border-t">
                              선행 작업 대기 ({blockedCount})
                            </div>
                          )}
                          <KanbanCard
                            key={issue.id}
                            id={issue.id}
                            name={issue.title}
                            index={index}
                            className={
                              isBlockedCard ? 'group opacity-60' : 'group'
                            }
                            onClick={(e) => handleCardClick(issue.id, e)}
                            isOpen={selectedKanbanIssueId === issue.id}
                            isMobile={isMobile}
                            isSelected={selectedIssueIds.has(issue.id)}
                            dragDisabled={isMultiSelectActive}
                          >
                            {(() => {
                              const pending = approvalsByIssueId.get(issue.id);
                              if (!pending) return null;
                              return (
                                <KanbanCardApprovals
                                  approvals={pending.approvals}
                                  onOpenDetails={() => {
                                    if (projectId) {
                                      appNavigation.goToProjectIssueWorkspace(
                                        projectId,
                                        issue.id,
                                        pending.localWorkspaceId
                                      );
                                    }
                                  }}
                                />
                              );
                            })()}
                            {actionNeededIssueIds.has(issue.id) && (
                              <div className="mb-half inline-flex rounded-sm bg-orange-500/25 px-half py-[1px] text-xs font-semibold text-orange-700 dark:text-orange-200">
                                👤 내 액션 필요
                              </div>
                            )}
                            {(() => {
                              const st = approvalsByIssueId.has(issue.id)
                                ? null
                                : agentStatusByIssueId.get(issue.id);
                              if (!st) return null;
                              const cfg = {
                                approval: {
                                  label: '⚠ 승인 필요',
                                  cls: 'bg-orange-500/20 text-orange-600 dark:text-orange-300',
                                },
                                input: {
                                  label: '🟠 결정 필요 · 답변 대기',
                                  cls: 'bg-orange-500/20 text-orange-600 dark:text-orange-300',
                                },
                                running: {
                                  label: '● 에이전트 작업 중',
                                  cls: 'bg-blue-500/20 text-blue-600 dark:text-blue-300 animate-pulse',
                                },
                                failed: {
                                  label: '✕ 실패·중단됨',
                                  cls: 'bg-red-500/20 text-red-600 dark:text-red-300',
                                },
                                done: {
                                  label: '✓ 응답 완료 · 결과 확인',
                                  cls: 'bg-green-500/15 text-green-700 dark:text-green-300',
                                },
                              }[st];
                              return (
                                <div
                                  className={`mb-half inline-flex rounded-sm px-half py-[1px] text-xs font-medium ${cfg.cls}`}
                                >
                                  {cfg.label}
                                </div>
                              );
                            })()}
                            {(() => {
                              // Sub-issue without its own agent work: point to
                              // the parent issue's workspace when that one is
                              // waiting for review or a decision.
                              if (
                                !issue.parent_issue_id ||
                                agentStatusByIssueId.has(issue.id) ||
                                approvalsByIssueId.has(issue.id)
                              )
                                return null;
                              const parentId = issue.parent_issue_id;
                              const pst = agentStatusByIssueId.get(parentId);
                              if (!pst) return null;
                              const parent = issuesById.get(parentId);
                              const parentWs = getWorkspacesForIssue(
                                parentId
                              ).find(
                                (w) => !w.archived && !!w.local_workspace_id
                              );
                              const label = {
                                approval: '상위 작업에서 승인 필요',
                                input: '상위 작업에서 결정 필요',
                                running: '상위 작업에서 진행 중',
                                failed: '상위 작업이 실패·중단됨',
                                done: '상위 작업 완료 · 결과 확인 필요',
                              }[pst];
                              const cls =
                                pst === 'running'
                                  ? 'bg-blue-500/10 text-blue-600 dark:text-blue-300'
                                  : pst === 'failed'
                                    ? 'bg-red-500/10 text-red-600 dark:text-red-300'
                                    : 'bg-orange-500/15 text-orange-600 dark:text-orange-300';
                              return (
                                <button
                                  type="button"
                                  className={`mb-half inline-flex rounded-sm px-half py-[1px] text-left text-xs font-medium hover:underline ${cls}`}
                                  title="클릭하면 상위 작업의 결과 화면으로 이동해요"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (projectId && parentWs?.local_workspace_id) {
                                      appNavigation.goToProjectIssueWorkspace(
                                        projectId,
                                        parentId,
                                        parentWs.local_workspace_id
                                      );
                                    }
                                  }}
                                >
                                  ↑ {parent?.simple_id ?? '상위'} {label} →
                                </button>
                              );
                            })()}
                            {(() => {
                              const prs = getPullRequestsForIssue(issue.id);
                              if (prs.length === 0) return null;
                              return (
                                <div className="mb-half flex flex-wrap gap-half">
                                  {prs.map((pr) => {
                                    const st = String(pr.status);
                                    const cfg =
                                      st === 'merged'
                                        ? {
                                            label: `✓ PR #${pr.number} 병합됨`,
                                            cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-300',
                                          }
                                        : st === 'closed'
                                          ? {
                                              label: `PR #${pr.number} 닫힘`,
                                              cls: 'bg-panel text-low',
                                            }
                                          : {
                                              label: `🔀 PR #${pr.number} 리뷰·병합 필요`,
                                              cls: 'bg-orange-500/20 text-orange-600 dark:text-orange-300',
                                            };
                                    return (
                                      <a
                                        key={pr.url}
                                        href={pr.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="GitHub에서 PR 열기"
                                        onClick={(e) => e.stopPropagation()}
                                        className={`inline-flex rounded-sm px-half py-[1px] text-xs font-medium hover:underline ${cfg.cls}`}
                                      >
                                        {cfg.label} ↗
                                      </a>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                            {(() => {
                              const statusName =
                                sortedStatuses.find(
                                  (x) => x.id === issue.status_id
                                )?.name ?? '';
                              if (!/review/i.test(statusName)) return null;
                              const own = getWorkspacesForIssue(issue.id).find(
                                (w) => !w.archived && !!w.local_workspace_id
                              );
                              const parentWs =
                                !own && issue.parent_issue_id
                                  ? getWorkspacesForIssue(
                                      issue.parent_issue_id
                                    ).find(
                                      (w) =>
                                        !w.archived && !!w.local_workspace_id
                                    )
                                  : undefined;
                              const target = own ?? parentWs;
                              const st =
                                agentStatusByIssueId.get(issue.id) ??
                                (parentWs && issue.parent_issue_id
                                  ? agentStatusByIssueId.get(
                                      issue.parent_issue_id
                                    )
                                  : undefined);
                              const busy =
                                st === 'running' ||
                                st === 'approval' ||
                                reviewStartingIds.has(issue.id) ||
                                reviewOutcomes[issue.id] === 'running';
                              const err = reviewErrors[issue.id];
                              if (!target?.local_workspace_id) {
                                return (
                                  <div className="mb-half rounded-sm bg-panel px-half py-[1px] text-xs text-low">
                                    🔍 리뷰할 작업 공간이 없어요(PR 또는 상위 작업 연결 필요)
                                  </div>
                                );
                              }
                              const wsId = target.local_workspace_id;
                              return (
                                <div className="mb-half flex flex-col gap-[2px]">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void startIssueReview(
                                        issue,
                                        wsId,
                                        !own
                                      );
                                    }}
                                    className="inline-flex w-fit rounded-sm bg-brand/20 px-half py-[2px] text-xs font-medium text-brand hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
                                    title="승인하면 Codex 리뷰 세션을 시작해요"
                                  >
                                    {reviewStartingIds.has(issue.id)
                                      ? '🔍 리뷰 시작하는 중…'
                                      : st === 'running'
                                        ? '🔍 에이전트 작업 중 · 끝나면 리뷰 가능'
                                        : st === 'done' || st === 'input'
                                          ? '🔍 리뷰 준비됨 · 승인하고 시작 ▶'
                                          : '🔍 리뷰 승인하고 시작 ▶'}
                                  </button>
                                  {!own && (
                                    <span className="text-[10px] text-low">
                                      상위 작업 공간의 변경분을 이 이슈 범위로 리뷰해요
                                    </span>
                                  )}
                                  {reviewOutcomes[issue.id] === 'running' && (
                                    <span className="text-[10px] text-blue-500">
                                      리뷰 결과를 기다리는 중 · 끝나면 이슈 댓글로 남겨요
                                    </span>
                                  )}
                                  {reviewNotes[issue.id] &&
                                    reviewOutcomes[issue.id] !== 'running' && (
                                      <span className="text-[10px] text-low">
                                        {reviewNotes[issue.id]}
                                      </span>
                                    )}
                                  {err && (
                                    <span className="text-[10px] text-red-500">
                                      리뷰 시작 실패: {err}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                            <KanbanCardContent
                              displayId={issue.simple_id}
                              title={issue.title}
                              description={issue.description}
                              priority={issue.priority}
                              tags={getTagObjectsForIssue(issue.id)}
                              assignees={issueAssigneesMap[issue.id] ?? []}
                              pullRequests={issueCardPullRequests}
                              relationships={resolveRelationshipsForIssue(
                                issue.id,
                                getRelationshipsForIssue(issue.id),
                                issuesById
                              )}
                              isSubIssue={!!issue.parent_issue_id}
                              isMobile={isMobile}
                              onPriorityClick={(e) => {
                                e.stopPropagation();
                                handleCardPriorityClick(issue.id);
                              }}
                              onAssigneeClick={(e) => {
                                e.stopPropagation();
                                handleCardAssigneeClick(issue.id);
                              }}
                              onMoreActionsClick={() =>
                                handleCardMoreActionsClick(issue.id)
                              }
                              tagEditProps={{
                                allTags: tags,
                                selectedTagIds: getTagsForIssue(issue.id).map(
                                  (it) => it.tag_id
                                ),
                                onTagToggle: (tagId) =>
                                  handleCardTagToggle(issue.id, tagId),
                                onCreateTag: handleCreateTag,
                                renderTagEditor: ({
                                  allTags,
                                  selectedTagIds,
                                  onTagToggle,
                                  onCreateTag,
                                  trigger,
                                }) => (
                                  <SearchableTagDropdownContainer
                                    tags={allTags}
                                    selectedTagIds={selectedTagIds}
                                    onTagToggle={onTagToggle}
                                    onCreateTag={onCreateTag}
                                    disabled={false}
                                    contentClassName=""
                                    trigger={trigger}
                                  />
                                ),
                              }}
                            />
                            {issueWorkspaces.length > 0 && (
                              <div className="mt-base flex flex-col gap-half">
                                {issueWorkspaces.map((workspace) => (
                                  <IssueWorkspaceCard
                                    key={workspace.id}
                                    workspace={workspace}
                                    onClick={
                                      workspace.localWorkspaceId
                                        ? () =>
                                            openIssueWorkspace(
                                              issue.id,
                                              workspace.localWorkspaceId!
                                            )
                                        : undefined
                                    }
                                    showOwner={false}
                                    showStatusBadge={false}
                                    showNoPrText={false}
                                  />
                                ))}
                              </div>
                            )}
                          </KanbanCard>
                          </Fragment>
                        );
                      })}
                    </KanbanCards>
                  </KanbanBoard>
                );
              })}
            </KanbanProvider>
          </div>
        )
      ) : (
        <div className="flex-1 overflow-y-auto px-double">
          <KanbanProvider onDragEnd={handleDragEnd} className="!block !w-full">
            <IssueListView
              statuses={listViewStatuses}
              items={items}
              issueMap={issueMap}
              issueAssigneesMap={issueAssigneesMap}
              getTagObjectsForIssue={getTagObjectsForIssue}
              getResolvedRelationshipsForIssue={
                getResolvedRelationshipsForIssue
              }
              onIssueClick={handleCardClick}
              selectedIssueId={selectedKanbanIssueId}
              selectedIssueIds={selectedIssueIds}
              isMultiSelectActive={isMultiSelectActive}
              onIssueCheckboxChange={handleCheckboxChange}
            />
          </KanbanProvider>
        </div>
      )}

      {isMultiSelectActive && <BulkActionBarContainer projectId={projectId} />}
    </div>
  );
}

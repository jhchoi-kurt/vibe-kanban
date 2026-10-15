import type {
  Issue,
  IssueRelationship,
  ProjectStatus,
} from 'shared/remote-types';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';

/**
 * Rule: an issue may not move forward (any status other than a backlog/To do
 * type status) or be started/reviewed until ALL its blocking predecessors are
 * in a Done-category status.
 */

/** Done-category = hidden statuses (e.g. Cancelled) + the last visible one. */
export function computeDoneStatusIds(statuses: ProjectStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const s of statuses) if (s.hidden) ids.add(s.id);
  const visible = statuses
    .filter((s) => !s.hidden)
    .sort((a, b) => a.sort_order - b.sort_order);
  const last = visible[visible.length - 1];
  if (last) ids.add(last.id);
  return ids;
}

const BACKLOG_LIKE = /backlog|to\s*-?\s*do|할\s*일|백로그|대기/i;

export function isBacklogLikeStatus(status: ProjectStatus | undefined) {
  return !!status && BACKLOG_LIKE.test(status.name);
}

export function getUnfinishedBlockers(
  issueId: string,
  issuesById: Map<string, Issue>,
  relationships: IssueRelationship[],
  doneStatusIds: Set<string>
): Issue[] {
  const out: Issue[] = [];
  for (const r of relationships) {
    if (r.relationship_type !== 'blocking' || r.related_issue_id !== issueId)
      continue;
    const blocker = issuesById.get(r.issue_id);
    if (blocker && !doneStatusIds.has(blocker.status_id)) out.push(blocker);
  }
  return out;
}

export function blockerLabel(blockers: Pick<Issue, 'simple_id'>[]) {
  return blockers.map((b) => b.simple_id).join(', ');
}

export function blockerMessage(
  blockers: Pick<Issue, 'simple_id'>[],
  action = '옮길'
) {
  return `선행 작업 ${blockerLabel(blockers)}가 끝나야 ${action} 수 있어요`;
}

/**
 * Returns an error message when moving `issueId` to `targetStatusId` violates
 * the rule, otherwise null.
 */
export function checkStatusMove(
  issueId: string,
  targetStatusId: string,
  statuses: ProjectStatus[],
  issuesById: Map<string, Issue>,
  relationships: IssueRelationship[]
): string | null {
  const target = statuses.find((s) => s.id === targetStatusId);
  if (!target || isBacklogLikeStatus(target)) return null;
  const blockers = getUnfinishedBlockers(
    issueId,
    issuesById,
    relationships,
    computeDoneStatusIds(statuses)
  );
  return blockers.length ? blockerMessage(blockers) : null;
}

/** Minimal dependency-free toast. */
export function showBlockerToast(message: string) {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.textContent = `⛔ ${message}`;
  el.setAttribute('role', 'alert');
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99999',
    background: '#b91c1c',
    color: '#fff',
    padding: '10px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    boxShadow: '0 4px 12px rgba(0,0,0,.25)',
    maxWidth: '90vw',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 4000);
}

async function getJson(path: string): Promise<unknown> {
  const res = await makeLocalApiRequest(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function unwrapList<T>(v: unknown, key: string): T[] {
  let d: unknown = v;
  for (let i = 0; i < 4 && d && !Array.isArray(d); i++) {
    const o = d as Record<string, unknown>;
    d = o[key] ?? o.data;
  }
  return Array.isArray(d) ? (d as T[]) : [];
}

/**
 * REST-based check for code paths outside a ProjectProvider (e.g. workspace
 * creation). Returns unfinished blockers; on lookup failure returns [] so the
 * guard never blocks because of a transient network error.
 */
export async function fetchUnfinishedBlockers(
  issueId: string
): Promise<Issue[]> {
  try {
    const rels = unwrapList<IssueRelationship>(
      await getJson(
        `/api/remote/issue-relationships?issue_id=${encodeURIComponent(issueId)}`
      ),
      'issue_relationships'
    ).filter(
      (r) =>
        r.relationship_type === 'blocking' && r.related_issue_id === issueId
    );
    if (!rels.length) return [];
    const blockers: Issue[] = [];
    let statuses: ProjectStatus[] | null = null;
    for (const r of rels) {
      const raw = (await getJson(
        `/api/remote/issues/${encodeURIComponent(r.issue_id)}`
      )) as Record<string, unknown>;
      let issue: unknown = raw;
      while (
        issue &&
        typeof issue === 'object' &&
        !('status_id' in (issue as object)) &&
        'data' in (issue as object)
      )
        issue = (issue as Record<string, unknown>).data;
      const b = issue as Issue;
      if (!b?.status_id) continue;
      if (!statuses)
        statuses = unwrapList<ProjectStatus>(
          await getJson(
            `/api/remote/project-statuses?project_id=${encodeURIComponent(b.project_id)}`
          ),
          'project_statuses'
        );
      if (!computeDoneStatusIds(statuses).has(b.status_id)) blockers.push(b);
    }
    return blockers;
  } catch (e) {
    console.warn('blocker lookup failed', e);
    return [];
  }
}

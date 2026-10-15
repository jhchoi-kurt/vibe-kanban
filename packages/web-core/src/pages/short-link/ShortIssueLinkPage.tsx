import { useEffect, useState } from 'react';
import type { Issue, Project } from 'shared/remote-types';
import { organizationsApi } from '@/shared/lib/api';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

export const SHORT_ISSUE_KEY_REGEX = /^[a-z]+-\d+$/i;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const body = await res.json();
  return (body?.data ?? body) as T;
}

async function findIssueByKey(
  key: string
): Promise<{ projectId: string; issueId: string } | null> {
  const wanted = key.toLowerCase();
  const { organizations = [] } = await organizationsApi.getUserOrganizations();
  for (const org of organizations) {
    const { projects = [] } = await getJson<{ projects: Project[] }>(
      `/api/remote/projects?organization_id=${encodeURIComponent(org.id)}`
    );
    for (const project of projects) {
      const { issues = [] } = await getJson<{ issues: Issue[] }>(
        `/api/remote/issues?project_id=${encodeURIComponent(project.id)}`
      );
      const hit = issues.find((i) => i.simple_id?.toLowerCase() === wanted);
      if (hit) return { projectId: project.id, issueId: hit.id };
    }
  }
  return null;
}

/** /bdb-6 → /projects/<projectId>/issues/<issueId> */
export function ShortIssueLinkPage({ shortKey }: { shortKey: string }) {
  const appNavigation = useAppNavigation();
  const valid = SHORT_ISSUE_KEY_REGEX.test(shortKey);
  const [state, setState] = useState<'loading' | 'notfound' | 'error'>(
    valid ? 'loading' : 'notfound'
  );

  useEffect(() => {
    if (!valid) return;
    let active = true;
    findIssueByKey(shortKey)
      .then((hit) => {
        if (!active) return;
        if (hit) {
          appNavigation.goToProjectIssue(hit.projectId, hit.issueId, {
            replace: true,
          });
        } else {
          setState('notfound');
        }
      })
      .catch((err) => {
        console.error('Short link lookup failed:', err);
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [shortKey, valid, appNavigation]);

  return (
    <div className="h-screen bg-primary flex flex-col items-center justify-center gap-base">
      {state === 'loading' && (
        <p className="text-low">{shortKey.toUpperCase()} 이슈를 찾는 중…</p>
      )}
      {state !== 'loading' && (
        <>
          <p className="text-normal">
            {state === 'error'
              ? `${shortKey} 이슈를 찾는 중 오류가 났어요.`
              : `${shortKey.toUpperCase()} 이슈를 찾을 수 없어요.`}
          </p>
          <button
            type="button"
            className="text-sm text-brand hover:underline"
            onClick={() => appNavigation.goToRoot()}
          >
            칸반 보드로 돌아가기
          </button>
        </>
      )}
    </div>
  );
}

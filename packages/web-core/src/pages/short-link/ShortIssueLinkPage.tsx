import { useEffect, useState } from 'react';
import {
  PROJECTS_SHAPE,
  PROJECT_ISSUES_SHAPE,
  type Issue,
  type Project,
} from 'shared/remote-types';
import { organizationsApi } from '@/shared/lib/api';
import { createShapeCollection } from '@/shared/lib/electric/collections';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

export const SHORT_ISSUE_KEY_REGEX = /^[a-z]+-\d+$/i;

const LOOKUP_TIMEOUT_MS = 8000;

function waitForRows<T>(collection: {
  isReady: () => boolean;
  toArray: unknown;
  subscribeChanges: (
    cb: () => void,
    opts: { includeInitialState: boolean }
  ) => { unsubscribe: () => void };
}): Promise<T[]> {
  const rows = () => collection.toArray as unknown as T[];
  if (collection.isReady()) return Promise.resolve(rows());
  return new Promise((resolve) => {
    let done = false;
    let sub: { unsubscribe: () => void } | undefined;
    const finish = (value: T[]) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      sub?.unsubscribe();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish([]), LOOKUP_TIMEOUT_MS);
    const check = () => {
      if (collection.isReady()) finish(rows());
    };
    sub = collection.subscribeChanges(check, { includeInitialState: true });
    check();
  });
}

async function findIssueByKey(
  key: string
): Promise<{ projectId: string; issueId: string } | null> {
  const wanted = key.toLowerCase();
  const { organizations = [] } = await organizationsApi.getUserOrganizations();
  for (const org of organizations) {
    const projects = await waitForRows<Project>(
      createShapeCollection(PROJECTS_SHAPE, { organization_id: org.id })
    );
    for (const project of projects) {
      const issues = await waitForRows<Issue>(
        createShapeCollection(PROJECT_ISSUES_SHAPE, { project_id: project.id })
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

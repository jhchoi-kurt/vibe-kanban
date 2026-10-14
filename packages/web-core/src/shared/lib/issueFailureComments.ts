import { createIssueComment } from '@/shared/lib/remoteApi';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';

// One failure = one comment. Keys live in localStorage so reloads and other
// tabs on the same origin don't post the same failure twice.
const PREFIX = 'vk-issue-fail-comment:';

export function wasFailureCommented(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) !== null;
  } catch {
    return false;
  }
}

export function markFailureCommented(key: string) {
  try {
    localStorage.setItem(PREFIX + key, String(Date.now()));
  } catch {
    /* ignore */
  }
}

const inFlight = new Set<string>();

/** Post a failure comment once per key. Returns true when posted now. */
export async function postFailureCommentOnce(
  key: string,
  issueId: string,
  message: string
): Promise<boolean> {
  if (inFlight.has(key) || wasFailureCommented(key)) return false;
  inFlight.add(key);
  markFailureCommented(key);
  try {
    await createIssueComment(issueId, message);
    return true;
  } catch (err) {
    // allow a retry later
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
    console.error('Failed to post failure comment:', err);
    return false;
  } finally {
    inFlight.delete(key);
  }
}

/** Error lines (and last assistant text) from a finished process log. */
export async function collectProcessErrors(
  processId: string
): Promise<{ errors: string[]; lastAssistant?: string }> {
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
  return {
    errors: norm
      .filter((e) => e.kind === 'error_message' && e.text)
      .map((e) => e.text),
    lastAssistant: [...norm]
      .reverse()
      .find((e) => e.kind === 'assistant_message' && e.text)?.text,
  };
}

const truncate = (t: string, n: number) =>
  t.length > n ? `${t.slice(0, n)}\n…(이하 생략, 작업 세션에서 전체 확인)` : t;

export function buildRunFailureMessage(opts: {
  simpleId: string;
  stage: string;
  reason: string;
  workspaceUrl?: string;
  retryHint: string;
}): string {
  return [
    `⚠️ 실행 실패 (${opts.simpleId}) · ${opts.stage}`,
    '',
    '**원인**',
    '```',
    truncate(opts.reason || '원인 메시지가 남지 않았어요.', 1500),
    '```',
    opts.workspaceUrl ? `작업 공간: ${opts.workspaceUrl}` : '',
    '',
    '**👤 내가 해야 할 일**',
    '- [ ] 위 원인을 확인해 주세요 (CLI 실행 파일·버전, 로그인/API 키, 저장소·브랜치 선택, 네트워크 등).',
    `- [ ] 원인을 해결한 뒤 ${opts.retryHint}`,
    '- [ ] 원인을 모르겠으면 이 댓글을 Grok Bot에게 전달해 주세요.',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

//! Blocking-predecessor guard (mirrors frontend `blockerGuard.ts`).
//!
//! Rule: an issue may not move into any status other than a backlog / To do
//! type status, nor be started or reviewed, until ALL of its blocking
//! predecessors are in a Done-category status (a hidden status, or the last
//! visible column).

use std::collections::HashSet;

use api_types::{IssueRelationshipType, ProjectStatus};
use futures_util::{StreamExt, stream};
use services::services::remote_client::RemoteClient;
use uuid::Uuid;

use crate::error::ApiError;

/// Status names that a blocked issue may still be moved into.
pub fn is_backlog_like(name: &str) -> bool {
    let lower = name.to_lowercase();
    let compact: String = lower
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    compact.contains("backlog")
        || compact.contains("todo")
        || compact.contains("할일")
        || compact.contains("백로그")
        || compact.contains("대기")
}

/// Done-category = hidden statuses + the last visible status by sort order.
pub fn done_status_ids(statuses: &[ProjectStatus]) -> HashSet<Uuid> {
    let mut ids: HashSet<Uuid> = statuses.iter().filter(|s| s.hidden).map(|s| s.id).collect();
    if let Some(last) = statuses.iter().filter(|s| !s.hidden).max_by(|a, b| {
        a.sort_order
            .partial_cmp(&b.sort_order)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        ids.insert(last.id);
    }
    ids
}

pub fn blocker_message(simple_ids: &[String], action: &str) -> String {
    format!(
        "⛔ 선행 작업 {}가 끝나야 {action} 수 있어요",
        simple_ids.join(", ")
    )
}

/// Returns the simple ids of unfinished blocking predecessors of `issue_id`.
///
/// The relationships API only lists a relationship under its source issue
/// (`issue_id` = blocker), so we scan the project's not-yet-done issues and
/// look for `blocking` relationships that point at `issue_id`. Done issues can
/// never be unfinished blockers, so they are skipped.
pub async fn unfinished_blockers(
    client: &RemoteClient,
    issue_id: Uuid,
    project_id: Uuid,
    statuses: Option<&[ProjectStatus]>,
) -> Result<Vec<String>, ApiError> {
    let owned;
    let statuses = match statuses {
        Some(s) => s,
        None => {
            owned = client
                .list_project_statuses(project_id)
                .await?
                .project_statuses;
            &owned[..]
        }
    };
    let done = done_status_ids(statuses);
    let candidates: Vec<_> = client
        .list_issues(project_id)
        .await?
        .issues
        .into_iter()
        .filter(|i| i.id != issue_id && !done.contains(&i.status_id))
        .collect();

    let results: Vec<_> = stream::iter(candidates.into_iter().map(|c| async move {
        let rels = client.list_issue_relationships(c.id).await;
        (c, rels)
    }))
    .buffer_unordered(16)
    .collect()
    .await;

    let mut out: Vec<(i32, String)> = Vec::new();
    for (candidate, rels) in results {
        let rels = rels?;
        if rels.issue_relationships.iter().any(|r| {
            matches!(r.relationship_type, IssueRelationshipType::Blocking)
                && r.issue_id == candidate.id
                && r.related_issue_id == issue_id
        }) {
            out.push((candidate.issue_number, candidate.simple_id));
        }
    }
    out.sort();
    Ok(out.into_iter().map(|(_, s)| s).collect())
}

/// Guard for a status change of an existing issue.
pub async fn ensure_status_move_allowed(
    client: &RemoteClient,
    issue_id: Uuid,
    target_status_id: Uuid,
) -> Result<(), ApiError> {
    let issue = client.get_issue(issue_id).await?;
    if issue.status_id == target_status_id {
        return Ok(());
    }
    let statuses = client
        .list_project_statuses(issue.project_id)
        .await?
        .project_statuses;
    match statuses.iter().find(|s| s.id == target_status_id) {
        None => return Ok(()),
        Some(s) if is_backlog_like(&s.name) => return Ok(()),
        Some(_) => {}
    }
    let blockers = unfinished_blockers(client, issue_id, issue.project_id, Some(&statuses)).await?;
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(ApiError::Conflict(blocker_message(&blockers, "옮길")))
    }
}

/// Guard for starting work / review on an issue.
pub async fn ensure_issue_startable(
    client: &RemoteClient,
    issue_id: Uuid,
    action: &str,
) -> Result<(), ApiError> {
    // Lookup failures must not block starting work (fail open, like the UI).
    let blockers = match client.get_issue(issue_id).await {
        Ok(issue) => match unfinished_blockers(client, issue_id, issue.project_id, None).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(?e, %issue_id, "blocker lookup failed");
                Vec::new()
            }
        },
        Err(e) => {
            tracing::warn!(?e, %issue_id, "blocker lookup failed");
            Vec::new()
        }
    };
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(ApiError::Conflict(blocker_message(&blockers, action)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_like_names() {
        for n in [
            "Backlog",
            "To do",
            "TODO",
            "to-do",
            "할 일",
            "백로그",
            "대기",
        ] {
            assert!(is_backlog_like(n), "{n}");
        }
        for n in ["In progress", "In review", "Done", "Cancelled"] {
            assert!(!is_backlog_like(n), "{n}");
        }
    }

    #[test]
    fn message_format() {
        assert_eq!(
            blocker_message(&["BDB-14".into()], "옮길"),
            "⛔ 선행 작업 BDB-14가 끝나야 옮길 수 있어요"
        );
    }
}

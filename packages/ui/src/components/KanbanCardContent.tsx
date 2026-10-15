"use client";

import type { MouseEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleDashedIcon,
  DotsThreeIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { cn } from "../lib/cn";
import { PriorityIcon, type PriorityLevel } from "./PriorityIcon";
import { KanbanBadge } from "./KanbanBadge";
import { KanbanAssignee, type KanbanAssigneeUser } from "./KanbanAssignee";
import { RunningDots } from "./RunningDots";
import { PrBadge, type PrBadgeStatus } from "./PrBadge";
import {
  RelationshipBadge,
  type RelationshipDisplayType,
} from "./RelationshipBadge";

export interface KanbanTag {
  id: string;
  name: string;
  color: string;
}

export interface KanbanRelationship {
  relationshipId: string;
  displayType: RelationshipDisplayType;
  relatedIssueDisplayId: string;
  relatedIssueId?: string;
}

const PRIORITY_LABELS: Record<PriorityLevel, { label: string; cls: string }> = {
  urgent: { label: "긴급", cls: "bg-red-500/15 text-red-600 dark:text-red-300" },
  high: {
    label: "높음",
    cls: "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  },
  medium: { label: "보통", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
  low: { label: "낮음", cls: "bg-panel text-low" },
};

const chipCls =
  "inline-flex items-center h-5 px-half rounded-sm text-xs font-medium whitespace-nowrap";

export interface KanbanPullRequest {
  id: string;
  number: number;
  url: string;
  status: PrBadgeStatus;
}

export interface TagEditRenderProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  trigger: ReactNode;
}

export interface TagEditProps<TTag extends KanbanTag = KanbanTag> {
  allTags: TTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  renderTagEditor?: (props: TagEditRenderProps<TTag>) => ReactNode;
}

const IMAGE_FILE_EXTENSION_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;

function isImageLikeAttachmentName(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) {
    return false;
  }

  return IMAGE_FILE_EXTENSION_REGEX.test(normalized);
}

function formatKanbanDescriptionPreview(
  markdown: string,
  options: {
    codeBlockLabel: string;
    imageLabel: string;
    imageWithNameLabel: (name: string) => string;
    fileLabel: string;
    fileWithNameLabel: (name: string) => string;
  },
): string {
  return markdown
    .replace(/```[\s\S]*?```/g, options.codeBlockLabel)
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, altText: string, url: string) => {
        const normalizedAlt = altText.trim();
        const normalizedUrl = url.trim();
        const isImageAttachment =
          normalizedUrl.startsWith("attachment://") &&
          isImageLikeAttachmentName(normalizedAlt);

        if (isImageAttachment) {
          return normalizedAlt
            ? options.imageWithNameLabel(normalizedAlt)
            : options.imageLabel;
        }

        return normalizedAlt
          ? options.fileWithNameLabel(normalizedAlt)
          : options.fileLabel;
      },
    )
    .replace(
      /(?<!!)\[([^\]]*)\]\((attachment:\/\/[^)]+|\.vibe-attachments\/[^)]+)\)/g,
      (_match, label: string) => {
        const normalizedLabel = label.trim();
        return normalizedLabel
          ? options.fileWithNameLabel(normalizedLabel)
          : options.fileLabel;
      },
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type KanbanCardContentProps<TTag extends KanbanTag = KanbanTag> = {
  displayId: string;
  title: string;
  description?: string | null;
  priority: PriorityLevel | null;
  tags: KanbanTag[];
  assignees: KanbanAssigneeUser[];
  pullRequests?: KanbanPullRequest[];
  relationships?: KanbanRelationship[];
  isSubIssue?: boolean;
  isLoading?: boolean;
  className?: string;
  onPriorityClick?: (e: MouseEvent) => void;
  onAssigneeClick?: (e: MouseEvent) => void;
  onMoreActionsClick?: () => void;
  tagEditProps?: TagEditProps<TTag>;
  isMobile?: boolean;
  /** Optional AI owner chip (executor · model · preset) */
  aiChip?: ReactNode;
  /** True when at least one blocker (선행 작업) is not Done/Cancelled */
  isBlocked?: boolean;
  /** Open a related issue (relation chips, parent line) */
  onRelatedIssueClick?: (issueId: string) => void;
  parentIssue?: { id: string; displayId: string } | null;
  childSummary?: { total: number; done: number } | null;
  /** Short link (e.g. http://localhost:3000/bdb-6); click on the id copies it */
  shortLink?: string;
};

export function KanbanCardContent<TTag extends KanbanTag = KanbanTag>({
  displayId,
  title,
  description,
  priority,
  tags,
  assignees,
  pullRequests = [],
  relationships = [],
  isSubIssue,
  isLoading = false,
  className,
  onPriorityClick,
  onAssigneeClick,
  onMoreActionsClick,
  tagEditProps,
  isMobile,
  aiChip,
  isBlocked,
  onRelatedIssueClick,
  parentIssue,
  childSummary,
  shortLink,
}: KanbanCardContentProps<TTag>) {
  const [copied, setCopied] = useState(false);
  const blockingRels = relationships.filter(
    (r) => r.displayType === "blocked_by" || r.displayType === "blocks",
  );
  const otherRels = relationships.filter(
    (r) => r.displayType !== "blocked_by" && r.displayType !== "blocks",
  );
  const openRelated = (e: MouseEvent, id?: string) => {
    e.stopPropagation();
    if (id && onRelatedIssueClick) onRelatedIssueClick(id);
  };
  const { t } = useTranslation("common");
  const previewDescription = useMemo(() => {
    if (!description) {
      return null;
    }

    const formatted = formatKanbanDescriptionPreview(description, {
      codeBlockLabel: t("kanban.previewCodeBlock"),
      imageLabel: t("kanban.previewImage"),
      imageWithNameLabel: (name: string) =>
        t("kanban.previewImageWithName", { name }),
      fileLabel: t("kanban.previewFile"),
      fileWithNameLabel: (name: string) =>
        t("kanban.previewFileWithName", { name }),
    });
    return formatted.length > 0 ? formatted : null;
  }, [description, t]);

  const tagsDisplay = (
    <>
      {tags.slice(0, 2).map((tag) => (
        <KanbanBadge key={tag.id} name={tag.name} color={tag.color} />
      ))}
      {tags.length > 2 && (
        <span className="text-sm text-low">+{tags.length - 2}</span>
      )}
      {tagEditProps && tags.length === 0 && (
        <PlusIcon className="size-icon-xs text-low" weight="bold" />
      )}
    </>
  );
  const tagEditorTrigger = (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-half cursor-pointer hover:bg-secondary rounded-sm transition-colors"
    >
      {tagsDisplay}
    </button>
  );

  return (
    <div className={cn("flex flex-col gap-half min-w-0", className)}>
      {/* Row 1: Task ID + sub-issue indicator + loading dots + more actions */}
      <div className="flex items-center justify-between gap-half">
        <div className="flex items-center gap-half min-w-0">
          {isSubIssue && (
            <span className="text-sm text-low">
              {t("kanban.subIssueIndicator")}
            </span>
          )}
          {shortLink ? (
            <button
              type="button"
              className="font-ibm-plex-mono text-sm text-low truncate hover:text-normal hover:underline"
              title={`클릭하면 짧은 링크 복사: ${shortLink}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard?.writeText(shortLink);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
            >
              {displayId}
            </button>
          ) : (
            <span className="font-ibm-plex-mono text-sm text-low truncate">
              {displayId}
            </span>
          )}
          {copied && <span className="text-xs text-success">링크 복사됨</span>}
          {priority && (
            <span
              className={cn(chipCls, PRIORITY_LABELS[priority].cls)}
              title={`우선순위: ${PRIORITY_LABELS[priority].label}`}
            >
              {PRIORITY_LABELS[priority].label}
            </span>
          )}
          {isBlocked && (
            <span
              className={cn(chipCls, "bg-red-500/15 text-red-600 dark:text-red-300")}
              title="아직 끝나지 않은 선행 작업이 있어요"
            >
              ⛔ 대기
            </span>
          )}
          {isLoading && <RunningDots />}
        </div>
        {onMoreActionsClick && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoreActionsClick();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              "p-half -m-half rounded-sm text-low hover:text-normal hover:bg-secondary shrink-0",
              isMobile
                ? ""
                : "invisible opacity-0 group-hover:visible group-hover:opacity-100",
              "transition-[opacity,color,background-color]",
            )}
            aria-label="More actions"
            title="More actions"
          >
            <DotsThreeIcon className="size-icon-xs" weight="bold" />
          </button>
        )}
      </div>

      {/* Row 2: Title */}
      <span
        className="text-base text-normal line-clamp-3 break-words"
        title={title}
      >
        {title}
      </span>

      {/* Parent / child relation */}
      {(parentIssue || (childSummary && childSummary.total > 0)) && (
        <div className="flex items-center gap-half flex-wrap text-xs text-low">
          {parentIssue && (
            <button
              type="button"
              className="hover:text-normal hover:underline"
              title={`상위 이슈 ${parentIssue.displayId} 열기`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => openRelated(e, parentIssue.id)}
            >
              ↳ 상위: {parentIssue.displayId}
            </button>
          )}
          {childSummary && childSummary.total > 0 && (
            <span title="하위 이슈 수 (완료된 수)">
              ▾ 하위 {childSummary.total}개 (완료 {childSummary.done})
            </span>
          )}
        </div>
      )}

      {/* Predecessor / successor chips */}
      {blockingRels.length > 0 && (
        <div className="flex items-center gap-half flex-wrap min-w-0">
          {blockingRels.map((rel) => {
            const isPred = rel.displayType === "blocked_by";
            return (
              <button
                type="button"
                key={rel.relationshipId}
                className={cn(
                  chipCls,
                  isPred
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-panel text-low",
                  "hover:underline",
                )}
                title={
                  isPred
                    ? `선행 작업: ${rel.relatedIssueDisplayId}이(가) 먼저 끝나야 해요`
                    : `후행 작업: 이 작업이 끝나야 ${rel.relatedIssueDisplayId}을(를) 시작할 수 있어요`
                }
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => openRelated(e, rel.relatedIssueId)}
              >
                {isPred
                  ? `${rel.relatedIssueDisplayId} 선행`
                  : `후행 ${rel.relatedIssueDisplayId}`}
              </button>
            );
          })}
        </div>
      )}

      {/* Row 3: Description (optional, truncated) */}
      {previewDescription && (
        <p
          className={cn(
            "text-sm text-low m-0",
            isMobile
              ? "leading-tight line-clamp-2"
              : "leading-relaxed line-clamp-4",
          )}
        >
          {previewDescription}
        </p>
      )}

      {aiChip && <div className="flex min-w-0">{aiChip}</div>}

      {/* Row 4: Priority + Assignee */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-half min-w-0">
          {onPriorityClick ? (
            <button
              type="button"
              onClick={onPriorityClick}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex items-center cursor-pointer hover:bg-secondary rounded-sm transition-colors"
            >
              <PriorityIcon priority={priority} />
              {!priority && (
                <CircleDashedIcon
                  className="size-icon-xs text-low"
                  weight="bold"
                />
              )}
            </button>
          ) : (
            <PriorityIcon priority={priority} />
          )}
        </div>
        {onAssigneeClick ? (
          <button
            type="button"
            onClick={onAssigneeClick}
            onMouseDown={(e) => e.stopPropagation()}
            className="cursor-pointer hover:bg-secondary rounded-sm transition-colors"
          >
            <span
              className="inline-flex origin-right scale-75 opacity-60"
              title="담당자(사람)"
            >
              <KanbanAssignee assignees={assignees} />
            </span>
          </button>
        ) : (
          <span
            className="inline-flex origin-right scale-75 opacity-60"
            title="담당자(사람)"
          >
            <KanbanAssignee assignees={assignees} />
          </span>
        )}
      </div>

      {/* Row 5: Tags, PRs, Relationships (own row to prevent overflow) */}
      {(tags.length > 0 ||
        tagEditProps ||
        pullRequests.length > 0 ||
        otherRels.length > 0) && (
        <div className="flex items-center gap-half flex-wrap min-w-0">
          {tagEditProps ? (
            (tagEditProps.renderTagEditor?.({
              allTags: tagEditProps.allTags,
              selectedTagIds: tagEditProps.selectedTagIds,
              onTagToggle: tagEditProps.onTagToggle,
              onCreateTag: tagEditProps.onCreateTag,
              trigger: tagEditorTrigger,
            }) ?? tagEditorTrigger)
          ) : (
            <>
              {tags.slice(0, 2).map((tag) => (
                <KanbanBadge key={tag.id} name={tag.name} color={tag.color} />
              ))}
              {tags.length > 2 && (
                <span className="text-sm text-low">+{tags.length - 2}</span>
              )}
            </>
          )}
          {pullRequests.slice(0, 2).map((pr) => (
            <PrBadge
              key={pr.id}
              number={pr.number}
              url={pr.url}
              status={pr.status}
            />
          ))}
          {pullRequests.length > 2 && (
            <span className="text-sm text-low">+{pullRequests.length - 2}</span>
          )}
          {otherRels.slice(0, 2).map((rel) => (
            <RelationshipBadge
              key={rel.relationshipId}
              displayType={rel.displayType}
              relatedIssueDisplayId={rel.relatedIssueDisplayId}
              compact
              onClick={
                rel.relatedIssueId && onRelatedIssueClick
                  ? (e) => openRelated(e, rel.relatedIssueId)
                  : undefined
              }
            />
          ))}
          {otherRels.length > 2 && (
            <span className="text-sm text-low">
              +{otherRels.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

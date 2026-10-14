'use client';

import { cn } from '../lib/cn';
import {
  ArrowBendUpRightIcon,
  ProhibitIcon,
  ArrowsLeftRightIcon,
  CopyIcon,
} from '@phosphor-icons/react';

export type RelationshipDisplayType =
  | 'blocks'
  | 'blocked_by'
  | 'related'
  | 'duplicate_of'
  | 'duplicated_by';

export interface RelationshipBadgeProps {
  displayType: RelationshipDisplayType;
  relatedIssueDisplayId: string;
  compact?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

const RELATIONSHIP_ICONS = {
  blocks: ArrowBendUpRightIcon,
  blocked_by: ProhibitIcon,
  related: ArrowsLeftRightIcon,
  duplicate_of: CopyIcon,
  duplicated_by: CopyIcon,
} as const;

export function getRelationshipSentence(
  displayType: RelationshipDisplayType,
  id: string
): string {
  switch (displayType) {
    case 'blocks':
      return `이 작업은 ${id}보다 먼저 처리되어야 합니다`;
    case 'blocked_by':
      return `이 작업 전에 ${id}이 먼저 처리되어야 합니다`;
    case 'related':
      return `${id}와(과) 관련된 작업입니다`;
    case 'duplicate_of':
      return `이 작업은 ${id}의 중복입니다`;
    case 'duplicated_by':
      return `${id}이(가) 이 작업의 중복입니다`;
  }
}

export function RelationshipBadge({
  displayType,
  relatedIssueDisplayId,
  compact,
  className,
  onClick,
}: RelationshipBadgeProps) {
  const Icon = RELATIONSHIP_ICONS[displayType];
  const sentence = getRelationshipSentence(
    displayType,
    relatedIssueDisplayId
  );
  const isBlocking = displayType === 'blocks' || displayType === 'blocked_by';

  return (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={sentence}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick(e as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-half',
        'h-5 px-half',
        'rounded-sm',
        'text-sm font-medium',
        'whitespace-nowrap',
        isBlocking ? 'bg-error/10 text-error' : 'bg-panel text-low',
        onClick && 'cursor-pointer hover:opacity-80',
        className
      )}
    >
      <Icon className="size-icon-xs" weight="bold" />
      <span>
        {compact ? relatedIssueDisplayId : sentence}
      </span>
    </span>
  );
}

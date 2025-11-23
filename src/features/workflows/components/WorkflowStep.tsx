'use client';

import { WorkflowRequest, WorkflowExecutionStep, HttpMethod } from '@/types';
import { cn } from '@/lib/shared/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  SkipForward,
  GripVertical,
  Trash2,
  Settings,
  Variable,
} from 'lucide-react';

interface WorkflowStepProps {
  workflowRequest: WorkflowRequest;
  method?: HttpMethod;
  executionStep?: WorkflowExecutionStep;
  index: number;
  onEdit?: () => void;
  onDelete?: () => void;
  onConfigureExtraction?: () => void;
  isDragging?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
}

const statusConfig = {
  pending: {
    icon: Clock,
    color: 'text-muted-foreground',
    bg: 'bg-muted',
  },
  running: {
    icon: Loader2,
    color: 'text-blue-500',
    bg: 'bg-blue-50 dark:bg-blue-950',
  },
  success: {
    icon: CheckCircle2,
    color: 'text-green-500',
    bg: 'bg-green-50 dark:bg-green-950',
  },
  failed: {
    icon: XCircle,
    color: 'text-red-500',
    bg: 'bg-red-50 dark:bg-red-950',
  },
  skipped: {
    icon: SkipForward,
    color: 'text-yellow-500',
    bg: 'bg-yellow-50 dark:bg-yellow-950',
  },
};

const methodColors: Record<HttpMethod, string> = {
  GET: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  POST: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  PUT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  PATCH: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  DELETE: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  OPTIONS: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  HEAD: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
};

export function WorkflowStep({
  workflowRequest,
  method,
  executionStep,
  index,
  onEdit,
  onDelete,
  onConfigureExtraction,
  isDragging,
  dragHandleProps,
}: WorkflowStepProps) {
  const status = executionStep?.status || 'pending';
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  const extractionCount = workflowRequest.extractVariables?.length || 0;
  const hasRetry = workflowRequest.retryPolicy && workflowRequest.retryPolicy.maxAttempts > 1;
  const hasPrecondition = !!workflowRequest.precondition;

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-lg border transition-colors',
        config.bg,
        isDragging && 'opacity-50 ring-2 ring-primary'
      )}
    >
      {/* Drag Handle */}
      {dragHandleProps && (
        <div
          {...dragHandleProps}
          className="cursor-grab text-muted-foreground hover:text-foreground"
        >
          <GripVertical className="h-4 w-4" />
        </div>
      )}

      {/* Step Number */}
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
        {index + 1}
      </div>

      {/* Status Icon */}
      <StatusIcon
        className={cn(
          'h-5 w-5 flex-shrink-0',
          config.color,
          status === 'running' && 'animate-spin'
        )}
      />

      {/* Request Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {method && (
            <Badge variant="secondary" className={cn('text-xs', methodColors[method])}>
              {method}
            </Badge>
          )}
          <span className="font-medium truncate">{workflowRequest.name}</span>
        </div>

        {/* Badges for features */}
        <div className="flex items-center gap-1.5 mt-1">
          {extractionCount > 0 && (
            <Badge variant="outline" className="text-xs py-0">
              <Variable className="h-3 w-3 mr-1" />
              {extractionCount} var{extractionCount !== 1 ? 's' : ''}
            </Badge>
          )}
          {hasRetry && (
            <Badge variant="outline" className="text-xs py-0">
              Retry: {workflowRequest.retryPolicy?.maxAttempts}x
            </Badge>
          )}
          {hasPrecondition && (
            <Badge variant="outline" className="text-xs py-0">
              Conditional
            </Badge>
          )}
        </div>

        {/* Execution details */}
        {executionStep && (
          <div className="text-xs text-muted-foreground mt-1">
            {executionStep.duration && <span>{executionStep.duration}ms</span>}
            {executionStep.response && (
              <span className="ml-2">
                Status: {executionStep.response.status}
              </span>
            )}
            {executionStep.error && (
              <span className="text-red-500 ml-2">{executionStep.error}</span>
            )}
          </div>
        )}

        {/* Extracted variables */}
        {executionStep?.extractedVariables &&
          Object.keys(executionStep.extractedVariables).length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              Extracted:{' '}
              {Object.keys(executionStep.extractedVariables).join(', ')}
            </div>
          )}
      </div>

      {/* Actions */}
      {(onEdit || onDelete || onConfigureExtraction) && !executionStep && (
        <div className="flex items-center gap-1">
          {onConfigureExtraction && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onConfigureExtraction}
              title="Configure extractions"
            >
              <Variable className="h-4 w-4" />
            </Button>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onEdit}
              title="Edit step"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              title="Delete step"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

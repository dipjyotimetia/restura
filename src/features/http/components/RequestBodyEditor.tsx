'use client';

import { FileText } from 'lucide-react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { useVariableStatus } from '@/hooks/useVariableStatus';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useActiveTab } from '@/store/selectors';
import type { FormDataItem, RequestBody } from '@/types';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-full" />
);
const GraphQLBodyEditor = lazyComponent(
  () => import('@/features/graphql/components/GraphQLBodyEditor')
);
const FormDataEditor = lazyComponent(() => import('@/features/http/components/FormDataEditor'));
const BinaryBodyPicker = lazyComponent(() => import('@/features/http/components/BinaryBodyPicker'));

/**
 * Whether the editor for this body type fills its container (the Monaco code
 * editor) vs. renders at content height (empty state, GraphQL panel, form-data
 * list, binary picker). Single source of truth for the parent's flex-fill
 * decision — keep in sync with the render branch below.
 */
export function bodyEditorFills(type: RequestBody['type']): boolean {
  return type !== 'none' && type !== 'graphql' && type !== 'form-data' && type !== 'binary';
}

interface RequestBodyEditorProps {
  body: RequestBody;
  onBodyTypeChange: (type: RequestBody['type']) => void;
  onBodyContentChange: (content: string) => void;
  onFormDataChange?: (items: FormDataItem[]) => void;
  url?: string;
  graphqlVariables?: string;
  onGraphQLVariablesChange?: (variables: string) => void;
}

export default function RequestBodyEditor({
  body,
  onBodyContentChange,
  onFormDataChange,
  url = '',
  graphqlVariables = '{}',
  onGraphQLVariablesChange,
}: RequestBodyEditorProps) {
  const activeTabId = useActiveTab()?.id;
  const getVariableStatus = useVariableStatus();

  if (body.type === 'none') {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <div className="mb-3 inline-flex items-center justify-center h-10 w-10 rounded-full bg-sp-surface-lo text-sp-dim">
          <FileText size={18} />
        </div>
        <p className="text-sp-13 text-sp-muted font-medium">No body for this request</p>
        <p className="text-sp-11 text-sp-dim mt-1">Pick a body type above to start composing.</p>
      </div>
    );
  }

  if (body.type === 'graphql') {
    return (
      <GraphQLBodyEditor
        query={body.raw || ''}
        variables={graphqlVariables}
        url={url}
        onQueryChange={onBodyContentChange}
        onVariablesChange={onGraphQLVariablesChange || (() => {})}
      />
    );
  }

  if (body.type === 'form-data') {
    return <FormDataEditor items={body.formData ?? []} onChange={onFormDataChange ?? (() => {})} />;
  }

  if (body.type === 'binary') {
    return <BinaryBodyPicker base64={body.raw || ''} onChange={onBodyContentChange} />;
  }

  return (
    <CodeEditor
      value={body.raw || ''}
      onChange={onBodyContentChange}
      language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : 'plaintext'}
      height="100%"
      getVariableStatus={getVariableStatus}
      {...(activeTabId ? { path: `tab-${activeTabId}-body` } : {})}
    />
  );
}

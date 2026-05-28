'use client';

import { useState } from 'react';
import { ChevronDown, Code2, FileText, RotateCcw } from 'lucide-react';
import { Segmented } from '@/components/ui/spatial';
import { Button } from '@/components/ui/button';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { cn } from '@/lib/shared/utils';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[350px]" />
);

interface ScriptsEditorProps {
  preRequestScript: string;
  testScript: string;
  onPreRequestScriptChange: (script: string) => void;
  onTestScriptChange: (script: string) => void;
}

type ScriptTab = 'pre-request' | 'test';

const PRE_REQUEST_TEMPLATE = `// Pre-request Script
// This script runs before the request is sent

// Set environment variables
// rs.variables.set("timestamp", Date.now());

// Log to console
// console.log("Request:", rs.request.url);

// Example: Generate auth token
// const token = generateToken();
// rs.variables.set("authToken", token);
`;

const TEST_SCRIPT_TEMPLATE = `// Test Script
// This script runs after the response is received

// Basic status check
rs.test("Status code is 200", function() {
  rs.expect(rs.response.status).to.equal(200);
});

// Check response time
rs.test("Response time is acceptable", function() {
  rs.expect(rs.response.time).to.be.below(1000);
});

// Validate response structure
rs.test("Response has required fields", function() {
  const json = rs.response.json();
  rs.expect(json).to.have.property("data");
});

// Store response data in variables
// rs.variables.set("userId", rs.response.json().data.id);
`;

const PRE_REQUEST_API: ReadonlyArray<{ code: string; desc: string }> = [
  { code: 'rs.variables.get("key")', desc: 'Read a variable' },
  { code: 'rs.variables.set("key", value)', desc: 'Write a variable' },
  { code: 'rs.request.url', desc: 'Current request URL' },
  { code: 'rs.request.headers', desc: 'Request headers map' },
];

const TEST_API: ReadonlyArray<{ code: string; desc: string }> = [
  { code: 'rs.test("name", () => {...})', desc: 'Define a test case' },
  { code: 'rs.expect(value).to.equal(x)', desc: 'Assertion' },
  { code: 'rs.response.status', desc: 'HTTP status code' },
  { code: 'rs.response.json()', desc: 'Parse JSON body' },
  { code: 'rs.response.time', desc: 'Response time (ms)' },
];

export default function ScriptsEditor({
  preRequestScript,
  testScript,
  onPreRequestScriptChange,
  onTestScriptChange,
}: ScriptsEditorProps) {
  const [activeTab, setActiveTab] = useState<ScriptTab>('pre-request');
  const [refOpen, setRefOpen] = useState(false);

  const isPre = activeTab === 'pre-request';
  const script = isPre ? preRequestScript : testScript;
  const setScript = isPre ? onPreRequestScriptChange : onTestScriptChange;
  const apiRef = isPre ? PRE_REQUEST_API : TEST_API;

  const handleInsertTemplate = () => {
    setScript(isPre ? PRE_REQUEST_TEMPLATE : TEST_SCRIPT_TEMPLATE);
  };

  const handleClearScript = () => {
    setScript('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Segmented<ScriptTab>
          options={[
            {
              value: 'pre-request',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Pre-request
                  {preRequestScript && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-amber-400"
                      aria-label="has script"
                    />
                  )}
                </span>
              ),
            },
            {
              value: 'test',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Test
                  {testScript && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-amber-400"
                      aria-label="has script"
                    />
                  )}
                </span>
              ),
            },
          ]}
          value={activeTab}
          onChange={setActiveTab}
          size="md"
          ariaLabel="Script type"
        />

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={handleInsertTemplate}
            className="h-7 text-xs"
          >
            <FileText className="mr-1.5 h-3 w-3" />
            Insert template
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearScript}
            disabled={!script}
            className="h-7 text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
          >
            <RotateCcw className="mr-1.5 h-3 w-3" />
            Clear
          </Button>
        </div>
      </div>

      <div className="rounded-sp-panel border border-sp-line bg-sp-surface-lo overflow-hidden">
        <button
          type="button"
          onClick={() => setRefOpen((v) => !v)}
          aria-expanded={refOpen}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
        >
          <span className="inline-flex items-center gap-2">
            <Code2 size={13} />
            <span className="font-medium">{isPre ? 'Pre-request' : 'Test'} API reference</span>
            <span className="text-sp-dim text-sp-11">· {apiRef.length} snippets</span>
          </span>
          <ChevronDown size={14} className={cn('transition-transform', refOpen && 'rotate-180')} />
        </button>
        {refOpen && (
          <ul className="border-t border-sp-line divide-y divide-sp-line">
            {apiRef.map((row) => (
              <li
                key={row.code}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-sp-11"
              >
                <code className="font-mono text-sp-text/90 bg-sp-code px-1.5 py-0.5 rounded-sp-chip">
                  {row.code}
                </code>
                <span className="text-sp-dim text-right">{row.desc}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-sp-panel border border-sp-line bg-sp-code overflow-hidden">
        <CodeEditor value={script} onChange={setScript} language="javascript" height="350px" />
      </div>
    </div>
  );
}

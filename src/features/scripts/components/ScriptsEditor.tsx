'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Play, RotateCcw } from 'lucide-react';
import dynamic from 'next/dynamic';

const CodeEditor = dynamic(() => import('@/components/shared/CodeEditor'), { ssr: false });

interface ScriptsEditorProps {
  preRequestScript: string;
  testScript: string;
  onPreRequestScriptChange: (script: string) => void;
  onTestScriptChange: (script: string) => void;
}

const PRE_REQUEST_TEMPLATE = `// Pre-request Script
// This script runs before the request is sent

// Set environment variables
// pm.variables.set("timestamp", Date.now());

// Log to console
// console.log("Request:", pm.request.url);

// Example: Generate auth token
// const token = generateToken();
// pm.variables.set("authToken", token);
`;

const TEST_SCRIPT_TEMPLATE = `// Test Script
// This script runs after the response is received

// Basic status check
pm.test("Status code is 200", function() {
  pm.expect(pm.response.status).to.equal(200);
});

// Check response time
pm.test("Response time is acceptable", function() {
  pm.expect(pm.response.time).to.be.below(1000);
});

// Validate response structure
pm.test("Response has required fields", function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property("data");
});

// Store response data in variables
// pm.variables.set("userId", pm.response.json().data.id);
`;

export default function ScriptsEditor({
  preRequestScript,
  testScript,
  onPreRequestScriptChange,
  onTestScriptChange,
}: ScriptsEditorProps) {
  const [activeTab, setActiveTab] = useState<'pre-request' | 'test'>('pre-request');

  const handleInsertTemplate = () => {
    if (activeTab === 'pre-request') {
      onPreRequestScriptChange(PRE_REQUEST_TEMPLATE);
    } else {
      onTestScriptChange(TEST_SCRIPT_TEMPLATE);
    }
  };

  const handleClearScript = () => {
    if (activeTab === 'pre-request') {
      onPreRequestScriptChange('');
    } else {
      onTestScriptChange('');
    }
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'pre-request' | 'test')}>
        <div className="flex items-center justify-between">
          <TabsList className="bg-white/5 dark:bg-white/5 border border-white/10 dark:border-white/5">
            <TabsTrigger
              value="pre-request"
              className="data-[state=active]:bg-white/10 dark:data-[state=active]:bg-white/10 data-[state=active]:text-slate-blue-700 dark:data-[state=active]:text-slate-blue-300"
            >
              Pre-request Script
              {preRequestScript && (
                <span className="ml-1.5 h-2 w-2 rounded-full bg-amber-500" />
              )}
            </TabsTrigger>
            <TabsTrigger
              value="test"
              className="data-[state=active]:bg-white/10 dark:data-[state=active]:bg-white/10 data-[state=active]:text-slate-blue-700 dark:data-[state=active]:text-slate-blue-300"
            >
              Test Script
              {testScript && (
                <span className="ml-1.5 h-2 w-2 rounded-full bg-amber-500" />
              )}
            </TabsTrigger>
          </TabsList>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleInsertTemplate}
              className="border-white/10 dark:border-white/5 hover:border-white/20 dark:hover:border-white/10 text-xs"
            >
              <Play className="mr-1.5 h-3 w-3" />
              Insert Template
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearScript}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              <RotateCcw className="mr-1.5 h-3 w-3" />
              Clear
            </Button>
          </div>
        </div>

        <TabsContent value="pre-request" className="space-y-2 mt-4">
          <div className="rounded-lg bg-white/5 dark:bg-white/5 p-3 text-sm text-muted-foreground border border-white/10 dark:border-white/5">
            <p className="font-medium mb-1">Pre-request Script</p>
            <p className="text-xs">
              Execute JavaScript code before sending the request. Access and modify variables using:
            </p>
            <ul className="text-xs mt-2 space-y-1 ml-4 list-disc">
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.variables.get(&quot;key&quot;)</code> - Get variable
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.variables.set(&quot;key&quot;, value)</code> - Set variable
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.request.url</code> - Access request URL
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.request.headers</code> - Access headers
              </li>
            </ul>
          </div>
          <CodeEditor
            value={preRequestScript}
            onChange={onPreRequestScriptChange}
            language="javascript"
            height="350px"
          />
        </TabsContent>

        <TabsContent value="test" className="space-y-2 mt-4">
          <div className="rounded-lg bg-white/5 dark:bg-white/5 p-3 text-sm text-muted-foreground border border-white/10 dark:border-white/5">
            <p className="font-medium mb-1">Test Script</p>
            <p className="text-xs">
              Execute JavaScript code after receiving the response. Write assertions using:
            </p>
            <ul className="text-xs mt-2 space-y-1 ml-4 list-disc">
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.test(&quot;name&quot;, () =&gt; {'{...}'})</code> - Define test
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.expect(value).to.equal(expected)</code> - Assertions
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.response.status</code> - HTTP status code
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.response.json()</code> - Parse JSON body
              </li>
              <li>
                <code className="bg-black/5 dark:bg-white/10 px-1 rounded">pm.response.time</code> - Response time (ms)
              </li>
            </ul>
          </div>
          <CodeEditor
            value={testScript}
            onChange={onTestScriptChange}
            language="javascript"
            height="350px"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

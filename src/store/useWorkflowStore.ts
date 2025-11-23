import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Workflow, WorkflowRequest, WorkflowExecution, VariableExtraction } from '@/types';
import { v4 as uuidv4 } from 'uuid';

interface WorkflowState {
  workflows: Workflow[];
  executions: WorkflowExecution[];

  // Workflow CRUD
  addWorkflow: (workflow: Workflow) => void;
  updateWorkflow: (id: string, updates: Partial<Workflow>) => void;
  deleteWorkflow: (id: string) => void;
  getWorkflowById: (id: string) => Workflow | undefined;
  getWorkflowsByCollectionId: (collectionId: string) => Workflow[];
  createNewWorkflow: (name: string, collectionId: string) => Workflow;

  // Workflow Request CRUD
  addWorkflowRequest: (workflowId: string, request: WorkflowRequest) => void;
  updateWorkflowRequest: (workflowId: string, requestId: string, updates: Partial<WorkflowRequest>) => void;
  deleteWorkflowRequest: (workflowId: string, requestId: string) => void;
  reorderWorkflowRequests: (workflowId: string, requests: WorkflowRequest[]) => void;

  // Variable Extraction
  addExtraction: (workflowId: string, requestId: string, extraction: VariableExtraction) => void;
  updateExtraction: (workflowId: string, requestId: string, extractionId: string, updates: Partial<VariableExtraction>) => void;
  deleteExtraction: (workflowId: string, requestId: string, extractionId: string) => void;

  // Execution History
  saveExecution: (execution: WorkflowExecution) => void;
  getExecutionsByWorkflowId: (workflowId: string) => WorkflowExecution[];
  getLatestExecution: (workflowId: string) => WorkflowExecution | undefined;
  clearExecutionHistory: (workflowId?: string) => void;

  // Helpers
  createNewWorkflowRequest: (requestId: string, name: string) => WorkflowRequest;
  createNewExtraction: (variableName: string, path: string) => VariableExtraction;
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      workflows: [],
      executions: [],

      // Workflow CRUD
      addWorkflow: (workflow) =>
        set((state) => ({
          workflows: [...state.workflows, workflow],
        })),

      updateWorkflow: (id, updates) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === id ? { ...wf, ...updates, updatedAt: Date.now() } : wf
          ),
        })),

      deleteWorkflow: (id) =>
        set((state) => ({
          workflows: state.workflows.filter((wf) => wf.id !== id),
          executions: state.executions.filter((ex) => ex.workflowId !== id),
        })),

      getWorkflowById: (id) => get().workflows.find((wf) => wf.id === id),

      getWorkflowsByCollectionId: (collectionId) =>
        get().workflows.filter((wf) => wf.collectionId === collectionId),

      createNewWorkflow: (name, collectionId) => ({
        id: uuidv4(),
        name,
        collectionId,
        requests: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),

      // Workflow Request CRUD
      addWorkflowRequest: (workflowId, request) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? { ...wf, requests: [...wf.requests, request], updatedAt: Date.now() }
              : wf
          ),
        })),

      updateWorkflowRequest: (workflowId, requestId, updates) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? {
                  ...wf,
                  requests: wf.requests.map((req) =>
                    req.id === requestId ? { ...req, ...updates } : req
                  ),
                  updatedAt: Date.now(),
                }
              : wf
          ),
        })),

      deleteWorkflowRequest: (workflowId, requestId) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? {
                  ...wf,
                  requests: wf.requests.filter((req) => req.id !== requestId),
                  updatedAt: Date.now(),
                }
              : wf
          ),
        })),

      reorderWorkflowRequests: (workflowId, requests) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? { ...wf, requests, updatedAt: Date.now() }
              : wf
          ),
        })),

      // Variable Extraction
      addExtraction: (workflowId, requestId, extraction) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? {
                  ...wf,
                  requests: wf.requests.map((req) =>
                    req.id === requestId
                      ? {
                          ...req,
                          extractVariables: [...(req.extractVariables || []), extraction],
                        }
                      : req
                  ),
                  updatedAt: Date.now(),
                }
              : wf
          ),
        })),

      updateExtraction: (workflowId, requestId, extractionId, updates) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? {
                  ...wf,
                  requests: wf.requests.map((req) =>
                    req.id === requestId
                      ? {
                          ...req,
                          extractVariables: req.extractVariables?.map((ext) =>
                            ext.id === extractionId ? { ...ext, ...updates } : ext
                          ),
                        }
                      : req
                  ),
                  updatedAt: Date.now(),
                }
              : wf
          ),
        })),

      deleteExtraction: (workflowId, requestId, extractionId) =>
        set((state) => ({
          workflows: state.workflows.map((wf) =>
            wf.id === workflowId
              ? {
                  ...wf,
                  requests: wf.requests.map((req) =>
                    req.id === requestId
                      ? {
                          ...req,
                          extractVariables: req.extractVariables?.filter(
                            (ext) => ext.id !== extractionId
                          ),
                        }
                      : req
                  ),
                  updatedAt: Date.now(),
                }
              : wf
          ),
        })),

      // Execution History
      saveExecution: (execution) =>
        set((state) => ({
          executions: [...state.executions, execution].slice(-100), // Keep last 100 executions
        })),

      getExecutionsByWorkflowId: (workflowId) =>
        get()
          .executions.filter((ex) => ex.workflowId === workflowId)
          .sort((a, b) => b.startedAt - a.startedAt),

      getLatestExecution: (workflowId) =>
        get()
          .executions.filter((ex) => ex.workflowId === workflowId)
          .sort((a, b) => b.startedAt - a.startedAt)[0],

      clearExecutionHistory: (workflowId) =>
        set((state) => ({
          executions: workflowId
            ? state.executions.filter((ex) => ex.workflowId !== workflowId)
            : [],
        })),

      // Helpers
      createNewWorkflowRequest: (requestId, name) => ({
        id: uuidv4(),
        requestId,
        name,
      }),

      createNewExtraction: (variableName, path) => ({
        id: uuidv4(),
        variableName,
        extractionMethod: 'jsonpath' as const,
        path,
      }),
    }),
    {
      name: 'workflow-storage',
    }
  )
);

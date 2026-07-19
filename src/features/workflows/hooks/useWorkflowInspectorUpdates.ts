import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { FlowNode, SubgraphPath, WorkflowRequest } from '@/types';
import { selectAtPath } from '../lib/flowTypes';

export function useUpdateInspectorNode(workflowId: string, path: SubgraphPath) {
  const setWorkflowSubgraph = useWorkflowStore((state) => state.setWorkflowSubgraph);
  const workflows = useWorkflowStore((state) => state.workflows);

  return (nodeId: string, mutator: (node: FlowNode) => FlowNode) => {
    const workflow = workflows.find((candidate) => candidate.id === workflowId);
    if (!workflow?.graph) return;
    const subgraph = path.length === 0 ? workflow.graph : selectAtPath(workflow.graph, path);
    if (!subgraph) return;
    setWorkflowSubgraph(workflowId, path, {
      ...subgraph,
      nodes: subgraph.nodes.map((node) => (node.id === nodeId ? mutator(node) : node)),
    });
  };
}

export function useUpdateInspectorRequest(workflowId: string) {
  const updateWorkflowRequest = useWorkflowStore((state) => state.updateWorkflowRequest);

  return (workflowRequestId: string, updates: Partial<WorkflowRequest>) => {
    updateWorkflowRequest(workflowId, workflowRequestId, updates);
  };
}

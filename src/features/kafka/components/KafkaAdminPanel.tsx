import { Plus, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater } from '@/components/ui/spatial';
import { TabsContent } from '@/components/ui/tabs';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import type { KafkaConnection } from '@/features/kafka/store/useKafkaStore';
import type { KafkaGroupInfo } from '../../../../electron/types/electron-api';
import { KafkaGroupInspector } from './KafkaGroupInspector';
import { KafkaTopicInspector } from './KafkaTopicInspector';
import { KAFKA_PINK } from './shared';

/** Topic and consumer-group administration with connection-scoped transient state. */
export function KafkaAdminPanel({ connection }: { connection: KafkaConnection }) {
  const [topics, setTopics] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<KafkaGroupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicPartitions, setNewTopicPartitions] = useState('1');
  const [newTopicReplication, setNewTopicReplication] = useState('1');
  const [inspectTopicName, setInspectTopicName] = useState<string | null>(null);
  const [inspectGroupId, setInspectGroupId] = useState<string | null>(null);
  const [pendingTopicDelete, setPendingTopicDelete] = useState<string | null>(null);

  useEffect(() => {
    setTopics(null);
    setGroups(null);
    setError(null);
    setNewTopicName('');
    setInspectTopicName(null);
    setInspectGroupId(null);
    setPendingTopicDelete(null);
  }, [connection.id]);

  const refreshTopics = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await kafkaManager.listTopics(connection.id);
    if (result.ok) setTopics(result.topics.slice().sort());
    else setError(result.error);
    setBusy(false);
  };
  const refreshGroups = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await kafkaManager.listGroups(connection.id);
    if (result.ok) setGroups(result.groups);
    else setError(result.error);
    setBusy(false);
  };
  const createTopic = async (): Promise<void> => {
    if (!newTopicName.trim()) return;
    setBusy(true);
    setError(null);
    const result = await kafkaManager.createTopic({
      connectionId: connection.id,
      topic: newTopicName.trim(),
      partitions: Math.max(1, Number(newTopicPartitions) || 1),
      replicationFactor: Math.max(1, Number(newTopicReplication) || 1),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNewTopicName('');
    await refreshTopics();
  };
  const deleteTopic = async (topic: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await kafkaManager.deleteTopic(connection.id, topic);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (inspectTopicName === topic) setInspectTopicName(null);
    await refreshTopics();
  };

  return (
    <TabsContent value="admin" className="flex-1 overflow-auto m-0">
      <ConfirmDialog
        open={pendingTopicDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTopicDelete(null);
        }}
        title="Delete Kafka topic?"
        description={
          pendingTopicDelete
            ? `This permanently deletes topic "${pendingTopicDelete}" and its retained messages.`
            : ''
        }
        confirmText="Delete topic"
        variant="destructive"
        onConfirm={() => {
          if (!pendingTopicDelete) return;
          const topic = pendingTopicDelete;
          setPendingTopicDelete(null);
          void deleteTopic(topic);
        }}
      />
      <Floater radius="panel" className="p-3 space-y-4">
        {connection.status !== 'connected' && (
          <p className="text-xs text-sp-muted">Connect to manage topics and groups.</p>
        )}
        {error && <div className="font-mono text-sp-12 text-red-400 break-all">{error}</div>}
        <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <Label className="text-xs sp-label">Create topic</Label>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <Input
              value={newTopicName}
              onChange={(event) => setNewTopicName(event.target.value)}
              placeholder="topic-name"
              className="h-8 text-xs font-mono"
            />
            <Input
              value={newTopicPartitions}
              onChange={(event) => setNewTopicPartitions(event.target.value)}
              inputMode="numeric"
              title="Partitions"
              className="h-8 w-20 text-xs font-mono"
            />
            <Input
              value={newTopicReplication}
              onChange={(event) => setNewTopicReplication(event.target.value)}
              inputMode="numeric"
              title="Replication factor"
              className="h-8 w-20 text-xs font-mono"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sp-11 text-sp-dim">name · partitions · replication</span>
            <Button
              size="sm"
              onClick={createTopic}
              disabled={connection.status !== 'connected' || busy || !newTopicName.trim()}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Create
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs sp-label">Topics</Label>
            <Button
              size="sm"
              variant="secondary"
              onClick={refreshTopics}
              disabled={connection.status !== 'connected' || busy}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> List topics
            </Button>
          </div>
          {topics === null ? (
            <p className="text-xs text-sp-dim">Click "List topics" to load.</p>
          ) : topics.length === 0 ? (
            <p className="text-xs text-sp-dim">No topics.</p>
          ) : (
            <ul className="space-y-1">
              {topics.map((topic) => (
                <li
                  key={topic}
                  className="flex items-center justify-between rounded-sp-btn border border-sp-line px-2.5 py-1.5"
                >
                  <span
                    className="font-mono text-sp-12 truncate"
                    style={{ color: KAFKA_PINK }}
                    title={topic}
                  >
                    {topic}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setInspectTopicName((current) => (current === topic ? null : topic))
                    }
                    disabled={connection.status !== 'connected'}
                    className="h-6 w-6 p-0 ml-auto"
                    title={`Inspect topic ${topic}`}
                    aria-label={`Inspect topic ${topic}`}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingTopicDelete(topic)}
                    disabled={busy}
                    className="h-6 w-6 p-0"
                    title={`Delete topic ${topic}`}
                    aria-label={`Delete topic ${topic}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {inspectTopicName !== null && (
            <KafkaTopicInspector
              connectionId={connection.id}
              topic={inspectTopicName}
              onClose={() => setInspectTopicName(null)}
            />
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs sp-label">Consumer groups</Label>
            <Button
              size="sm"
              variant="secondary"
              onClick={refreshGroups}
              disabled={connection.status !== 'connected' || busy}
            >
              <Users className="h-3.5 w-3.5 mr-1.5" /> List groups
            </Button>
          </div>
          {groups === null ? (
            <p className="text-xs text-sp-dim">Click "List groups" to load.</p>
          ) : groups.length === 0 ? (
            <p className="text-xs text-sp-dim">No consumer groups.</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((group) => (
                <li
                  key={group.id}
                  className="flex items-center gap-2 rounded-sp-btn border border-sp-line px-2.5 py-1.5"
                >
                  <span className="font-mono text-sp-12 text-sp-text truncate" title={group.id}>
                    {group.id}
                  </span>
                  <Badge variant="outline" className="ml-auto font-mono text-sp-11">
                    {group.state}
                  </Badge>
                  {group.protocolType && (
                    <Badge variant="secondary" className="font-mono text-sp-11">
                      {group.protocolType}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setInspectGroupId((current) => (current === group.id ? null : group.id))
                    }
                    disabled={connection.status !== 'connected'}
                    className="h-6 w-6 p-0"
                    title={`Inspect group ${group.id}`}
                    aria-label={`Inspect group ${group.id}`}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {inspectGroupId !== null && (
            <KafkaGroupInspector
              connectionId={connection.id}
              groupId={inspectGroupId}
              onClose={() => setInspectGroupId(null)}
              onDeleted={() => {
                setInspectGroupId(null);
                void refreshGroups();
              }}
            />
          )}
        </div>
      </Floater>
    </TabsContent>
  );
}

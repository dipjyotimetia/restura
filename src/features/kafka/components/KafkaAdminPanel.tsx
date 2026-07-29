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
import { KafkaAdvancedAdmin } from './KafkaAdvancedAdmin';
import { KafkaGroupInspector } from './KafkaGroupInspector';
import { KafkaTopicInspector } from './KafkaTopicInspector';
import { KAFKA_PINK } from './shared';

/** Topic and consumer-group administration with connection-scoped transient state. */
export function KafkaAdminPanel({ connection }: { connection: KafkaConnection }) {
  const [topics, setTopics] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<KafkaGroupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingResource, setLoadingResource] = useState<'topics' | 'groups' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicPartitions, setNewTopicPartitions] = useState('1');
  const [newTopicReplication, setNewTopicReplication] = useState('1');
  const [topicFilter, setTopicFilter] = useState('');
  const [inspectTopicName, setInspectTopicName] = useState<string | null>(null);
  const [inspectGroupId, setInspectGroupId] = useState<string | null>(null);
  const [pendingTopicDelete, setPendingTopicDelete] = useState<string | null>(null);

  useEffect(() => {
    setTopics(null);
    setGroups(null);
    setError(null);
    setLoadingResource(null);
    setNewTopicName('');
    setTopicFilter('');
    setInspectTopicName(null);
    setInspectGroupId(null);
    setPendingTopicDelete(null);
  }, [connection.id]);

  const refreshTopics = async (): Promise<void> => {
    setBusy(true);
    setLoadingResource('topics');
    setError(null);
    const result = await kafkaManager.listTopics(connection.id);
    if (result.ok) setTopics(result.topics.slice().sort());
    else setError(result.error);
    setLoadingResource(null);
    setBusy(false);
  };
  const refreshGroups = async (): Promise<void> => {
    setBusy(true);
    setLoadingResource('groups');
    setError(null);
    const result = await kafkaManager.listGroups(connection.id);
    if (result.ok) setGroups(result.groups);
    else setError(result.error);
    setLoadingResource(null);
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
  const normalizedTopicFilter = topicFilter.trim().toLowerCase();
  const filteredTopics =
    topics?.filter((topic) => topic.toLowerCase().includes(normalizedTopicFilter)) ?? [];

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
          <h3 className="text-xs font-medium">Create topic</h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_8rem_10rem]">
            <div className="space-y-1">
              <Label htmlFor="kafka-admin-topic-name" className="text-xs sp-label">
                Topic name
              </Label>
              <Input
                id="kafka-admin-topic-name"
                value={newTopicName}
                onChange={(event) => setNewTopicName(event.target.value)}
                placeholder="topic-name"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-admin-topic-partitions" className="text-xs sp-label">
                Partitions
              </Label>
              <Input
                id="kafka-admin-topic-partitions"
                value={newTopicPartitions}
                onChange={(event) => setNewTopicPartitions(event.target.value)}
                inputMode="numeric"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-admin-topic-replication" className="text-xs sp-label">
                Replication factor
              </Label>
              <Input
                id="kafka-admin-topic-replication"
                value={newTopicReplication}
                onChange={(event) => setNewTopicReplication(event.target.value)}
                inputMode="numeric"
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex justify-end">
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
            <div className="flex items-center gap-2">
              <Label className="text-xs sp-label">Topics</Label>
              {topics !== null && (
                <Badge variant="outline">
                  {normalizedTopicFilter
                    ? `${filteredTopics.length} of ${topics.length} topics`
                    : `${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}`}
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={refreshTopics}
              disabled={connection.status !== 'connected' || busy}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> List topics
            </Button>
          </div>
          {loadingResource === 'topics' ? (
            <p role="status" className="text-xs text-sp-muted">
              Loading topics…
            </p>
          ) : topics === null ? (
            <p className="text-xs text-sp-dim">Click "List topics" to load.</p>
          ) : topics.length === 0 ? (
            <p className="text-xs text-sp-dim">This cluster has no topics.</p>
          ) : (
            <>
              <Input
                type="search"
                aria-label="Filter topics"
                value={topicFilter}
                onChange={(event) => setTopicFilter(event.target.value)}
                placeholder="Filter topics"
                className="h-8 text-xs font-mono"
              />
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2.5 text-sp-10 text-sp-dim">
                <span>Topic</span>
                <span>Actions</span>
              </div>
              {filteredTopics.length === 0 ? (
                <p className="rounded-sp-btn border border-dashed border-sp-line px-3 py-6 text-center text-xs text-sp-dim">
                  No topics match “{topicFilter.trim()}”.
                </p>
              ) : (
                <ul className="space-y-1">
                  {filteredTopics.map((topic) => (
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
                        variant="destructive"
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
            </>
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
            <div className="flex items-center gap-2">
              <Label className="text-xs sp-label">Consumer groups</Label>
              {groups !== null && (
                <Badge variant="outline">
                  {groups.length} {groups.length === 1 ? 'group' : 'groups'}
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={refreshGroups}
              disabled={connection.status !== 'connected' || busy}
            >
              <Users className="h-3.5 w-3.5 mr-1.5" /> List groups
            </Button>
          </div>
          {loadingResource === 'groups' ? (
            <p role="status" className="text-xs text-sp-muted">
              Loading consumer groups…
            </p>
          ) : groups === null ? (
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
        <div className="space-y-2">
          <Label className="text-xs sp-label">Advanced administration</Label>
          <KafkaAdvancedAdmin connectionId={connection.id} />
        </div>
      </Floater>
    </TabsContent>
  );
}

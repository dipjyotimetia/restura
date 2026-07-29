import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getElectronAPI } from '@/lib/shared/platform';
import type { KafkaAclIpc } from '../../../../electron/types/electron-api';

function Result({ value }: { value: unknown }) {
  if (value === null) return null;
  return (
    <pre className="max-h-56 overflow-auto rounded border border-sp-line bg-sp-surface p-2 text-sp-11">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function KafkaAdvancedAdmin({ connectionId }: { connectionId: string }) {
  const [topic, setTopic] = useState('');
  const [partitionCount, setPartitionCount] = useState('1');
  const [configName, setConfigName] = useState('retention.ms');
  const [configValue, setConfigValue] = useState('');
  const [partition, setPartition] = useState('0');
  const [offset, setOffset] = useState('0');
  const [recordConfirmation, setRecordConfirmation] = useState('');
  const [topicConfirmation, setTopicConfirmation] = useState('');
  const [aclConfirmation, setAclConfirmation] = useState('');
  const [quotaConfirmation, setQuotaConfirmation] = useState('');
  const [aclJson, setAclJson] = useState(
    '{"resourceType":2,"resourceName":"orders","resourcePatternType":3,"principal":"User:restura","host":"*","operation":3,"permissionType":3}'
  );
  const [quotaEntity, setQuotaEntity] = useState('restura');
  const [quotaValue, setQuotaValue] = useState('1048576');
  const [result, setResult] = useState<unknown>(null);

  const api = getElectronAPI()?.kafka;
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      setResult(await operation());
    } catch (error) {
      setResult({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const parseAcl = (): KafkaAclIpc => JSON.parse(aclJson) as KafkaAclIpc;

  return (
    <div className="space-y-3">
      <details className="rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
        <summary className="cursor-pointer text-xs font-medium">Cluster metadata</summary>
        <div className="pt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={!api}
            onClick={() => void run(() => api!.describeCluster({ connectionId }))}
          >
            Describe cluster
          </Button>
        </div>
      </details>
      <Result value={result} />

      <details className="rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
        <summary className="cursor-pointer text-xs font-medium">Advanced topic operations</summary>
        <div className="space-y-3 pt-3">
          <Input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="topic"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={partitionCount}
              onChange={(event) => setPartitionCount(event.target.value)}
              placeholder="new total partition count"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!api || !topic}
              onClick={() =>
                void run(() =>
                  api!.createPartitions({
                    connectionId,
                    topic,
                    count: Number(partitionCount),
                    validateOnly: true,
                  })
                )
              }
            >
              Validate partitions
            </Button>
            <Button
              size="sm"
              disabled={!api || topicConfirmation !== `ALTER ${topic}`}
              onClick={() =>
                void run(() =>
                  api!.createPartitions({
                    connectionId,
                    topic,
                    count: Number(partitionCount),
                    validateOnly: false,
                    confirmation: topicConfirmation,
                  })
                )
              }
            >
              Apply partitions
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={configName}
              onChange={(event) => setConfigName(event.target.value)}
              placeholder="config name"
            />
            <Input
              value={configValue}
              onChange={(event) => setConfigValue(event.target.value)}
              placeholder="config value"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!api || !topic || !configName}
            onClick={() =>
              void run(() =>
                api!.alterTopicConfigs({
                  connectionId,
                  topic,
                  configs: [{ name: configName, operation: 'set', value: configValue }],
                  validateOnly: true,
                })
              )
            }
          >
            Validate config
          </Button>
          <Input
            value={topicConfirmation}
            onChange={(event) => setTopicConfirmation(event.target.value)}
            placeholder={`ALTER ${topic || '<topic>'}`}
          />
          <Button
            size="sm"
            disabled={!api || !configName || topicConfirmation !== `ALTER ${topic}`}
            onClick={() =>
              void run(() =>
                api!.alterTopicConfigs({
                  connectionId,
                  topic,
                  configs: [{ name: configName, operation: 'set', value: configValue }],
                  validateOnly: false,
                  confirmation: topicConfirmation,
                })
              )
            }
          >
            Apply config
          </Button>
          <div className="grid grid-cols-3 gap-2">
            <Input
              aria-label="Partition to truncate"
              value={partition}
              onChange={(event) => setPartition(event.target.value)}
              placeholder="partition"
            />
            <Input
              aria-label="Delete before offset"
              value={offset}
              onChange={(event) => setOffset(event.target.value)}
              placeholder="offset"
            />
            <Input
              value={recordConfirmation}
              onChange={(event) => setRecordConfirmation(event.target.value)}
              placeholder={`DELETE RECORDS ${topic || '<topic>'}`}
            />
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={!api || !topic || recordConfirmation !== `DELETE RECORDS ${topic}`}
            onClick={() =>
              void run(() =>
                api!.deleteRecords({
                  connectionId,
                  topic,
                  partitions: [{ partition: Number(partition), offset }],
                  confirmation: recordConfirmation,
                })
              )
            }
          >
            Delete records before offset
          </Button>
          <p className="text-sp-11 text-sp-dim">
            Applying partition/config changes requires typing{' '}
            <code>ALTER {topic || '<topic>'}</code>. Record deletion requires the phrase shown
            above.
          </p>
        </div>
      </details>

      <details className="rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
        <summary className="cursor-pointer text-xs font-medium">ACLs</summary>
        <div className="space-y-2 pt-3">
          <Label className="text-xs sp-label">Typed ACL/filter JSON</Label>
          <Textarea value={aclJson} onChange={(event) => setAclJson(event.target.value)} />
          <Input
            value={aclConfirmation}
            onChange={(event) => setAclConfirmation(event.target.value)}
            placeholder="CREATE ACL or DELETE ACLS"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!api}
              onClick={() =>
                void run(() =>
                  api!.describeAcls({
                    connectionId,
                    filter: parseAcl(),
                  })
                )
              }
            >
              Describe ACLs
            </Button>
            <Button
              size="sm"
              disabled={!api || aclConfirmation !== 'CREATE ACL'}
              onClick={() =>
                void run(() =>
                  api!.createAcl({
                    connectionId,
                    acl: parseAcl(),
                    confirmation: aclConfirmation,
                  })
                )
              }
            >
              Create ACL
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!api || aclConfirmation !== 'DELETE ACLS'}
              onClick={() =>
                void run(() =>
                  api!.deleteAcls({
                    connectionId,
                    filter: parseAcl(),
                    confirmation: aclConfirmation,
                  })
                )
              }
            >
              Delete matching ACLs
            </Button>
          </div>
        </div>
      </details>

      <details className="rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
        <summary className="cursor-pointer text-xs font-medium">Client quotas</summary>
        <div className="grid grid-cols-2 gap-2 pt-3">
          <Input
            value={quotaEntity}
            onChange={(event) => setQuotaEntity(event.target.value)}
            placeholder="user entity"
          />
          <Input
            value={quotaValue}
            onChange={(event) => setQuotaValue(event.target.value)}
            placeholder="producer bytes/sec"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!api}
            onClick={() =>
              void run(() =>
                api!.describeQuotas({
                  connectionId,
                  entities: [{ entityType: 'user', entityName: quotaEntity }],
                })
              )
            }
          >
            Describe quotas
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!api}
            onClick={() =>
              void run(() =>
                api!.alterQuotas({
                  connectionId,
                  entities: [{ entityType: 'user', entityName: quotaEntity }],
                  operations: [
                    {
                      key: 'producer_byte_rate',
                      value: Number(quotaValue),
                      remove: false,
                    },
                  ],
                  validateOnly: true,
                })
              )
            }
          >
            Validate quota
          </Button>
          <Input
            value={quotaConfirmation}
            onChange={(event) => setQuotaConfirmation(event.target.value)}
            placeholder="ALTER QUOTAS"
          />
          <Button
            size="sm"
            disabled={!api || quotaConfirmation !== 'ALTER QUOTAS'}
            onClick={() =>
              void run(() =>
                api!.alterQuotas({
                  connectionId,
                  entities: [{ entityType: 'user', entityName: quotaEntity }],
                  operations: [
                    {
                      key: 'producer_byte_rate',
                      value: Number(quotaValue),
                      remove: false,
                    },
                  ],
                  validateOnly: false,
                  confirmation: quotaConfirmation,
                })
              )
            }
          >
            Apply quota
          </Button>
        </div>
      </details>
    </div>
  );
}

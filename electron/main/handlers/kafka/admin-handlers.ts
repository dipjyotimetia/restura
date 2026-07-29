import type * as KafkaLib from '@platformatic/kafka';
import { ipcMain } from 'electron';
import type { ZodSchema } from 'zod';
import { IPC } from '../../../shared/channels';
import { rateLimited, type KeyedRateLimiter } from '../../ipc/ipc-rate-limiter';
import { errorMessage } from '../../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  type KafkaAlterQuotasConfig,
  KafkaAlterQuotasSchema,
  KafkaAlterTopicConfigsSchema,
  type KafkaCreateAclConfig,
  KafkaCreateAclSchema,
  KafkaCreatePartitionsSchema,
  type KafkaDeleteAclsConfig,
  KafkaDeleteAclsSchema,
  KafkaDeleteGroupSchema,
  KafkaDeleteRecordsSchema,
  KafkaDeleteTopicSchema,
  type KafkaDescribeAclsConfig,
  KafkaDescribeAclsSchema,
  KafkaDescribeClusterSchema,
  type KafkaDescribeQuotasConfig,
  KafkaDescribeQuotasSchema,
  KafkaCreateTopicSchema,
  KafkaInspectGroupSchema,
  KafkaInspectTopicSchema,
  KafkaListGroupsSchema,
  KafkaListTopicsSchema,
  KafkaResetGroupOffsetsSchema,
} from '../../ipc/ipc-validators';
import {
  computeGroupLag,
  flattenConfigDescriptions,
  flattenGroup,
  topicWatermarks,
} from '../kafka-serde';

type Admin = KafkaLib.Admin;

export interface KafkaAdminEntry {
  clientOptions: KafkaLib.AdminOptions;
}

interface AdminDependencies {
  getEntry: (connectionId: string, ownerId: number) => KafkaAdminEntry | undefined;
  getKafka: () => typeof KafkaLib;
  rateLimiter: KeyedRateLimiter;
}

export function registerKafkaAdminHandlers(deps: AdminDependencies): void {
  const { getKafka } = deps;
  const handle = <TInput, TOutput>(
    channel: string,
    schema: ZodSchema<TInput>,
    handler: (input: TInput, event: Electron.IpcMainInvokeEvent) => Promise<TOutput> | TOutput
  ): void => {
    ipcMain.handle(
      channel,
      rateLimited(deps.rateLimiter, createValidatedEventHandler(channel, schema, handler))
    );
  };
  const withAdmin = async <T extends object>(
    connectionId: string,
    ownerId: number,
    fn: (admin: Admin) => Promise<T>
  ): Promise<({ success: true } & T) | { success: false; error: string }> => {
    const entry = deps.getEntry(connectionId, ownerId);
    if (!entry) return { success: false, error: 'Not connected' };
    const admin = new (getKafka().Admin)(entry.clientOptions);
    try {
      return { success: true, ...(await fn(admin)) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    } finally {
      try {
        await Promise.resolve(admin.close());
      } catch {
        /* ignore */
      }
    }
  };
  const partitionIndexes = async (admin: Admin, topic: string): Promise<number[]> => {
    const metadata = await admin.metadata({
      topics: [topic],
      autocreateTopics: false,
      forceUpdate: true,
    });
    const count = metadata.topics.get(topic)?.partitionsCount ?? 0;
    return Array.from({ length: count }, (_, index) => index);
  };
  const offsetsRequest = (topic: string, indexes: number[], timestamp: bigint) => ({
    topics: [
      { name: topic, partitions: indexes.map((partitionIndex) => ({ partitionIndex, timestamp })) },
    ],
  });

  handle(IPC.kafka.listTopics, KafkaListTopicsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
      topics: await admin.listTopics(),
    }))
  );
  handle(IPC.kafka.createTopic, KafkaCreateTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.createTopics({
        topics: [cfg.topic],
        partitions: cfg.partitions,
        replicas: cfg.replicationFactor,
      });
      return {};
    })
  );
  handle(IPC.kafka.deleteTopic, KafkaDeleteTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.deleteTopics({ topics: [cfg.topic] });
      return {};
    })
  );
  handle(IPC.kafka.listGroups, KafkaListGroupsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const groupsMap = await admin.listGroups();
      return {
        groups: Array.from(groupsMap.values()).map((group) => ({
          id: group.id,
          state: String(group.state),
          groupType: group.groupType,
          protocolType: group.protocolType,
        })),
      };
    })
  );
  handle(IPC.kafka.inspectTopic, KafkaInspectTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      const [indexes, configs] = await Promise.all([
        partitionIndexes(admin, cfg.topic),
        admin.describeConfigs({
          resources: [{ resourceType: kafka.ConfigResourceTypes.TOPIC, resourceName: cfg.topic }],
        }),
      ]);
      let partitions: ReturnType<typeof topicWatermarks> = [];
      if (indexes.length > 0) {
        const [earliest, latest] = await Promise.all([
          admin.listOffsets(
            offsetsRequest(cfg.topic, indexes, kafka.ListOffsetTimestamps.EARLIEST)
          ),
          admin.listOffsets(offsetsRequest(cfg.topic, indexes, kafka.ListOffsetTimestamps.LATEST)),
        ]);
        partitions = topicWatermarks(earliest[0]?.partitions ?? [], latest[0]?.partitions ?? []);
      }
      return { partitions, config: flattenConfigDescriptions(configs) };
    })
  );
  handle(IPC.kafka.inspectGroup, KafkaInspectGroupSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      const [describeMap, committedGroups] = await Promise.all([
        admin.describeGroups({ groups: [cfg.groupId] }),
        admin.listConsumerGroupOffsets({ groups: [{ groupId: cfg.groupId }] }),
      ]);
      const raw = describeMap.get(cfg.groupId);
      const committed =
        committedGroups.find((group) => group.groupId === cfg.groupId)?.topics ?? [];
      const latestRequest = committed
        .filter((topic) => topic.partitions.length > 0)
        .map((topic) => ({
          name: topic.name,
          partitions: topic.partitions.map((partition) => ({
            partitionIndex: partition.partitionIndex,
            timestamp: kafka.ListOffsetTimestamps.LATEST,
          })),
        }));
      const latest =
        latestRequest.length > 0 ? await admin.listOffsets({ topics: latestRequest }) : [];
      return {
        group: raw ? flattenGroup(raw) : null,
        offsets: computeGroupLag(committed, latest),
      };
    })
  );
  handle(IPC.kafka.resetGroupOffsets, KafkaResetGroupOffsetsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      let partitionOffsets: { partition: number; offset: bigint }[];
      if (cfg.to === 'specific') {
        partitionOffsets = (cfg.partitions ?? []).map((partition) => ({
          partition: partition.partition,
          offset: BigInt(partition.offset),
        }));
      } else {
        const indexes = await partitionIndexes(admin, cfg.topic);
        if (indexes.length === 0) {
          throw new Error(`Topic "${cfg.topic}" has no partitions or does not exist.`);
        }
        const timestamp =
          cfg.to === 'earliest'
            ? kafka.ListOffsetTimestamps.EARLIEST
            : kafka.ListOffsetTimestamps.LATEST;
        const listed = await admin.listOffsets(offsetsRequest(cfg.topic, indexes, timestamp));
        partitionOffsets = (listed[0]?.partitions ?? []).map((partition) => ({
          partition: partition.partitionIndex,
          offset: partition.offset,
        }));
      }
      await admin.alterConsumerGroupOffsets({
        groupId: cfg.groupId,
        topics: [{ name: cfg.topic, partitionOffsets }],
      });
      return {};
    })
  );
  handle(IPC.kafka.deleteGroup, KafkaDeleteGroupSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.deleteGroups({ groups: [cfg.groupId] });
      return {};
    })
  );
  handle(IPC.kafka.createPartitions, KafkaCreatePartitionsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.createPartitions({
        topics: [{ name: cfg.topic, count: cfg.count }],
        validateOnly: cfg.validateOnly,
      });
      return {};
    })
  );
  handle(IPC.kafka.alterTopicConfigs, KafkaAlterTopicConfigsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      const operations = kafka.IncrementalAlterConfigOperationTypes;
      await admin.incrementalAlterConfigs({
        resources: [
          {
            resourceType: kafka.ConfigResourceTypes.TOPIC,
            resourceName: cfg.topic,
            configs: cfg.configs.map((config) =>
              config.operation === 'delete'
                ? { name: config.name, configOperation: operations.DELETE }
                : {
                    name: config.name,
                    value: config.value,
                    configOperation:
                      config.operation === 'append'
                        ? operations.APPEND
                        : config.operation === 'subtract'
                          ? operations.SUBTRACT
                          : operations.SET,
                  }
            ),
          },
        ],
        validateOnly: cfg.validateOnly,
      });
      return {};
    })
  );
  handle(IPC.kafka.deleteRecords, KafkaDeleteRecordsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const deleted = await admin.deleteRecords({
        topics: [
          {
            name: cfg.topic,
            partitions: cfg.partitions.map((partition) => ({
              partition: partition.partition,
              offset: BigInt(partition.offset),
            })),
          },
        ],
      });
      return {
        lowWatermarks: (deleted[0]?.partitions ?? []).map((partition) => ({
          partition: partition.partition,
          offset: partition.lowWatermark.toString(),
        })),
      };
    })
  );
  handle(IPC.kafka.describeCluster, KafkaDescribeClusterSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const metadata = await admin.metadata({ autocreateTopics: false, forceUpdate: true });
      return {
        cluster: {
          id: metadata.id,
          controllerId: metadata.controllerId,
          brokers: Array.from(metadata.brokers, ([id, broker]) => ({
            id,
            host: broker.host,
            port: broker.port,
            rack: broker.rack,
          })),
          topics: Array.from(metadata.topics, ([name, topic]) => ({
            name,
            partitions: topic.partitionsCount,
          })),
        },
      };
    })
  );
  handle(IPC.kafka.describeAcls, KafkaDescribeAclsSchema, (cfg: KafkaDescribeAclsConfig, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
      acls: await admin.describeAcls({ filter: cfg.filter as KafkaLib.AclFilter }),
    }))
  );
  handle(IPC.kafka.createAcl, KafkaCreateAclSchema, (cfg: KafkaCreateAclConfig, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.createAcls({ creations: [cfg.acl as KafkaLib.Acl] });
      return {};
    })
  );
  handle(IPC.kafka.deleteAcls, KafkaDeleteAclsSchema, (cfg: KafkaDeleteAclsConfig, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
      deleted: await admin.deleteAcls({ filters: [cfg.filter as KafkaLib.AclFilter] }),
    }))
  );
  handle(
    IPC.kafka.describeQuotas,
    KafkaDescribeQuotasSchema,
    (cfg: KafkaDescribeQuotasConfig, event) =>
      withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
        quotas: await admin.describeClientQuotas({
          components: cfg.entities.map((entity) =>
            entity.entityName == null
              ? { entityType: entity.entityType, matchType: getKafka().ClientQuotaMatchTypes.ANY }
              : {
                  entityType: entity.entityType,
                  matchType: getKafka().ClientQuotaMatchTypes.EXACT,
                  match: entity.entityName,
                }
          ),
        }),
      }))
  );
  handle(IPC.kafka.alterQuotas, KafkaAlterQuotasSchema, (cfg: KafkaAlterQuotasConfig, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
      results: await admin.alterClientQuotas({
        entries: [
          {
            entities: cfg.entities.map((entity) => ({
              entityType: entity.entityType,
              ...(entity.entityName !== undefined ? { entityName: entity.entityName } : {}),
            })),
            ops: cfg.operations.map((operation) =>
              operation.remove
                ? { key: operation.key, remove: true }
                : { key: operation.key, value: operation.value!, remove: false }
            ),
          },
        ],
        validateOnly: cfg.validateOnly,
      }),
    }))
  );
}

/* biome-ignore-all lint */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: vendor/postman/v3.0.0/schema.json
 * Regenerate with: npm run gen:postman-v3-types
 */

/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "secret-source".
 */
export type PostmanV3SecretSource =
  | PostmanV3PostmanVaultSecret
  | PostmanV3AzureKeyVaultSecret
  | PostmanV3PasswordSecret
  | PostmanV3AWSSecretsManagerSecret
  | PostmanV3HashiCorpVaultSecret
  | PostmanV3PassportSecret;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-variables".
 */
export type PostmanV3Variables = (PostmanV3PlainVariable | PostmanV3SecretVariable)[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-collection-scripts".
 */
export type PostmanV3CollectionScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type:
    | "graphql:beforeQuery"
    | "graphql:afterResponse"
    | "grpc:beforeInvoke"
    | "grpc:onIncomingMessage"
    | "grpc:afterResponse"
    | "http:beforeRequest"
    | "http:afterResponse"
    | "kafka:beforeConsume"
    | "kafka:onIncomingMessage"
    | "kafka:afterConsume"
    | "kafka:beforeProduce"
    | "kafka:afterProduce";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-collection-auth".
 */
export type PostmanV3CollectionAuth = PostmanV3OneCredentialSet | PostmanV3CredentialSetsSelectedByRule;
export type PostmanV3OneCredentialSet = PostmanV3NoAuth | PostmanV3CredentialSet;
export type PostmanV3CredentialSetWithRules = PostmanV3CredentialSet1 | PostmanV3NoAuth1;
export type PostmanV3CredentialSetsSelectedByRule = PostmanV3CredentialSetWithRules[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-folder-scripts".
 */
export type PostmanV3FolderScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type:
    | "graphql:beforeQuery"
    | "graphql:afterResponse"
    | "grpc:beforeInvoke"
    | "grpc:onIncomingMessage"
    | "grpc:afterResponse"
    | "http:beforeRequest"
    | "http:afterResponse"
    | "kafka:beforeConsume"
    | "kafka:onIncomingMessage"
    | "kafka:afterConsume"
    | "kafka:beforeProduce"
    | "kafka:afterProduce";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-folder-auth".
 */
export type PostmanV3FolderAuth = PostmanV3OneCredentialSet1 | PostmanV3CredentialSetsSelectedByRule1;
export type PostmanV3OneCredentialSet1 = PostmanV3NoAuth2 | PostmanV3CredentialSet2;
export type PostmanV3CredentialSetWithRules1 = PostmanV3CredentialSet3 | PostmanV3NoAuth3;
export type PostmanV3CredentialSetsSelectedByRule1 = PostmanV3CredentialSetWithRules1[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-http-request-body".
 */
export type PostmanV3HTTPRequestBody = PostmanV3NoBody | PostmanV3MultipartFormBody | PostmanV3URLEncodedBody | PostmanV3RawBody | PostmanV3FileBody | PostmanV3GraphQLBody;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-http-auth".
 */
export type PostmanV3HTTPAuth = PostmanV3NoAuth4 | PostmanV3CredentialSet4;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-http-scripts".
 */
export type PostmanV3HTTPScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type: "beforeRequest" | "afterResponse";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-graphql-auth".
 */
export type PostmanV3GraphQLAuth = PostmanV3NoAuth5 | PostmanV3CredentialSet5;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-graphql-schema".
 */
export type PostmanV3GraphQLSchemaSource = PostmanV3SchemaSource;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-schema".
 */
export type PostmanV3SchemaSource =
  PostmanV3NoSchema | PostmanV3AutoDetectedSchema | PostmanV3SchemaFromAFile | PostmanV3SchemaFromAnAPI | PostmanV3SchemaFromASpecification | PostmanV3SchemaFromAURL;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-auth".
 */
export type PostmanV3Auth = PostmanV3OneCredentialSet2 | PostmanV3CredentialSetsSelectedByRule2;
export type PostmanV3OneCredentialSet2 = PostmanV3NoAuth6 | PostmanV3CredentialSet6;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-multi-auth-entry".
 */
export type PostmanV3CredentialSetWithRules2 = PostmanV3CredentialSet7 | PostmanV3NoAuth7;
export type PostmanV3CredentialSetsSelectedByRule2 = PostmanV3CredentialSetWithRules2[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-graphql-scripts".
 */
export type PostmanV3GraphQLScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type: "beforeQuery" | "afterResponse";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-grpc-auth".
 */
export type PostmanV3GRPCAuth = PostmanV3NoAuth8 | PostmanV3CredentialSet8;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-grpc-schema".
 */
export type PostmanV3GRPCSchemaSource = PostmanV3SchemaSource;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-grpc-scripts".
 */
export type PostmanV3GRPCScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type: "beforeInvoke" | "onIncomingMessage" | "afterResponse";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-websocket-auth".
 */
export type PostmanV3WebSocketAuth = PostmanV3NoAuth9 | PostmanV3CredentialSet9;
export type PostmanV3NoSubscriptionOptions = 0;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-auth".
 */
export type PostmanV3MQTTAuth = PostmanV3NoAuth10 | PostmanV3CredentialSet10;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-request".
 */
export type PostmanV3KafkaRequest = PostmanV3KafkaProducerRequest | PostmanV3KafkaConsumerRequest;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-auth".
 */
export type PostmanV3KafkaAuth = PostmanV3NoAuth11 | PostmanV3CredentialSet11;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-schema".
 */
export type PostmanV3KafkaSchemaSource = PostmanV3SchemaSource;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-message-schema".
 */
export type PostmanV3KafkaMessageSchemaSource = PostmanV3SchemaSource;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-scripts".
 */
export type PostmanV3KafkaScripts = {
  /**
   * Lifecycle point the script runs at.
   */
  type: "beforeConsume" | "onIncomingMessage" | "afterConsume" | "beforeProduce" | "afterProduce";
  /**
   * Source of the script.
   */
  code: string;
  /**
   * Language the script is written in.
   */
  language?: "text/javascript";
  /**
   * Package Library packages the script imports, keyed by the name it imports them under.
   */
  packages?: {
    [k: string]: {
      /**
       * Identifier of the package.
       */
      id: string;
    };
  };
  /**
   * Collection requests the script sends, keyed by the name it references them under.
   */
  requests?: {
    [k: string]: {
      /**
       * Identifier of the workspace.
       */
      workspace: string;
      /**
       * Identifier of the collection.
       */
      collection: string;
      /**
       * Path to the request, from the collection root.
       */
      location: string[];
    };
  };
}[];
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-topic-schema".
 */
export type PostmanV3KafkaTopicSchemaSource = PostmanV3SchemaSource;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mcp-request".
 */
export type PostmanV3MCPRequest = PostmanV3MCPRequestOverSSE | PostmanV3MCPRequestOverStdio;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mcp-auth".
 */
export type PostmanV3MCPAuth = PostmanV3NoAuth12 | PostmanV3CredentialSet12;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-llm-auth".
 */
export type PostmanV3LLMAuth = PostmanV3NoAuth13 | PostmanV3CredentialSet13;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-data-request".
 */
export type PostmanV3DataRequest =
  | PostmanV3PostgresDataRequest
  | PostmanV3MySQLDataRequest
  | PostmanV3RedisDataRequest
  | PostmanV3CSVDataRequest
  | PostmanV3JSONDataRequest
  | PostmanV3XLSXDataRequest
  | PostmanV3UnconfiguredDataRequest;
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-data-auth".
 */
export type PostmanV3DataAuth = PostmanV3NoAuth14 | PostmanV3CredentialSet14;

export interface PostmanV3Collection {
  /**
   * Identifier of the collection.
   */
  id?: string;
  /**
   * Display name of the collection.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "collection";
  /**
   * Variables available to every request in the collection.
   */
  variables?: PostmanV3Variables;
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3CollectionScripts;
  /**
   * Credentials inherited by every request in the collection.
   */
  auth?: PostmanV3CollectionAuth;
  /**
   * Resources the collection uses.
   */
  uses?: PostmanV3Uses;
  /**
   * Requests and folders the collection holds.
   */
  items?: (
    | PostmanV3Folder
    | PostmanV3HTTPRequest
    | PostmanV3GraphQLRequest
    | PostmanV3GRPCRequest
    | PostmanV3WebSocketRequest
    | PostmanV3SocketIORequest
    | PostmanV3MQTTRequest
    | PostmanV3KafkaRequest
    | PostmanV3MCPRequest
    | PostmanV3LLMRequest
    | PostmanV3DataRequest
  )[];
}
export interface PostmanV3PlainVariable {
  /**
   * Name of the variable.
   */
  key: string;
  /**
   * Value substituted wherever the variable is referenced.
   */
  value?: string;
  /**
   * Whether the variable is excluded from resolution.
   */
  disabled?: boolean;
  /**
   * Whether the variable references a secret rather than an inline value.
   */
  secret?: false;
  /**
   * Human-readable note about the variable.
   */
  description?: string;
}
export interface PostmanV3SecretVariable {
  /**
   * Name of the variable.
   */
  key: string;
  /**
   * Whether the variable references a secret rather than an inline value.
   */
  secret: true;
  /**
   * Whether the variable is excluded from resolution.
   */
  disabled?: boolean;
  /**
   * Human-readable note about the variable.
   */
  description?: string;
  /**
   * Vault the value is read from at run time.
   */
  source?: PostmanV3SecretSource;
}
export interface PostmanV3PostmanVaultSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "postman";
  /**
   * Location of the secret in a Postman vault.
   */
  postman: PostmanV3LocalPostmanVault | PostmanV3CloudPostmanVault;
}
export interface PostmanV3LocalPostmanVault {
  /**
   * Whether the Postman vault is stored locally or in the cloud.
   */
  type: "local";
  /**
   * Identifier of the secret.
   */
  secretId: string;
  /**
   * Identifier of the local vault holding the secret.
   */
  vaultId?: string;
}
export interface PostmanV3CloudPostmanVault {
  /**
   * Whether the Postman vault is stored locally or in the cloud.
   */
  type: "cloud";
  /**
   * Identifier of the secret.
   */
  secretId: string;
  /**
   * Identifier of the cloud vault holding the secret.
   */
  vaultId: string;
}
export interface PostmanV3AzureKeyVaultSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "azure";
  /**
   * Location of the secret in Azure Key Vault.
   */
  azure: {
    /**
     * Identifier of the secret.
     */
    secretId: string;
  };
}
export interface PostmanV3PasswordSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "1password";
  /**
   * Location of the secret in 1Password.
   */
  "1password": {
    /**
     * 1Password secret reference URI, such as `op://vault/item/field`.
     */
    secretReference: string;
  };
}
export interface PostmanV3AWSSecretsManagerSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "aws";
  /**
   * Location of the secret in AWS Secrets Manager.
   */
  aws: {
    /**
     * ARN of the secret in AWS Secrets Manager.
     */
    secretArn: string;
    /**
     * ARN of the role assumed to read the secret.
     */
    roleArn?: string;
    /**
     * Version of the secret to read. Defaults to the current one.
     */
    version?: string;
    /**
     * How the stored secret value is encoded.
     */
    format?: "json" | "plaintext";
  };
}
export interface PostmanV3HashiCorpVaultSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "hashicorp";
  /**
   * Location of the secret in HashiCorp Vault.
   */
  hashicorp: {
    /**
     * Name of the Vault secrets engine holding the secret.
     */
    engine: string;
    /**
     * Path to the secret within the engine.
     */
    path: string;
    /**
     * Key to read from the secret.
     */
    key: string;
    /**
     * Version of the secret to read. Defaults to the current one.
     */
    version?: string;
  };
}
export interface PostmanV3PassportSecret {
  /**
   * Vault provider the secret is read from.
   */
  provider: "passport";
  /**
   * Location of the secret behind a Passport proxy.
   */
  passport: {
    /**
     * Name of the upstream provider Passport brokers access to.
     */
    provider: string;
    /**
     * Identifier of the Passport proxy serving the secret.
     */
    proxyId: string;
    /**
     * JSON pointer to the value within the brokered payload.
     */
    pointer: string;
    /**
     * Identifier of the namespace the secret belongs to.
     */
    namespaceId?: string;
  };
}
export interface PostmanV3NoAuth {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply.
   */
  type:
    | "basic"
    | "bearer"
    | "apikey"
    | "oauth1"
    | "oauth2"
    | "jwt"
    | "ntlm"
    | "digest"
    | "edgegrid"
    | "hawk"
    | "asap"
    | "awsv4"
    | "sasl";
}
export interface PostmanV3CredentialSet1 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply.
   */
  type:
    | "basic"
    | "bearer"
    | "apikey"
    | "oauth1"
    | "oauth2"
    | "jwt"
    | "ntlm"
    | "digest"
    | "edgegrid"
    | "hawk"
    | "asap"
    | "awsv4"
    | "sasl";
}
export interface PostmanV3NoAuth1 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-collection-uses".
 */
export interface PostmanV3Uses {
  /**
   * Identifiers of the environments the collection uses.
   */
  environment?: string[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-folder".
 */
export interface PostmanV3Folder {
  /**
   * Identifier of the folder.
   */
  id?: string;
  /**
   * Display name of the folder.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "collection";
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3FolderScripts;
  /**
   * Credentials inherited by every request in the folder.
   */
  auth?: PostmanV3FolderAuth;
  /**
   * Requests and folders the folder holds.
   */
  items?: (
    | PostmanV3Folder
    | PostmanV3HTTPRequest
    | PostmanV3GraphQLRequest
    | PostmanV3GRPCRequest
    | PostmanV3WebSocketRequest
    | PostmanV3SocketIORequest
    | PostmanV3MQTTRequest
    | PostmanV3KafkaRequest
    | PostmanV3MCPRequest
    | PostmanV3LLMRequest
    | PostmanV3DataRequest
  )[];
}
export interface PostmanV3NoAuth2 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet2 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply.
   */
  type:
    | "awsv4"
    | "basic"
    | "bearer"
    | "hawk"
    | "oauth1"
    | "oauth2"
    | "apikey"
    | "edgegrid"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap"
    | "sasl";
}
export interface PostmanV3CredentialSet3 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply.
   */
  type:
    | "awsv4"
    | "basic"
    | "bearer"
    | "hawk"
    | "oauth1"
    | "oauth2"
    | "apikey"
    | "edgegrid"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap"
    | "sasl";
}
export interface PostmanV3NoAuth3 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-http-request".
 */
export interface PostmanV3HTTPRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * URL the request is sent to, including any query string.
   */
  url?: string;
  /**
   * HTTP method of the request.
   */
  method?: string;
  /**
   * Headers sent with the request.
   */
  headers?: PostmanV3DescriptiveKeyValueWithType[];
  /**
   * Parameters appended to the URL query string.
   */
  queryParams?: {
    /**
     * Name of the parameter.
     */
    key?: string | null;
    /**
     * Value of the parameter.
     */
    value?: string | null;
    /**
     * Human-readable note about the parameter.
     */
    description?: string;
    /**
     * Whether the parameter is left out of the URL.
     */
    disabled?: boolean;
    /**
     * JSON Schema for the value, either a type name such as `number` or a serialized schema object.
     */
    $type?: string;
  }[];
  /**
   * Values substituted for `:name` segments in the URL path.
   */
  pathVariables?: PostmanV3DescriptiveKeyValueWithType[];
  /**
   * Payload sent with the request.
   */
  body?: PostmanV3HTTPRequestBody;
  /**
   * Credentials applied to the request.
   */
  auth?: PostmanV3HTTPAuth;
  $kind: "http-request";
  /**
   * Saved request and response pairs for this request.
   */
  examples?: PostmanV3HTTPExample[];
  /**
   * Transport settings for the request.
   */
  settings?: {
    /**
     * HTTP version used for the request.
     */
    protocolVersion?: "auto" | "http1" | "http2";
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * Whether redirect responses are followed.
     */
    followRedirects?: boolean;
    /**
     * How many redirects are followed before giving up.
     */
    maxRedirects?: number;
    /**
     * Whether a redirect keeps the original method instead of switching to GET.
     */
    followOriginalHttpMethod?: boolean;
    /**
     * Whether the Authorization header is kept when a redirect changes host.
     */
    followAuthorizationHeader?: boolean;
    /**
     * Whether the Referer header is dropped when following a redirect.
     */
    removeRefererHeaderOnRedirect?: boolean;
    /**
     * Whether responses that violate the HTTP spec are accepted.
     */
    insecureHTTPParser?: boolean;
    /**
     * Whether the URL is sent as authored, without encoding.
     */
    disableUrlEncoding?: boolean;
    /**
     * Whether the cookie jar is bypassed for the request.
     */
    disableCookies?: boolean;
    /**
     * Largest response accepted, in bytes.
     */
    maxResponseSize?: number;
    /**
     * Largest response header block accepted, in bytes.
     */
    maxHeaderSize?: number;
    /**
     * Whether the server cipher order wins over the client order.
     */
    tlsPreferServerCiphers?: boolean;
    /**
     * TLS versions the handshake refuses.
     */
    tlsDisabledProtocols?: ("TLSv1" | "TLSv1_1" | "TLSv1_2" | "TLSv1_3")[];
    /**
     * Ciphers offered in the handshake, in order of preference.
     */
    tlsCipherSelection?: string[];
    /**
     * Headers Postman adds by default that are suppressed.
     */
    disabledSystemHeaders?: (
      | "cache-control"
      | "postman-token"
      | "content-type"
      | "content-length"
      | "accept-encoding"
      | "user-agent"
      | "connection"
      | "accept"
      | "host"
      | "x-amz-date"
      | "x-amz-security-token"
      | "x-amz-content-sha256"
    )[];
  };
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3HTTPScripts;
  /**
   * Source request this request reuses.
   */
  uses?: {
    /**
     * Identifier of the source request.
     */
    items: string[];
  };
  /**
   * Requests that reuse this request as their source.
   */
  usedBy?: {
    /**
     * Identifiers of the requests that reuse this one.
     */
    items: string[];
  };
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-key-value-meta-with-type".
 */
export interface PostmanV3DescriptiveKeyValueWithType {
  /**
   * Name of the entry.
   */
  key: string;
  /**
   * Value of the entry.
   */
  value: string;
  /**
   * Whether the entry is excluded from the request.
   */
  disabled?: boolean;
  /**
   * Human-readable note about the entry.
   */
  description?: string;
  /**
   * JSON Schema for the value, either a type name such as `number` or a serialized schema object.
   */
  $type?: string;
}
export interface PostmanV3NoBody {
  /**
   * Format of the request body.
   */
  type: "none";
}
export interface PostmanV3MultipartFormBody {
  /**
   * Format of the request body.
   */
  type: "formdata";
  /**
   * Parts of the multipart body.
   */
  content: (PostmanV3TextPart | PostmanV3FilePart)[];
}
export interface PostmanV3TextPart {
  /**
   * Kind of form part.
   */
  type: "text";
  /**
   * Name of the form field.
   */
  key: string;
  /**
   * Value of the form field.
   */
  value: string;
  /**
   * Content type sent for this part.
   */
  contentType?: string;
  /**
   * Human-readable note about the field.
   */
  description?: string;
  /**
   * Whether the field is left out of the body.
   */
  disabled?: boolean;
}
export interface PostmanV3FilePart {
  /**
   * Kind of form part.
   */
  type: "file";
  /**
   * Name of the form field.
   */
  key: string;
  /**
   * Path to the file, or paths for a multi-file field.
   */
  src: string | string[];
  /**
   * Content type sent for this part.
   */
  contentType?: string;
  /**
   * Human-readable note about the field.
   */
  description?: string;
  /**
   * Whether the field is left out of the body.
   */
  disabled?: boolean;
}
export interface PostmanV3URLEncodedBody {
  /**
   * Format of the request body.
   */
  type: "urlencoded";
  /**
   * Fields encoded into the body as a query string.
   */
  content: PostmanV3DescriptiveKeyValue[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-key-value-meta".
 */
export interface PostmanV3DescriptiveKeyValue {
  /**
   * Name of the entry.
   */
  key: string;
  /**
   * Value of the entry.
   */
  value: string;
  /**
   * Whether the entry is excluded from the request.
   */
  disabled?: boolean;
  /**
   * Human-readable note about the entry.
   */
  description?: string;
}
export interface PostmanV3RawBody {
  /**
   * Format of the request body.
   */
  type: "text" | "json" | "xml" | "html" | "javascript";
  /**
   * Raw body, as text.
   */
  content: string;
  /**
   * JSON Schema for the body, either a type name such as `object` or a serialized schema object.
   */
  $type?: string;
}
export interface PostmanV3FileBody {
  /**
   * Format of the request body.
   */
  type: "file";
  /**
   * File sent as the body.
   */
  content: {
    /**
     * Path to the file sent as the body.
     */
    src?: string;
  };
}
export interface PostmanV3GraphQLBody {
  /**
   * Format of the request body.
   */
  type: "graphql";
  /**
   * GraphQL payload sent as the body.
   */
  content: {
    /**
     * GraphQL document holding the operations to send.
     */
    query: string;
    /**
     * Variables for the operation, as a JSON object.
     */
    variables?: string;
    /**
     * Operation to run, for a query document that defines several.
     */
    operationName?: string | null;
  };
}
export interface PostmanV3NoAuth4 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet4 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type:
    | "inherit"
    | "basic"
    | "bearer"
    | "apikey"
    | "oauth1"
    | "oauth2"
    | "jwt"
    | "ntlm"
    | "digest"
    | "edgegrid"
    | "hawk"
    | "asap"
    | "awsv4";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-http-example".
 */
export interface PostmanV3HTTPExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Credentials applied to the request.
   */
  auth?: PostmanV3HTTPAuth;
  $kind: "http-example";
  /**
   * Request the example was captured from.
   */
  request?: {
    /**
     * URL the request is sent to, including any query string.
     */
    url?: string;
    /**
     * HTTP method of the request.
     */
    method?: string;
    /**
     * Headers sent with the request.
     */
    headers?: PostmanV3DescriptiveKeyValue[];
    /**
     * Parameters appended to the URL query string.
     */
    queryParams?: {
      /**
       * Name of the parameter.
       */
      key?: string | null;
      /**
       * Value of the parameter.
       */
      value?: string | null;
      /**
       * Human-readable note about the parameter.
       */
      description?: string;
      /**
       * Whether the parameter is left out of the URL.
       */
      disabled?: boolean;
    }[];
    /**
     * Values substituted for `:name` segments in the URL path.
     */
    pathVariables?: PostmanV3DescriptiveKeyValue[];
    /**
     * Payload sent with the request.
     */
    body?: PostmanV3HTTPRequestBody;
  };
  /**
   * Response captured for the example.
   */
  response: {
    /**
     * HTTP status code of the response.
     */
    statusCode: number;
    /**
     * Reason phrase sent with the status code.
     */
    statusText: string;
    /**
     * Headers returned with the response.
     */
    headers?: PostmanV3DescriptiveKeyValueWithType[];
    /**
     * Body of the response.
     */
    body: {
      /**
       * How the body is rendered.
       */
      type: "text" | "json" | "xml" | "html" | "javascript" | "yaml";
      /**
       * Response body, as text.
       */
      content: string;
      /**
       * JSON Schema for the body, either a type name such as `object` or a serialized schema object.
       */
      $type?: string;
    };
  };
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-graphql-request".
 */
export interface PostmanV3GraphQLRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * URL of the GraphQL endpoint.
   */
  url?: string;
  /**
   * GraphQL document holding the operations to send.
   */
  query?: string;
  /**
   * Variables for the operation, as a JSON object.
   */
  variables?: string;
  /**
   * Headers sent with the request.
   */
  headers?: PostmanV3DescriptiveKeyValue[];
  /**
   * Transport settings for the request.
   */
  settings?: {
    /**
     * Headers Postman adds by default that are suppressed.
     */
    disabledSystemHeaders?: string[];
  };
  /**
   * Credentials applied to the request.
   */
  auth?: PostmanV3GraphQLAuth;
  /**
   * Source of the GraphQL schema used for validation.
   */
  schema?: PostmanV3GraphQLSchemaSource;
  /**
   * Operation to run, for a query document that defines several.
   */
  operationName?: string;
  $kind: "graphql-request";
  /**
   * Saved request and response pairs for this request.
   */
  examples?: PostmanV3GraphQLExample[];
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3GraphQLScripts;
}
export interface PostmanV3NoAuth5 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet5 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type:
    | "inherit"
    | "basic"
    | "bearer"
    | "apikey"
    | "oauth1"
    | "oauth2"
    | "edgegrid"
    | "hawk"
    | "awsv4"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap";
}
export interface PostmanV3NoSchema {
  /**
   * Where the schema is loaded from.
   */
  source: "none";
}
export interface PostmanV3AutoDetectedSchema {
  /**
   * Where the schema is loaded from.
   */
  source: "auto";
}
export interface PostmanV3SchemaFromAFile {
  /**
   * Where the schema is loaded from.
   */
  source: "file";
  /**
   * Path to the schema file, relative to the working directory.
   */
  location: string;
}
export interface PostmanV3SchemaFromAnAPI {
  /**
   * Where the schema is loaded from.
   */
  source: "api";
  /**
   * Identifier of the Postman API.
   */
  apiId: string;
  /**
   * Identifier of the API version the schema belongs to.
   */
  versionId: string;
  /**
   * Identifier of the release to pin the schema to. Defaults to the latest.
   */
  releaseId?: string;
}
export interface PostmanV3SchemaFromASpecification {
  /**
   * Where the schema is loaded from.
   */
  source: "specification";
  /**
   * Identifier of the Postman specification.
   */
  specificationId: string;
}
export interface PostmanV3SchemaFromAURL {
  /**
   * Where the schema is loaded from.
   */
  source: "url";
  /**
   * URL the schema is fetched from.
   */
  url: string;
  /**
   * Credentials used to fetch the schema.
   */
  auth?: PostmanV3Auth;
}
export interface PostmanV3NoAuth6 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet6 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type:
    | "awsv4"
    | "basic"
    | "bearer"
    | "hawk"
    | "oauth1"
    | "oauth2"
    | "apikey"
    | "edgegrid"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap"
    | "azure"
    | "sasl"
    | "inherit";
}
export interface PostmanV3CredentialSet7 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply.
   */
  type:
    | "awsv4"
    | "basic"
    | "bearer"
    | "hawk"
    | "oauth1"
    | "oauth2"
    | "apikey"
    | "edgegrid"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap"
    | "azure"
    | "sasl";
}
export interface PostmanV3NoAuth7 {
  /**
   * Identifier of the credential set.
   */
  id: string;
  /**
   * Display name of the credential set.
   */
  name: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Conditions that select this credential set. A request uses the first set whose rules all match.
   */
  rules?: {
    /**
     * Property the rule matches on.
     */
    key: "url";
    /**
     * Value the property has to match.
     */
    value: string;
  }[];
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-graphql-example".
 */
export interface PostmanV3GraphQLExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Transport settings for the request.
   */
  settings?: {
    /**
     * Headers Postman adds by default that are suppressed.
     */
    disabledSystemHeaders?: string[];
  };
  /**
   * Credentials applied to the request.
   */
  auth?: PostmanV3GraphQLAuth;
  /**
   * Source of the GraphQL schema used for validation.
   */
  schema?: PostmanV3GraphQLSchemaSource;
  $kind: "graphql-example";
  /**
   * Request the example was captured from.
   */
  request?: {
    /**
     * URL of the GraphQL endpoint.
     */
    url?: string;
    /**
     * GraphQL document holding the operations to send.
     */
    query?: string;
    /**
     * Variables for the operation, as a JSON object.
     */
    variables?: string;
    /**
     * Headers sent with the request.
     */
    headers?: PostmanV3DescriptiveKeyValue[];
    /**
     * Kind of GraphQL operation that was sent.
     */
    operationType?: "query" | "mutation" | "subscription";
    /**
     * Operation that was run.
     */
    operationName?: string;
  };
  /**
   * Response captured for the example.
   */
  response: {
    /**
     * Responses received, in the order they arrived.
     */
    events: {
      /**
       * Identifier of the event.
       */
      id: string;
      /**
       * Kind of event.
       */
      type: "received-response";
      /**
       * Payload the server sent, as text.
       */
      content: string;
    }[];
    /**
     * Underlying HTTP response that carried the result.
     */
    http?: {
      /**
       * HTTP status line of the response.
       */
      status: string;
      /**
       * Headers returned with the response.
       */
      headers?: PostmanV3KeyValue[];
      /**
       * Raw HTTP response body.
       */
      body?: string;
    };
  };
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-key-value".
 */
export interface PostmanV3KeyValue {
  /**
   * Name of the entry.
   */
  key: string;
  /**
   * Value of the entry.
   */
  value: string;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-grpc-request".
 */
export interface PostmanV3GRPCRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Host and port of the gRPC server.
   */
  url?: string;
  /**
   * Fully qualified method to invoke, as `package.Service/Method`.
   */
  methodPath?: string;
  /**
   * Serialized descriptor of the method, for calls made without a schema.
   */
  methodDescriptor?: string;
  /**
   * Message sent when the call is invoked.
   */
  message?: {
    /**
     * Message body, as JSON.
     */
    content?: string;
  };
  /**
   * Metadata sent with the call.
   */
  metadata?: PostmanV3DescriptiveKeyValue[];
  /**
   * Transport settings for the call.
   */
  settings?: {
    /**
     * Whether the connection uses TLS.
     */
    secureConnection?: boolean;
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * Server name checked against the certificate.
     */
    serverNameOverride?: string;
    /**
     * Largest response message accepted, in bytes.
     */
    maxResponseMessageSize?: number;
    /**
     * Whether fields left at their default are kept in the response.
     */
    includeDefaultFields?: boolean;
    /**
     * How long to wait for the connection, in milliseconds.
     */
    connectionTimeout?: number;
  };
  /**
   * Credentials applied to the call.
   */
  auth?: PostmanV3GRPCAuth;
  /**
   * Source of the protobuf definition the call is made against.
   */
  schema?: PostmanV3GRPCSchemaSource;
  $kind: "grpc-request";
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3GRPCScripts;
  /**
   * Saved call and response pairs for this request.
   */
  examples?: PostmanV3GRPCExample[];
}
export interface PostmanV3NoAuth8 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet8 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "inherit" | "basic" | "bearer" | "apikey" | "oauth2";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-grpc-example".
 */
export interface PostmanV3GRPCExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Transport settings for the call.
   */
  settings?: {
    /**
     * Whether the connection uses TLS.
     */
    secureConnection?: boolean;
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * Server name checked against the certificate.
     */
    serverNameOverride?: string;
    /**
     * Largest response message accepted, in bytes.
     */
    maxResponseMessageSize?: number;
    /**
     * Whether fields left at their default are kept in the response.
     */
    includeDefaultFields?: boolean;
    /**
     * How long to wait for the connection, in milliseconds.
     */
    connectionTimeout?: number;
  };
  /**
   * Credentials applied to the call.
   */
  auth?: PostmanV3GRPCAuth;
  /**
   * Source of the protobuf definition the call is made against.
   */
  schema?: PostmanV3GRPCSchemaSource;
  $kind: "grpc-example";
  /**
   * Call the example was captured from.
   */
  request?: {
    /**
     * Host and port of the gRPC server.
     */
    url?: string;
    /**
     * Fully qualified method to invoke, as `package.Service/Method`.
     */
    methodPath?: string;
    /**
     * Serialized descriptor of the method, for calls made without a schema.
     */
    methodDescriptor?: string;
    /**
     * Message sent when the call is invoked.
     */
    message?: {
      /**
       * Message body, as JSON.
       */
      content?: string;
    };
    /**
     * Metadata sent with the call.
     */
    metadata?: PostmanV3DescriptiveKeyValue[];
  };
  /**
   * Response captured for the example.
   */
  response: {
    /**
     * gRPC status code of the call.
     */
    code: number;
    /**
     * Metadata the server sent with the response.
     */
    metadata: PostmanV3KeyValue[];
    /**
     * Trailers the server sent after the response.
     */
    trailers: PostmanV3KeyValue[];
    /**
     * Messages exchanged, in the order they occurred.
     */
    messages: {
      /**
       * Identifier of the message.
       */
      id: string;
      /**
       * Direction of the message, or an error record.
       */
      type: "incoming" | "outgoing" | "error";
      /**
       * Message body, as JSON.
       */
      content: string;
    }[];
  };
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-websocket-request".
 */
export interface PostmanV3WebSocketRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * URL of the WebSocket endpoint.
   */
  url?: string;
  /**
   * Headers sent with the handshake request.
   */
  headers?: PostmanV3DescriptiveKeyValue[];
  /**
   * Parameters appended to the URL query string.
   */
  queryParams?: {
    /**
     * Name of the parameter.
     */
    key?: string | null;
    /**
     * Value of the parameter.
     */
    value?: string | null;
    /**
     * Human-readable note about the parameter.
     */
    description?: string;
    /**
     * Whether the parameter is left out of the URL.
     */
    disabled?: boolean;
  }[];
  /**
   * Credentials applied to the handshake request.
   */
  auth?: PostmanV3WebSocketAuth;
  $kind: "websocket-request";
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * How long to wait for the handshake, in milliseconds.
     */
    handshakeTimeout?: number;
    /**
     * How many times to retry a failed connection.
     */
    retryCount?: number;
    /**
     * Largest message accepted, in bytes.
     */
    maxPayload?: number;
    /**
     * How long to wait between retries, in milliseconds.
     */
    retryDelay?: number;
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
  };
  /**
   * Saved messages that can be sent over the connection.
   */
  messages?: PostmanV3WebSocketMessage[];
  /**
   * Saved sessions captured for this request.
   */
  examples?: PostmanV3WebSocketExample[];
}
export interface PostmanV3NoAuth9 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet9 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type:
    | "awsv4"
    | "basic"
    | "bearer"
    | "hawk"
    | "oauth1"
    | "oauth2"
    | "apikey"
    | "edgegrid"
    | "jwt"
    | "digest"
    | "ntlm"
    | "asap"
    | "inherit";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-websocket-message".
 */
export interface PostmanV3WebSocketMessage {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the message.
   */
  name: string;
  $kind: "websocket-message";
  /**
   * Payload sent over the connection.
   */
  content: string;
  /**
   * How the payload is encoded.
   */
  contentType: "text" | "json" | "xml" | "html" | "hex" | "base64";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-websocket-example".
 */
export interface PostmanV3WebSocketExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "websocket-example";
  /**
   * Request the example was captured from.
   */
  request?: {
    /**
     * URL of the WebSocket endpoint.
     */
    url?: string;
    /**
     * Headers sent with the handshake request.
     */
    headers?: PostmanV3DescriptiveKeyValue[];
    /**
     * Parameters appended to the URL query string.
     */
    queryParams?: {
      /**
       * Name of the parameter.
       */
      key?: string | null;
      /**
       * Value of the parameter.
       */
      value?: string | null;
      /**
       * Human-readable note about the parameter.
       */
      description?: string;
      /**
       * Whether the parameter is left out of the URL.
       */
      disabled?: boolean;
    }[];
    /**
     * Credentials applied to the handshake request.
     */
    auth?: PostmanV3WebSocketAuth;
  };
  /**
   * Session captured for the example.
   */
  response: {
    /**
     * Close code and reason the connection ended with.
     */
    disconnectStatus?: string;
    /**
     * Events recorded during the session, in order.
     */
    events?: (PostmanV3MessageEvent | PostmanV3HandshakeEvent | PostmanV3NoticeEvent)[];
  };
}
export interface PostmanV3MessageEvent {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Direction the message traveled.
   */
  type: "incoming" | "outgoing";
  /**
   * Payload of the message.
   */
  content?: string;
  /**
   * How the payload is encoded.
   */
  contentType?: "text" | "json" | "hex";
}
export interface PostmanV3HandshakeEvent {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Outcome the event records.
   */
  type: "error" | "success";
  /**
   * HTTP status code of the handshake response.
   */
  statusCode?: number;
  /**
   * URL the connection was made to.
   */
  requestUrl?: string;
  /**
   * Whether Postman raised the event rather than the server.
   */
  system?: boolean;
  /**
   * Headers returned with the handshake response.
   */
  responseHeaders?: PostmanV3DescriptiveKeyValue[];
}
export interface PostmanV3NoticeEvent {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Kind of event.
   */
  type: "info";
  /**
   * Text of the notice.
   */
  content?: string;
  /**
   * Whether Postman raised the event rather than the server.
   */
  system?: boolean;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-socketio-request".
 */
export interface PostmanV3SocketIORequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * URL of the Socket.IO server.
   */
  url?: string;
  /**
   * Headers sent with the handshake request.
   */
  headers?: PostmanV3DescriptiveKeyValue[];
  /**
   * Parameters appended to the URL query string.
   */
  queryParams?: {
    /**
     * Name of the parameter.
     */
    key?: string | null;
    /**
     * Value of the parameter.
     */
    value?: string | null;
    /**
     * Human-readable note about the parameter.
     */
    description?: string;
    /**
     * Whether the parameter is left out of the URL.
     */
    disabled?: boolean;
  }[];
  /**
   * Events the client subscribes to.
   */
  events?: PostmanV3SocketIOSubscriptionEvent[];
  $kind: "socket.io-request";
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * Socket.IO protocol version the client speaks.
     */
    version?: "2" | "3" | "4";
    /**
     * Path the Socket.IO server is mounted at.
     */
    path?: string;
    /**
     * How long to wait for the handshake, in milliseconds.
     */
    handshakeTimeout?: number;
    /**
     * How many times to retry a failed connection.
     */
    retryCount?: number;
    /**
     * How long to wait between retries, in milliseconds.
     */
    retryDelay?: number;
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
  };
  /**
   * Saved messages that can be emitted over the connection.
   */
  messages?: PostmanV3SocketIOMessage[];
  /**
   * Saved sessions captured for this request.
   */
  examples?: PostmanV3SocketIOExample[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-socketio-subscription-event".
 */
export interface PostmanV3SocketIOSubscriptionEvent {
  /**
   * Name of the Socket.IO event.
   */
  name: string;
  /**
   * Human-readable note about the event.
   */
  description?: string;
  /**
   * Whether to listen for the event as soon as the connection opens.
   */
  subscribeOnConnect?: boolean;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-socketio-message".
 */
export interface PostmanV3SocketIOMessage {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the message.
   */
  name: string;
  /**
   * Human-readable note about the message.
   */
  description?: string;
  $kind: "socket.io-message";
  /**
   * Socket.IO event the message is emitted as.
   */
  eventName: string;
  /**
   * Whether the client waits for the server to acknowledge the message.
   */
  acknowledgement?: boolean;
  /**
   * Arguments sent with the event, in order.
   *
   * @minItems 1
   */
  args: [PostmanV3SocketIOMessageArgument, ...PostmanV3SocketIOMessageArgument[]];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-socketio-message-arg".
 */
export interface PostmanV3SocketIOMessageArgument {
  /**
   * Payload of the argument.
   */
  content: string;
  /**
   * How the payload is encoded.
   */
  contentType: "text" | "json" | "hex" | "base64";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-socketio-example".
 */
export interface PostmanV3SocketIOExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "socket.io-example";
  /**
   * Request the example was captured from.
   */
  request?: {
    /**
     * URL of the Socket.IO server.
     */
    url?: string;
    /**
     * Headers sent with the handshake request.
     */
    headers?: PostmanV3DescriptiveKeyValue[];
    /**
     * Parameters appended to the URL query string.
     */
    queryParams?: {
      /**
       * Name of the parameter.
       */
      key?: string | null;
      /**
       * Value of the parameter.
       */
      value?: string | null;
      /**
       * Human-readable note about the parameter.
       */
      description?: string;
      /**
       * Whether the parameter is left out of the URL.
       */
      disabled?: boolean;
    }[];
    /**
     * Events the client subscribes to.
     */
    events?: PostmanV3SocketIOSubscriptionEvent[];
  };
  /**
   * Session captured for the example.
   */
  response: {
    /**
     * Events recorded during the session, in order.
     */
    events?: (PostmanV3MessageEvent1 | PostmanV3HandshakeEvent1 | PostmanV3NoticeEvent1)[];
  };
}
export interface PostmanV3MessageEvent1 {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Direction the message traveled.
   */
  type: "incoming" | "outgoing";
  /**
   * Payload of the message.
   */
  content?: string;
  /**
   * Socket.IO event the message was sent as.
   */
  eventName?: string;
  /**
   * How the payload is encoded.
   */
  contentType?: "text" | "json" | "binary";
}
export interface PostmanV3HandshakeEvent1 {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Outcome the event records.
   */
  type: "error" | "success";
  /**
   * HTTP status code of the handshake response.
   */
  statusCode?: number;
  /**
   * URL the connection was made to.
   */
  requestUrl?: string;
  /**
   * Whether Postman raised the event rather than the server.
   */
  system?: boolean;
  /**
   * Headers returned with the handshake response.
   */
  responseHeaders?: PostmanV3DescriptiveKeyValue[];
}
export interface PostmanV3NoticeEvent1 {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Kind of event.
   */
  type: "info";
  /**
   * Text of the notice.
   */
  content?: string;
  /**
   * Whether Postman raised the event rather than the server.
   */
  system?: boolean;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-request".
 */
export interface PostmanV3MQTTRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * URL of the MQTT broker.
   */
  url?: string;
  /**
   * Client identifier sent to the broker.
   */
  clientId?: string;
  /**
   * MQTT protocol version, 4 for 3.1.1 or 5 for 5.0.
   */
  version?: 4 | 5;
  /**
   * Topics the client subscribes to.
   */
  topics?: PostmanV3MQTTTopic[];
  /**
   * Message the broker publishes if the client disconnects unexpectedly.
   */
  lastWill?: PostmanV3MQTTLastWill;
  /**
   * MQTT 5 properties sent with the connect packet.
   */
  properties?: PostmanV3MQTTConnectionProperties;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3MQTTAuth;
  $kind: "mqtt-request";
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * Whether the broker discards session state from earlier connections.
     */
    cleanSession?: boolean;
    /**
     * Interval between keep-alive pings, in seconds.
     */
    keepAlive?: number;
    /**
     * Whether the client reconnects after the connection drops.
     */
    autoReconnect?: boolean;
    /**
     * How long to wait for the connection, in milliseconds.
     */
    connectionTimeout?: number;
    /**
     * Whether the broker certificate is verified.
     */
    strictSSL?: boolean;
  };
  /**
   * Saved messages that can be published over the connection.
   */
  messages?: PostmanV3MQTTMessage[];
  /**
   * Saved sessions captured for this request.
   */
  examples?: PostmanV3MQTTExample[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-topic".
 */
export interface PostmanV3MQTTTopic {
  /**
   * Topic filter, which may contain wildcards.
   */
  name: string;
  /**
   * Delivery guarantee requested for the subscription.
   */
  qos?: 0 | 1 | 2;
  /**
   * Whether the client subscribes to the topic on connect.
   */
  subscribe?: boolean;
  /**
   * Human-readable note about the topic.
   */
  description?: string;
  /**
   * MQTT 5 subscription options for the topic.
   */
  settings?: PostmanV3SubscriptionOptions | PostmanV3NoSubscriptionOptions;
  /**
   * Custom key-value properties sent with the subscription.
   */
  userProperties?: PostmanV3KeyValue[];
}
export interface PostmanV3SubscriptionOptions {
  /**
   * Whether the broker withholds messages this client published.
   */
  noLocal?: boolean;
  /**
   * Whether forwarded messages keep the retain flag they were published with.
   */
  retainAsPublished?: boolean;
  /**
   * When the broker sends retained messages for the subscription.
   */
  retainHandling?: 0 | 1 | 2;
  /**
   * Identifier the broker echoes on messages matching the subscription.
   */
  subscriptionIdentifier?: number;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-last-will".
 */
export interface PostmanV3MQTTLastWill {
  /**
   * Payload of the will message.
   */
  payload?: string;
  /**
   * Topic the will message is published to.
   */
  topic?: string;
  /**
   * Delivery guarantee for the will message.
   */
  qos?: 0 | 1 | 2;
  /**
   * Whether the broker retains the will message for later subscribers.
   */
  retain?: boolean;
  /**
   * How the payload is encoded.
   */
  type?: "text" | "json" | "hex" | "base64";
  /**
   * MQTT 5 properties sent with the will message.
   */
  properties?: PostmanV3MQTTLastWillProperties;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-last-will-properties".
 */
export interface PostmanV3MQTTLastWillProperties {
  /**
   * Whether the payload is UTF-8 text rather than bytes.
   */
  payloadFormatIndicator?: boolean;
  /**
   * How long the broker keeps the message, in seconds.
   */
  messageExpiryInterval?: number;
  /**
   * How long the broker waits before publishing the will, in seconds.
   */
  willDelayInterval?: number;
  /**
   * Topic a reply to the message is sent to.
   */
  responseTopic?: string;
  /**
   * Opaque value that ties a reply back to this message.
   */
  correlationData?: string;
  /**
   * MIME type of the payload.
   */
  contentType?: string;
  /**
   * Custom key-value properties sent with the message.
   */
  userProperties?: PostmanV3KeyValue[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-connection-properties".
 */
export interface PostmanV3MQTTConnectionProperties {
  /**
   * How long the broker keeps session state after disconnect, in seconds.
   */
  sessionExpiryInterval?: number;
  /**
   * How many unacknowledged messages the client accepts at once.
   */
  receiveMaximum?: number;
  /**
   * Largest packet the client accepts, in bytes.
   */
  maximumPacketSize?: number;
  /**
   * Whether the client asks the broker for response topic information.
   */
  requestResponseInformation?: boolean;
  /**
   * Custom key-value properties sent with the connect packet.
   */
  userProperties?: PostmanV3DescriptiveKeyValue[];
}
export interface PostmanV3NoAuth10 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet10 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "inherit" | "basic";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-message".
 */
export interface PostmanV3MQTTMessage {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the message.
   */
  name: string;
  /**
   * Human-readable note about the message.
   */
  description?: string;
  $kind: "mqtt-message";
  /**
   * Payload of the message.
   */
  content: string;
  /**
   * Topic the message is published to.
   */
  topic: string;
  /**
   * Delivery guarantee for the message.
   */
  qos?: 0 | 1 | 2;
  /**
   * Whether the broker retains the message for later subscribers.
   */
  retain?: boolean;
  /**
   * How the payload is encoded.
   */
  contentType: "text" | "json" | "hex" | "base64";
  /**
   * MQTT 5 properties sent with the message.
   */
  properties?: PostmanV3MQTTMessageProperties;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-message-properties".
 */
export interface PostmanV3MQTTMessageProperties {
  /**
   * Whether the payload is UTF-8 text rather than bytes.
   */
  payloadFormatIndicator?: boolean;
  /**
   * How long the broker keeps the message, in seconds.
   */
  messageExpiryInterval?: number;
  /**
   * Short alias standing in for the topic name.
   */
  topicAlias?: number;
  /**
   * Topic a reply to the message is sent to.
   */
  responseTopic?: string;
  /**
   * Opaque value that ties a reply back to this message.
   */
  correlationData?: string;
  /**
   * Identifier of the subscription the message arrived on.
   */
  subscriptionIdentifier?: number;
  /**
   * MIME type of the payload.
   */
  contentType?: string;
  /**
   * Custom key-value properties sent with the message.
   */
  userProperties?: PostmanV3KeyValue[];
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-mqtt-example".
 */
export interface PostmanV3MQTTExample {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3MQTTAuth;
  $kind: "mqtt-example";
  /**
   * Request the example was captured from.
   */
  request?: {
    /**
     * URL of the MQTT broker.
     */
    url?: string;
    /**
     * Client identifier sent to the broker.
     */
    clientId?: string;
    /**
     * MQTT protocol version, 4 for 3.1.1 or 5 for 5.0.
     */
    version?: 4 | 5;
    /**
     * Topics the client subscribes to.
     */
    topics?: PostmanV3MQTTTopic[];
    /**
     * Message the broker publishes if the client disconnects unexpectedly.
     */
    lastWill?: PostmanV3MQTTLastWill;
    /**
     * MQTT 5 properties sent with the connect packet.
     */
    properties?: PostmanV3MQTTConnectionProperties;
  };
  /**
   * Session captured for the example.
   */
  response: {
    /**
     * Events recorded during the session, in order.
     */
    events?: (PostmanV3MessageEvent2 | PostmanV3ErrorEvent | PostmanV3NoticeEvent2)[];
  };
}
export interface PostmanV3MessageEvent2 {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Direction the message traveled.
   */
  type: "incoming" | "outgoing";
  /**
   * Payload of the message.
   */
  content?: string;
  /**
   * Topic the message was published to.
   */
  topic?: string;
  /**
   * Delivery guarantee the message was sent with.
   */
  qos?: 0 | 1 | 2;
  /**
   * Whether the broker retained the message.
   */
  retain?: boolean;
  /**
   * How the payload is encoded.
   */
  contentType?: "text" | "json" | "binary";
  /**
   * MQTT 5 properties sent with the message.
   */
  properties?: PostmanV3MQTTMessageProperties;
}
export interface PostmanV3ErrorEvent {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Kind of event.
   */
  type: "error";
  /**
   * Text of the error.
   */
  content?: string;
  /**
   * Error code the broker returned.
   */
  code?: string;
}
export interface PostmanV3NoticeEvent2 {
  /**
   * Identifier of the event.
   */
  id: string;
  /**
   * Outcome the event records.
   */
  type: "info" | "success";
  /**
   * Text of the notice.
   */
  content?: string;
  /**
   * Whether Postman raised the event rather than the broker.
   */
  system?: boolean;
}
export interface PostmanV3KafkaProducerRequest {
  $kind: "kafka-request";
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Bootstrap servers the client connects to.
   */
  url?: string[];
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3KafkaAuth;
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * Whether the connection uses TLS.
     */
    secureConnection?: boolean;
    /**
     * Whether the broker certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * Codec applied to produced records.
     */
    compression?: "none" | "gzip" | "snappy" | "lz4" | "zstd";
  };
  /**
   * Schema used for every topic, from an API specification or a schema registry. A topic-level `schema` overrides it.
   */
  schema?: PostmanV3KafkaSchemaSource;
  /**
   * Saved messages for the request.
   */
  messages?: PostmanV3KafkaMessage[];
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3KafkaScripts;
  /**
   * Whether the request produces or consumes records.
   */
  mode: "producer";
  /**
   * How many brokers acknowledge a send. Maps to the Kafka levels 0, 1, and -1.
   */
  acknowledgements?: "none" | "leader" | "all";
}
export interface PostmanV3NoAuth11 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet11 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "inherit" | "sasl" | "awsv4" | "oauth2" | "bearer";
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-message".
 */
export interface PostmanV3KafkaMessage {
  $kind: "kafka-message";
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the message.
   */
  name: string;
  /**
   * Topic the message is sent to.
   */
  topic: string;
  /**
   * Schema for this message's topic, overriding the request-level one.
   */
  schema?: PostmanV3KafkaMessageSchemaSource;
  /**
   * Key the message is partitioned by. Omitted, partitioning is left to the producer.
   */
  key?: PostmanV3KafkaContent;
  /**
   * Body of the message. Omitted, the message is a tombstone, which differs from an empty `content`.
   */
  value?: PostmanV3KafkaContent;
  /**
   * Headers sent with the message.
   */
  headers?: PostmanV3DescriptiveKeyValue[];
  /**
   * Partition to send to, bypassing the producer's partitioner.
   */
  partition?: number;
  /**
   * Epoch milliseconds stamped on the message, overriding the send-time stamp.
   */
  timestamp?: number;
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-kafka-content".
 */
export interface PostmanV3KafkaContent {
  /**
   * How the payload is encoded.
   */
  contentType: "text" | "json" | "hex" | "base64";
  /**
   * Payload, as text.
   */
  content: string;
}
export interface PostmanV3KafkaConsumerRequest {
  $kind: "kafka-request";
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  /**
   * Bootstrap servers the client connects to.
   */
  url?: string[];
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3KafkaAuth;
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * Whether the connection uses TLS.
     */
    secureConnection?: boolean;
    /**
     * Whether the broker certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * Codec applied to produced records.
     */
    compression?: "none" | "gzip" | "snappy" | "lz4" | "zstd";
  };
  /**
   * Schema used for every topic, from an API specification or a schema registry. A topic-level `schema` overrides it.
   */
  schema?: PostmanV3KafkaSchemaSource;
  /**
   * Saved messages for the request.
   */
  messages?: PostmanV3KafkaMessage[];
  /**
   * Scripts that run on events in the request execution lifecycle.
   */
  scripts?: PostmanV3KafkaScripts;
  /**
   * Whether the request produces or consumes records.
   */
  mode: "consumer";
  /**
   * Topics the request consumes from.
   */
  topics: {
    /**
     * Topic to consume. A leading `^` marks a regex; any other value is a literal name.
     */
    name: string;
    /**
     * Whether the entry is left out of the subscription.
     */
    disabled?: boolean;
    /**
     * Human-readable note about the entry.
     */
    description?: string;
    /**
     * Schema for this topic, overriding the request-level one.
     */
    schema?: PostmanV3KafkaTopicSchemaSource;
    /**
     * Partitions to consume. Omitted, the entry consumes every partition it resolves to.
     *
     * @minItems 1
     */
    partitions?: [number, ...number[]];
    /**
     * Offset the consume starts at, within each partition.
     */
    startOffset?: string;
    /**
     * Offset the consume stops at, within each partition.
     */
    endOffset?: string;
  }[];
  /**
   * Where in the log the consume starts.
   */
  startPosition: PostmanV3FromTheBeginningOfTheLog | PostmanV3FromTheEndOfTheLog | PostmanV3FromATimestamp;
  /**
   * Conditions that end the consume. The first one reached wins.
   */
  stopAfter?: {
    /**
     * How many records to consume before stopping.
     */
    maxRecords?: number;
    /**
     * How long to consume for before stopping, in milliseconds.
     */
    maxDurationMs?: number;
    /**
     * How long to wait without a record before stopping, in milliseconds.
     */
    idleMs?: number;
    endPosition?: PostmanV3UntilATimestamp;
  };
}
export interface PostmanV3FromTheBeginningOfTheLog {
  /**
   * Where in the log the consume starts.
   */
  type: "beginning";
}
export interface PostmanV3FromTheEndOfTheLog {
  /**
   * Where in the log the consume starts.
   */
  type: "end";
}
export interface PostmanV3FromATimestamp {
  /**
   * Where in the log the consume starts.
   */
  type: "timestamp";
  /**
   * Epoch milliseconds the consume starts from.
   */
  timestamp: number;
}
/**
 * Position that ends the consume. The record at the boundary is emitted, then the consume ends.
 */
export interface PostmanV3UntilATimestamp {
  /**
   * What the boundary is measured against.
   */
  type: "timestamp";
  /**
   * Epoch milliseconds the consume stops at.
   */
  timestamp: number;
}
export interface PostmanV3MCPRequestOverSSE {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "mcp-request";
  /**
   * JSON-RPC message sent to the server.
   */
  message?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3MCPAuth;
  /**
   * How the client connects to the server.
   */
  transport: "sse";
  /**
   * URL of the MCP server.
   */
  url?: string;
  /**
   * Headers sent with each request to the server.
   */
  headers?: PostmanV3DescriptiveKeyValue[];
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * MCP protocol version the client speaks.
     */
    version?: "auto" | "legacy" | "2026-07-28";
    /**
     * Whether the server certificate is verified.
     */
    strictSSL?: boolean;
    /**
     * How long to wait for a response, in milliseconds.
     */
    requestTimeout?: number;
    /**
     * How long an idle session is kept open, in milliseconds.
     */
    sessionTimeout?: number;
  };
}
export interface PostmanV3NoAuth12 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet12 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "inherit" | "basic" | "bearer" | "oauth2";
}
export interface PostmanV3MCPRequestOverStdio {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "mcp-request";
  /**
   * JSON-RPC message sent to the server.
   */
  message?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3MCPAuth;
  /**
   * How the client connects to the server.
   */
  transport: "stdio";
  /**
   * Command that starts the MCP server process.
   */
  command?: string;
  /**
   * Environment variables set for the server process.
   */
  env?: PostmanV3DescriptiveKeyValue[];
  /**
   * Transport settings for the connection.
   */
  settings?: {
    /**
     * MCP protocol version the client speaks.
     */
    version?: "auto" | "legacy" | "2026-07-28";
    /**
     * How long to wait for a response, in milliseconds.
     */
    requestTimeout?: number;
  };
}
/**
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "v3-llm-request".
 */
export interface PostmanV3LLMRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "llm-request";
  /**
   * URL of the provider endpoint the request is sent to.
   */
  url?: string;
  /**
   * Model and provider the request targets.
   */
  config?: {
    /**
     * Model the request is sent to.
     */
    model: string;
    /**
     * Provider serving the model.
     */
    provider: string;
  };
  /**
   * Sampling and execution settings for the request.
   */
  settings?: {
    /**
     * How much randomness the model samples with.
     */
    temperature?: number;
    /**
     * How strongly the model is pushed toward new topics.
     */
    presencePenalty?: number;
    /**
     * How strongly the model is pushed away from repeating itself.
     */
    frequencyPenalty?: number;
    /**
     * Largest completion the model returns, in tokens.
     */
    maxToken?: number;
    /**
     * Whether the completion arrives as a stream.
     */
    streamResponse?: boolean;
    /**
     * Whether the model is asked to reply with JSON.
     */
    responseFormatJSON?: boolean;
    /**
     * Cumulative probability the model samples within.
     */
    topP?: number;
    /**
     * How many of the likeliest tokens the model samples from.
     */
    topK?: number;
    /**
     * How strongly repeated tokens are penalized.
     */
    repetitionPenalty?: number;
    /**
     * How much context the request is allowed to use, in tokens.
     */
    contextWindow?: number;
    /**
     * Seed that makes sampling reproducible.
     */
    seed?: number;
    /**
     * How many tool-calling rounds a single run may take.
     */
    maxSteps?: number;
    /**
     * Whether tool calls are streamed as they are produced.
     */
    streamTools?: boolean;
    /**
     * How long a tool call may run, in milliseconds.
     */
    toolTimeoutMs?: number;
  };
  /**
   * Prompts sent as the user turn.
   */
  userPrompts?: {
    /**
     * Identifier of the prompt.
     */
    id?: string;
    /**
     * Text of the prompt.
     */
    value?: string;
    /**
     * Epoch milliseconds the prompt was authored at.
     */
    timestamp?: number;
    /**
     * Whether the prompt is sent with the request.
     */
    active?: boolean;
    /**
     * How the prompt value is encoded.
     */
    contentType?:
      "text" | "image" | "audio" | "video" | "postman_json" | "json" | "xml" | "html" | "binary" | "hexdump";
  }[];
  /**
   * Prompts sent as the system turn.
   */
  systemPrompts?: {
    /**
     * Identifier of the prompt.
     */
    id?: string;
    /**
     * Text of the prompt.
     */
    value?: string;
    /**
     * Epoch milliseconds the prompt was authored at.
     */
    timestamp?: number;
    /**
     * Whether the prompt is sent with the request.
     */
    active?: boolean;
    /**
     * How the prompt value is encoded.
     */
    contentType?:
      "text" | "image" | "audio" | "video" | "postman_json" | "json" | "xml" | "html" | "binary" | "hexdump";
  }[];
  /**
   * MCP server configuration the request draws tools from, as JSON.
   */
  mcpConfig?: string;
  /**
   * Names of the MCP tools the model may call.
   */
  enabledTools?: string[];
  /**
   * Client-side toolsets exposed to the model.
   */
  clientTools?: {
    /**
     * Handle of the toolset.
     */
    id: string;
    /**
     * Tools selected from the toolset.
     */
    tools: {
      /**
       * Handle of the tool within the toolset.
       */
      id: string;
    }[];
  }[];
  /**
   * Credentials applied to the request.
   */
  auth?: PostmanV3LLMAuth;
}
export interface PostmanV3NoAuth13 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet13 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "basic" | "bearer" | "apikey" | "inherit" | "awsv4" | "azure";
}
export interface PostmanV3PostgresDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * Connection string for the data source.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "postgres";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * Largest number of rows returned by a query.
     */
    rowLimit?: number;
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * Whether statements that change data are allowed.
     */
    mutationsEnabled?: boolean;
    /**
     * Schema queries resolve unqualified names against.
     */
    schema?: string;
  };
}
export interface PostmanV3NoAuth14 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Auth scheme to apply.
   */
  type: "noauth";
}
export interface PostmanV3CredentialSet14 {
  /**
   * Identifier of the credential set.
   */
  id?: string;
  /**
   * Display name of the credential set.
   */
  name?: string;
  /**
   * Human-readable note about the credential set.
   */
  description?: string;
  /**
   * Credential fields for the auth type, as key-value pairs.
   */
  credentials: {
    /**
     * Name of the credential field.
     */
    key: string;
    /**
     * Value of the credential field.
     */
    value: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Auth scheme to apply. `inherit` takes the credentials of the nearest ancestor that defines them.
   */
  type: "inherit" | "basic";
}
export interface PostmanV3MySQLDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * Connection string for the data source.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "mysql";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * Largest number of rows returned by a query.
     */
    rowLimit?: number;
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * Whether statements that change data are allowed.
     */
    mutationsEnabled?: boolean;
  };
}
export interface PostmanV3RedisDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * Connection string for the data source.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "redis";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * Whether statements that change data are allowed.
     */
    mutationsEnabled?: boolean;
  };
}
export interface PostmanV3CSVDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * URL of the file.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "csv";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * Largest number of rows returned by a query.
     */
    rowLimit?: number;
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * Character encoding of the file.
     */
    encoding?: string;
    /**
     * Character separating fields in a row.
     */
    delimiter?: string;
    /**
     * Whether the first row holds column names.
     */
    hasHeader?: boolean;
  };
}
export interface PostmanV3JSONDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * URL of the file.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "json";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * Largest number of rows returned by a query.
     */
    rowLimit?: number;
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * JSONPath selecting the array of rows within the file.
     */
    jsonPath?: string;
  };
}
export interface PostmanV3XLSXDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * URL of the file.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets.
   */
  type: "xlsx";
  /**
   * Execution and parse settings for the source.
   */
  settings?: {
    /**
     * Largest number of rows returned by a query.
     */
    rowLimit?: number;
    /**
     * How long a query may run, in milliseconds.
     */
    queryTimeoutMs?: number;
    /**
     * Sheet the rows are read from.
     */
    sheetName?: string;
  };
}
export interface PostmanV3UnconfiguredDataRequest {
  /**
   * Identifier of the item.
   */
  id?: string;
  /**
   * Display name of the item.
   */
  name: string;
  /**
   * Markdown documentation.
   */
  description?: string;
  $kind: "data-request";
  /**
   * Connection string for the data source.
   */
  url?: string;
  /**
   * Statement to run. Left empty, the request introspects the source instead.
   */
  query?: string;
  /**
   * Credentials applied to the connection.
   */
  auth?: PostmanV3DataAuth;
  /**
   * Data source the request targets. Absent until one is picked.
   */
  type?: null;
}

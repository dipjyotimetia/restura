/* biome-ignore-all lint */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: vendor/opencollection/v1.0.0/schema.json
 * Regenerate with: npm run gen:opencollection-types
 */

/**
 * The description
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Description".
 */
export type Description =
  | {
      /**
       * The content of the description
       */
      content: string;
      /**
       * The MIME type of the content
       */
      type: string;
    }
  | string
  | null;
/**
 * A variable value (string or typed object)
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "VariableValue".
 */
export type VariableValue =
  | string
  | {
      /**
       * The type of the value
       */
      type: "string" | "number" | "boolean" | "null" | "object";
      /**
       * The string representation of the value
       */
      data: string;
    };
/**
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ClientCertificate".
 */
export type ClientCertificate = PemCertificate | Pkcs12Certificate;
/**
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ProtoFileItem".
 */
export type ProtoFileItem = ProtoFile;
/**
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Item".
 */
export type Item = OcHttpRequest | GraphQLRequest | OcGrpcRequest | WebSocketRequest | Folder | ScriptFile;
/**
 * Sequence number used to represent the order of the item when rendered in UI
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Sequence".
 */
export type Sequence = number;
/**
 * A tag for categorizing or labeling items
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Tag".
 */
export type Tag = string;
/**
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestBody".
 */
export type HttpRequestBody = RawBody | FormUrlEncodedBody | MultipartFormBody | FileBody;
/**
 * Authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Auth".
 */
export type Auth =
  | AuthAwsV4
  | AuthBasic
  | AuthWsse
  | AuthBearer
  | AuthDigest
  | AuthNTLM
  | AuthApiKey
  | AuthOAuth1
  | AuthOAuth2
  | "inherit";
/**
 * OAuth 2.0 authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthOAuth2".
 */
export type AuthOAuth2 =
  OAuth2ClientCredentialsFlow | OAuth2ResourceOwnerPasswordFlow | OAuth2AuthorizationCodeFlow | OAuth2ImplicitFlow;
/**
 * Where the token is placed in requests
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2TokenPlacement".
 */
export type OAuth2TokenPlacement = OAuth2TokenPlacedInHeader | OAuth2TokenPlacedInQuery;
/**
 * Scripts for collection execution lifecycle
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Scripts".
 */
export type Scripts = Script[];
/**
 * Runtime action
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Action".
 */
export type Action = ActionSetVariable;
/**
 * A gRPC message
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcMessage".
 */
export type GrpcMessage = string;
/**
 * The documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Documentation".
 */
export type Documentation =
  | {
      /**
       * The content of the documentation
       */
      content: string;
      /**
       * The MIME type of the content
       */
      type: string;
    }
  | string
  | null;

export interface HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100 {
  info?: Info;
  /**
   * The version of the opencollection
   */
  opencollection?: string;
  config?: CollectionConfig;
  /**
   * Array of items in the collection
   */
  items?: Item[];
  request?: RequestDefaults;
  docs?: Documentation;
  /**
   * True if the opencollection is a standalone file, false if stored on the filesystem with nested structure of folders and files
   */
  bundled?: boolean;
  extensions?: Extensions;
}
/**
 * Info about the collection
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Info".
 */
export interface Info {
  /**
   * The name of the collection
   */
  name?: string;
  /**
   * A short summary of the collection
   */
  summary?: string;
  /**
   * The version of the collection
   */
  version?: string;
  /**
   * Array of authors of the collection
   */
  authors?: Author[];
}
/**
 * An author of the collection
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Author".
 */
export interface Author {
  /**
   * The name of the author
   */
  name?: string;
  /**
   * The email of the author
   */
  email?: string;
  /**
   * The URL of the author
   */
  url?: string;
}
/**
 * Configuration for the collection
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "CollectionConfig".
 */
export interface CollectionConfig {
  /**
   * Array of environments
   */
  environments?: OcEnvironment[];
  protobuf?: Protobuf;
  proxy?: Proxy;
  /**
   * Array of client certificates for mutual TLS authentication
   */
  clientCertificates?: ClientCertificate[];
}
/**
 * An environment configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OcEnvironment".
 */
export interface OcEnvironment {
  /**
   * The name of the environment
   */
  name: string;
  /**
   * The color of the environment
   */
  color?: string;
  description?: Description;
  /**
   * Array of environment variables
   */
  variables?: (Variable | SecretVariable)[];
  /**
   * Array of client certificates for mutual TLS authentication
   */
  clientCertificates?: ClientCertificate[];
  /**
   * The name of the environment to extend from
   */
  extends?: string;
  /**
   * Path to a .env file to load variables from
   */
  dotEnvFilePath?: string;
}
/**
 * A variable with name, value, description, and state flags
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Variable".
 */
export interface Variable {
  /**
   * The variable name
   */
  name?: string;
  value?: VariableValue | VariableValueVariant[];
  description?: Description;
  /**
   * Whether the variable is disabled
   */
  disabled?: boolean;
}
/**
 * A variant of variable value with title, selected state, and value
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "VariableValueVariant".
 */
export interface VariableValueVariant {
  /**
   * Title of the variant
   */
  title: string;
  /**
   * Whether this variant is selected
   */
  selected?: boolean;
  value: VariableValue;
}
/**
 * A secret variable with name, type, description, and state flags
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "SecretVariable".
 */
export interface SecretVariable {
  /**
   * Indicates this is a secret variable
   */
  secret: true;
  /**
   * The variable name
   */
  name?: string;
  description?: Description;
  /**
   * Whether the variable is disabled
   */
  disabled?: boolean;
  /**
   * The data type of the secret variable
   */
  type?: "string" | "number" | "boolean" | "null" | "object";
}
/**
 * Client certificate using separate PEM-encoded cert and key files
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "PemCertificate".
 */
export interface PemCertificate {
  /**
   * The domain this certificate applies to
   */
  domain: string;
  type: "pem";
  /**
   * Path to the certificate file
   */
  certificateFilePath: string;
  /**
   * Path to the private key file
   */
  privateKeyFilePath: string;
  /**
   * Passphrase for the private key (optional)
   */
  passphrase?: string;
}
/**
 * Client certificate using PKCS#12 format (PFX)
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Pkcs12Certificate".
 */
export interface Pkcs12Certificate {
  /**
   * The domain this certificate applies to
   */
  domain: string;
  type: "pkcs12";
  /**
   * Path to the PKCS#12/PFX file
   */
  pkcs12FilePath: string;
  /**
   * Passphrase for the PKCS#12 file (optional)
   */
  passphrase?: string;
}
/**
 * Protobuf configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Protobuf".
 */
export interface Protobuf {
  /**
   * Array of proto files
   */
  protoFiles?: ProtoFileItem[];
  /**
   * Array of proto file import paths
   */
  importPaths?: ProtoFileImportPath[];
}
/**
 * A proto file reference
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ProtoFile".
 */
export interface ProtoFile {
  type: "file";
  /**
   * Path to the proto file
   */
  path: string;
}
/**
 * A proto file import path
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ProtoFileImportPath".
 */
export interface ProtoFileImportPath {
  /**
   * The import path
   */
  path: string;
  /**
   * Whether the import path is disabled
   */
  disabled?: boolean;
}
/**
 * Proxy configuration for the collection
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Proxy".
 */
export interface Proxy {
  /**
   * Is the proxy disabled
   */
  disabled?: boolean;
  /**
   * Whether to inherit system proxy settings
   */
  inherit?: boolean;
  config?: ProxyConnectionConfig;
}
/**
 * Proxy connection details
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ProxyConnectionConfig".
 */
export interface ProxyConnectionConfig {
  /**
   * Proxy protocol
   */
  protocol?: string;
  /**
   * Proxy hostname
   */
  hostname?: string;
  /**
   * Proxy port
   */
  port?: number;
  /**
   * Proxy authentication
   */
  auth?: {
    /**
     * Is proxy authentication disabled
     */
    disabled?: boolean;
    /**
     * Proxy username
     */
    username?: string;
    /**
     * Proxy password
     */
    password?: string;
  };
  /**
   * Bypass proxy string
   */
  bypassProxy?: string;
}
/**
 * HTTP request configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OcHttpRequest".
 */
export interface OcHttpRequest {
  info?: HttpRequestInfo;
  http?: HttpRequestDetails;
  runtime?: HttpRequestRuntime;
  settings?: HttpRequestSettings;
  /**
   * Array of example HTTP request/response pairs
   */
  examples?: HttpRequestExample[];
  /**
   * Documentation for this request
   */
  docs?: string;
}
/**
 * HTTP request metadata and documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestInfo".
 */
export interface HttpRequestInfo {
  /**
   * The name of the request
   */
  name?: string;
  description?: Description;
  /**
   * The type of request
   */
  type?: "http";
  seq?: Sequence;
  /**
   * Array of tags
   */
  tags?: Tag[];
}
/**
 * HTTP request protocol details
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestDetails".
 */
export interface HttpRequestDetails {
  /**
   * HTTP method
   */
  method?: string;
  /**
   * The URL of the request
   */
  url?: string;
  /**
   * Array of request headers
   */
  headers?: HttpRequestHeader[];
  /**
   * Array of request parameters
   */
  params?: HttpRequestParam[];
  body?: HttpRequestBody | HttpRequestBodyVariant[];
  auth?: Auth;
}
/**
 * Http header with name, value, description, and disabled state
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestHeader".
 */
export interface HttpRequestHeader {
  /**
   * The header name
   */
  name: string;
  /**
   * The header value
   */
  value: string;
  description?: Description;
  /**
   * Whether the header is disabled
   */
  disabled?: boolean;
}
/**
 * A request parameter with name, value, description, type, and disabled state
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestParam".
 */
export interface HttpRequestParam {
  /**
   * The parameter name
   */
  name: string;
  /**
   * The parameter value
   */
  value: string;
  description?: Description;
  /**
   * The type of parameter
   */
  type: "query" | "path";
  /**
   * Whether the parameter is disabled
   */
  disabled?: boolean;
}
/**
 * Raw request body with type and data
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "RawBody".
 */
export interface RawBody {
  /**
   * The type of raw body content
   */
  type: "json" | "text" | "xml" | "sparql";
  /**
   * The raw body data
   */
  data: string;
}
/**
 * Form URL encoded body
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "FormUrlEncodedBody".
 */
export interface FormUrlEncodedBody {
  /**
   * The body type identifier
   */
  type: "form-urlencoded";
  /**
   * Form fields as array of key-value pairs
   */
  data: {
    /**
     * The form field name
     */
    name: string;
    /**
     * The form field value
     */
    value: string;
    description?: Description;
    /**
     * Whether the form field is disabled
     */
    disabled?: boolean;
  }[];
}
/**
 * Multipart form body
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "MultipartFormBody".
 */
export interface MultipartFormBody {
  /**
   * The body type identifier
   */
  type: "multipart-form";
  /**
   * Form parts as array
   */
  data: {
    /**
     * The form part name
     */
    name: string;
    /**
     * The type of form part
     */
    type: "text" | "file";
    /**
     * The form part value
     */
    value: string | string[];
    description?: Description;
    /**
     * The MIME type of the form part
     */
    contentType?: string;
    /**
     * Whether the form part is disabled
     */
    disabled?: boolean;
  }[];
}
/**
 * File body
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "FileBody".
 */
export interface FileBody {
  /**
   * The body type identifier
   */
  type: "file";
  /**
   * Files as array of file objects
   */
  data: FileBodyVariant[];
}
/**
 * A file variant with path, content type, and selection state
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "FileBodyVariant".
 */
export interface FileBodyVariant {
  /**
   * Path to the file
   */
  filePath: string;
  /**
   * MIME type of the file
   */
  contentType: string;
  /**
   * Whether the file is selected
   */
  selected: boolean;
}
/**
 * A variant of HTTP request body with title, selected state, and body
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestBodyVariant".
 */
export interface HttpRequestBodyVariant {
  /**
   * Title of the variant
   */
  title: string;
  /**
   * Whether this variant is selected
   */
  selected?: boolean;
  body: HttpRequestBody;
}
/**
 * AWS V4 authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthAwsV4".
 */
export interface AuthAwsV4 {
  type: "awsv4";
  /**
   * AWS access key ID
   */
  accessKeyId?: string;
  /**
   * AWS secret access key
   */
  secretAccessKey?: string;
  /**
   * AWS session token
   */
  sessionToken?: string;
  /**
   * AWS service name
   */
  service?: string;
  /**
   * AWS region
   */
  region?: string;
  /**
   * AWS profile name
   */
  profileName?: string;
}
/**
 * Basic authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthBasic".
 */
export interface AuthBasic {
  type: "basic";
  /**
   * Username for basic auth
   */
  username?: string;
  /**
   * Password for basic auth
   */
  password?: string;
}
/**
 * WSSE authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthWsse".
 */
export interface AuthWsse {
  type: "wsse";
  /**
   * Username for WSSE auth
   */
  username?: string;
  /**
   * Password for WSSE auth
   */
  password?: string;
}
/**
 * Bearer token authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthBearer".
 */
export interface AuthBearer {
  type: "bearer";
  /**
   * Bearer token
   */
  token?: string;
}
/**
 * Digest authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthDigest".
 */
export interface AuthDigest {
  type: "digest";
  /**
   * Username for digest auth
   */
  username?: string;
  /**
   * Password for digest auth
   */
  password?: string;
}
/**
 * NTLM authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthNTLM".
 */
export interface AuthNTLM {
  type: "ntlm";
  /**
   * Username for NTLM auth
   */
  username?: string;
  /**
   * Password for NTLM auth
   */
  password?: string;
  /**
   * Domain for NTLM auth
   */
  domain?: string;
}
/**
 * API Key authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthApiKey".
 */
export interface AuthApiKey {
  type: "apikey";
  /**
   * API key name
   */
  key?: string;
  /**
   * API key value
   */
  value?: string;
  /**
   * Where to place the API key
   */
  placement?: "header" | "query";
}
/**
 * OAuth 1.0 authentication
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "AuthOAuth1".
 */
export interface AuthOAuth1 {
  type: "oauth1";
  /**
   * Consumer key (API key)
   */
  consumerKey?: string;
  /**
   * Consumer secret (API secret)
   */
  consumerSecret?: string;
  /**
   * Access token key
   */
  accessToken?: string;
  /**
   * Access token secret
   */
  accessTokenSecret?: string;
  /**
   * Callback URL for the Temporary Credentials Request (RFC 5849 §2.1). Use "oob" for out-of-band.
   */
  callbackUrl?: string;
  /**
   * Verification code from the Resource Owner Authorization step (RFC 5849 §2.2). Required in Token Credentials Request (§2.3).
   */
  verifier?: string;
  /**
   * Signature method
   */
  signatureMethod?:
    "HMAC-SHA1" | "HMAC-SHA256" | "HMAC-SHA512" | "RSA-SHA1" | "RSA-SHA256" | "RSA-SHA512" | "PLAINTEXT";
  /**
   * Private key (PEM format, required for RSA-* methods). Use type 'text' for inline key, 'file' for file path.
   */
  privateKey?: {
    type: "file" | "text";
    value: string;
  };
  /**
   * Custom timestamp (auto-generated if not provided)
   */
  timestamp?: string;
  /**
   * Custom nonce (auto-generated if not provided)
   */
  nonce?: string;
  /**
   * OAuth version (defaults to "1.0")
   */
  version?: string;
  /**
   * Authentication realm
   */
  realm?: string;
  /**
   * Where to add OAuth parameters
   */
  placement?: "header" | "query" | "body";
  /**
   * Whether to include a body hash in the signature
   */
  includeBodyHash?: boolean;
}
/**
 * OAuth 2.0 Client Credentials flow
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2ClientCredentialsFlow".
 */
export interface OAuth2ClientCredentialsFlow {
  type: "oauth2";
  flow: "client_credentials";
  /**
   * URL to fetch the access token
   */
  accessTokenUrl?: string;
  /**
   * URL to refresh the token
   */
  refreshTokenUrl?: string;
  credentials?: OAuth2ClientCredentials;
  /**
   * Space-delimited OAuth 2.0 scopes
   */
  scope?: string;
  additionalParameters?: {
    accessTokenRequest?: OAuth2AdditionalParameter[];
    refreshTokenRequest?: OAuth2AdditionalParameter[];
  };
  tokenConfig?: OAuth2TokenConfig;
  settings?: OAuth2Settings;
}
/**
 * OAuth 2.0 client credentials configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2ClientCredentials".
 */
export interface OAuth2ClientCredentials {
  /**
   * OAuth 2.0 client identifier
   */
  clientId?: string;
  /**
   * OAuth 2.0 client secret
   */
  clientSecret?: string;
  /**
   * Where credentials are placed in the request
   */
  placement?: "basic_auth_header" | "body";
}
/**
 * Additional parameter for OAuth 2.0 requests
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2AdditionalParameter".
 */
export interface OAuth2AdditionalParameter {
  /**
   * Parameter name
   */
  name?: string;
  /**
   * Parameter value
   */
  value?: string;
  /**
   * Where to send this parameter
   */
  placement?: "header" | "query" | "body";
}
/**
 * Configuration for how OAuth 2.0 tokens are stored and transported with downstream requests
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2TokenConfig".
 */
export interface OAuth2TokenConfig {
  /**
   * Reference identifier for the token (used to access it via scripting APIs)
   */
  id?: string;
  placement?: OAuth2TokenPlacement;
  /**
   * Which token to use for authorization (defaults to access_token)
   */
  source?: "access_token" | "id_token";
}
/**
 * Token placed in HTTP header
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2TokenPlacedInHeader".
 */
export interface OAuth2TokenPlacedInHeader {
  /**
   * Header name (e.g., 'Authorization')
   */
  header: string;
}
/**
 * Token placed in query parameter
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2TokenPlacedInQuery".
 */
export interface OAuth2TokenPlacedInQuery {
  /**
   * Query parameter name (e.g., 'access_token')
   */
  query: string;
}
/**
 * OAuth 2.0 automation settings
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2Settings".
 */
export interface OAuth2Settings {
  /**
   * Automatically fetch a new token when you try to access the resource and don't have one
   */
  autoFetchToken?: boolean;
  /**
   * Automatically refresh your token using the refreshTokenUrl when it expires
   */
  autoRefreshToken?: boolean;
}
/**
 * OAuth 2.0 Resource Owner Password Credentials flow
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2ResourceOwnerPasswordFlow".
 */
export interface OAuth2ResourceOwnerPasswordFlow {
  type: "oauth2";
  flow: "resource_owner_password_credentials";
  /**
   * URL to fetch the access token
   */
  accessTokenUrl?: string;
  /**
   * URL to refresh the token
   */
  refreshTokenUrl?: string;
  credentials?: OAuth2ClientCredentials;
  resourceOwner?: OAuth2ResourceOwner;
  /**
   * Space-delimited OAuth 2.0 scopes
   */
  scope?: string;
  additionalParameters?: {
    accessTokenRequest?: OAuth2AdditionalParameter[];
    refreshTokenRequest?: OAuth2AdditionalParameter[];
  };
  tokenConfig?: OAuth2TokenConfig;
  settings?: OAuth2Settings;
}
/**
 * Resource owner credentials
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2ResourceOwner".
 */
export interface OAuth2ResourceOwner {
  /**
   * Resource owner username
   */
  username?: string;
  /**
   * Resource owner password
   */
  password?: string;
}
/**
 * OAuth 2.0 Authorization Code flow
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2AuthorizationCodeFlow".
 */
export interface OAuth2AuthorizationCodeFlow {
  type: "oauth2";
  flow: "authorization_code";
  /**
   * URL to authorize the user
   */
  authorizationUrl?: string;
  /**
   * URL to fetch the access token
   */
  accessTokenUrl?: string;
  /**
   * URL to refresh the token
   */
  refreshTokenUrl?: string;
  /**
   * URL to callback to after authorization
   */
  callbackUrl?: string;
  credentials?: OAuth2ClientCredentials;
  /**
   * Space-delimited OAuth 2.0 scopes
   */
  scope?: string;
  /**
   * Opaque value used for CSRF protection
   */
  state?: string;
  pkce?: OAuth2PKCE;
  additionalParameters?: {
    authorizationRequest?: OAuth2AdditionalParameter[];
    accessTokenRequest?: OAuth2AdditionalParameter[];
    refreshTokenRequest?: OAuth2AdditionalParameter[];
  };
  tokenConfig?: OAuth2TokenConfig;
  settings?: OAuth2Settings;
}
/**
 * PKCE (Proof Key for Code Exchange) configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2PKCE".
 */
export interface OAuth2PKCE {
  /**
   * Whether PKCE is disabled
   */
  disabled?: boolean;
  /**
   * Code challenge method
   */
  method?: "S256" | "plain";
}
/**
 * OAuth 2.0 Implicit flow
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OAuth2ImplicitFlow".
 */
export interface OAuth2ImplicitFlow {
  type: "oauth2";
  flow: "implicit";
  /**
   * URL to authorize the user
   */
  authorizationUrl?: string;
  /**
   * URL to callback to after authorization
   */
  callbackUrl?: string;
  /**
   * Client credentials (implicit flow only needs clientId)
   */
  credentials?: {
    /**
     * OAuth 2.0 client identifier
     */
    clientId?: string;
  };
  /**
   * Space-delimited OAuth 2.0 scopes
   */
  scope?: string;
  /**
   * Opaque value used for CSRF protection
   */
  state?: string;
  additionalParameters?: {
    authorizationRequest?: OAuth2AdditionalParameter[];
  };
  tokenConfig?: OAuth2TokenConfig;
  settings?: OAuth2Settings;
}
/**
 * HTTP request runtime configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestRuntime".
 */
export interface HttpRequestRuntime {
  /**
   * Array of variables
   */
  variables?: Variable[];
  scripts?: Scripts;
  /**
   * Array of assertions for response validation
   */
  assertions?: Assertion[];
  /**
   * Array of runtime actions
   */
  actions?: Action[];
}
/**
 * A script to execute at a specific lifecycle stage
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Script".
 */
export interface Script {
  /**
   * The lifecycle stage when this script executes
   */
  type: "before-request" | "after-response" | "tests" | "hooks";
  /**
   * The script code
   */
  code: string;
}
/**
 * An assertion for response validation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Assertion".
 */
export interface Assertion {
  /**
   * The expression to evaluate
   */
  expression: string;
  /**
   * The comparison operator
   */
  operator: string;
  /**
   * The expected value
   */
  value?: string;
  /**
   * Whether the assertion is disabled
   */
  disabled?: boolean;
  description?: Description;
}
/**
 * Set a variable using a selector result
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ActionSetVariable".
 */
export interface ActionSetVariable {
  type: "set-variable";
  description?: Description;
  /**
   * When to execute the action relative to the request
   */
  phase?: "before-request" | "after-response";
  /**
   * Selector used by an action
   */
  selector: {
    /**
     * Selector expression to evaluate
     */
    expression: string;
    /**
     * Selector evaluation method
     */
    method: "jsonq";
  };
  /**
   * Target variable details for an action
   */
  variable: {
    /**
     * Variable name to set
     */
    name: string;
    /**
     * Scope in which to set the variable
     */
    scope: "runtime" | "request" | "folder" | "collection" | "environment";
  };
  /**
   * Whether the action is disabled
   */
  disabled?: boolean;
}
/**
 * Settings for HTTP request execution
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestSettings".
 */
export interface HttpRequestSettings {
  /**
   * Whether to encode the URL
   */
  encodeUrl?: true | false | "inherit";
  /**
   * Request timeout in milliseconds
   */
  timeout?: number | "inherit";
  /**
   * Whether to follow redirects
   */
  followRedirects?: true | false | "inherit";
  /**
   * Maximum number of redirects to follow
   */
  maxRedirects?: number | "inherit";
}
/**
 * An example HTTP request/response pair
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpRequestExample".
 */
export interface HttpRequestExample {
  /**
   * The name of the example
   */
  name?: string;
  description?: Description;
  /**
   * Example request configuration
   */
  request?: {
    /**
     * The URL of the request
     */
    url?: string;
    /**
     * HTTP method
     */
    method?: string;
    /**
     * Array of request headers
     */
    headers?: HttpRequestHeader[];
    /**
     * Array of request parameters
     */
    params?: HttpRequestParam[];
    body?: HttpRequestBody;
  };
  /**
   * Example response
   */
  response?: {
    /**
     * HTTP status code
     */
    status?: number;
    /**
     * HTTP status text
     */
    statusText?: string;
    /**
     * Array of response headers
     */
    headers?: HttpResponseHeader[];
    /**
     * Response body
     */
    body?: {
      /**
       * The type of response body
       */
      type: "json" | "text" | "xml" | "html" | "binary";
      /**
       * The response body data
       */
      data: string;
    };
  };
}
/**
 * Http response header with name and value
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "HttpResponseHeader".
 */
export interface HttpResponseHeader {
  /**
   * The header name
   */
  name: string;
  /**
   * The header value
   */
  value: string;
}
/**
 * GraphQL request configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLRequest".
 */
export interface GraphQLRequest {
  info?: GraphQLRequestInfo;
  graphql?: GraphQLRequestDetails;
  runtime?: GraphQLRequestRuntime;
  settings?: GraphQLRequestSettings;
  /**
   * Documentation for this request
   */
  docs?: string;
}
/**
 * GraphQL request metadata and documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLRequestInfo".
 */
export interface GraphQLRequestInfo {
  /**
   * The name of the request
   */
  name?: string;
  description?: Description;
  /**
   * The type of request
   */
  type?: "graphql";
  seq?: Sequence;
  /**
   * Array of tags
   */
  tags?: Tag[];
}
/**
 * GraphQL request protocol details
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLRequestDetails".
 */
export interface GraphQLRequestDetails {
  /**
   * HTTP method
   */
  method?: string;
  /**
   * The URL of the request
   */
  url?: string;
  /**
   * Array of request headers
   */
  headers?: HttpRequestHeader[];
  /**
   * Array of request parameters
   */
  params?: HttpRequestParam[];
  body?: GraphQLBody | GraphQLBodyVariant[];
  auth?: Auth;
}
/**
 * GraphQL request body with query and variables
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLBody".
 */
export interface GraphQLBody {
  /**
   * The GraphQL query or mutation
   */
  query?: string;
  /**
   * JSON string containing GraphQL variables
   */
  variables?: string;
}
/**
 * A variant of GraphQL body with title, selected state, and body
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLBodyVariant".
 */
export interface GraphQLBodyVariant {
  /**
   * Title of the variant
   */
  title: string;
  /**
   * Whether this variant is selected
   */
  selected?: boolean;
  body: GraphQLBody;
}
/**
 * GraphQL request runtime configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLRequestRuntime".
 */
export interface GraphQLRequestRuntime {
  /**
   * Array of variables
   */
  variables?: Variable[];
  scripts?: Scripts;
  /**
   * Array of assertions for response validation
   */
  assertions?: Assertion[];
  /**
   * Array of runtime actions
   */
  actions?: Action[];
}
/**
 * Settings for GraphQL request execution
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GraphQLRequestSettings".
 */
export interface GraphQLRequestSettings {
  /**
   * Whether to encode the URL
   */
  encodeUrl?: true | false | "inherit";
  /**
   * Request timeout in milliseconds
   */
  timeout?: number | "inherit";
  /**
   * Whether to follow redirects
   */
  followRedirects?: true | false | "inherit";
  /**
   * Maximum number of redirects to follow
   */
  maxRedirects?: number | "inherit";
}
/**
 * gRPC request configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OcGrpcRequest".
 */
export interface OcGrpcRequest {
  info?: GrpcRequestInfo;
  grpc?: GrpcRequestDetails;
  runtime?: GrpcRequestRuntime;
  /**
   * Documentation for this request
   */
  docs?: string;
}
/**
 * gRPC request metadata and documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcRequestInfo".
 */
export interface GrpcRequestInfo {
  /**
   * The name of the request
   */
  name?: string;
  description?: Description;
  /**
   * The type of request
   */
  type?: "grpc";
  seq?: Sequence;
  /**
   * Array of tags
   */
  tags?: Tag[];
}
/**
 * gRPC request protocol details
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcRequestDetails".
 */
export interface GrpcRequestDetails {
  /**
   * The gRPC service URL or endpoint
   */
  url?: string;
  /**
   * Full RPC method name (package.Service/Method)
   */
  method?: string;
  /**
   * Method streaming type
   */
  methodType?: "unary" | "client-streaming" | "server-streaming" | "bidi-streaming";
  /**
   * Path to the proto file
   */
  protoFilePath?: string;
  /**
   * Array of gRPC metadata
   */
  metadata?: GrpcMetadata[];
  message?: GrpcMessage | GrpcMessageVariant[];
  auth?: Auth;
}
/**
 * A gRPC metadata entry with name, value, description, and disabled state
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcMetadata".
 */
export interface GrpcMetadata {
  /**
   * The metadata name
   */
  name: string;
  /**
   * The metadata value
   */
  value: string;
  description?: Description;
  /**
   * Whether the metadata is disabled
   */
  disabled?: boolean;
}
/**
 * A variant of gRPC message with title, selected state, and message
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcMessageVariant".
 */
export interface GrpcMessageVariant {
  /**
   * Title of the variant
   */
  title: string;
  /**
   * Whether this variant is selected
   */
  selected?: boolean;
  message: GrpcMessage;
}
/**
 * gRPC request runtime configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcRequestRuntime".
 */
export interface GrpcRequestRuntime {
  /**
   * Array of variables
   */
  variables?: Variable[];
  scripts?: Scripts;
  /**
   * Array of assertions for response validation
   */
  assertions?: Assertion[];
}
/**
 * WebSocket request configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketRequest".
 */
export interface WebSocketRequest {
  info?: WebSocketRequestInfo;
  websocket?: WebSocketRequestDetails;
  runtime?: WebSocketRequestRuntime;
  settings?: WebSocketRequestSettings;
  /**
   * Documentation for this request
   */
  docs?: string;
}
/**
 * WebSocket request metadata and documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketRequestInfo".
 */
export interface WebSocketRequestInfo {
  /**
   * The name of the request
   */
  name?: string;
  description?: Description;
  /**
   * The type of request
   */
  type?: "websocket";
  seq?: Sequence;
  /**
   * Array of tags
   */
  tags?: Tag[];
}
/**
 * WebSocket request protocol details
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketRequestDetails".
 */
export interface WebSocketRequestDetails {
  /**
   * The WebSocket URL
   */
  url?: string;
  /**
   * Array of request headers
   */
  headers?: HttpRequestHeader[];
  message?: OcWebSocketMessage | WebSocketMessageVariant[];
  auth?: Auth;
}
/**
 * A WebSocket message with type and data
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OcWebSocketMessage".
 */
export interface OcWebSocketMessage {
  /**
   * The type of WebSocket message
   */
  type: "text" | "json" | "xml" | "binary";
  /**
   * The message data
   */
  data: string;
}
/**
 * A variant of WebSocket message with title, selected state, and message
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketMessageVariant".
 */
export interface WebSocketMessageVariant {
  /**
   * Title of the variant
   */
  title: string;
  /**
   * Whether this variant is selected
   */
  selected?: boolean;
  message: OcWebSocketMessage;
}
/**
 * WebSocket request runtime configuration
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketRequestRuntime".
 */
export interface WebSocketRequestRuntime {
  /**
   * Array of variables
   */
  variables?: Variable[];
  scripts?: Scripts;
}
/**
 * WebSocket request settings
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "WebSocketRequestSettings".
 */
export interface WebSocketRequestSettings {
  /**
   * Connection timeout in milliseconds
   */
  timeout?: number | "inherit";
  /**
   * Keep-alive interval in milliseconds
   */
  keepAliveInterval?: number | "inherit";
}
/**
 * A folder for organizing collection items
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Folder".
 */
export interface Folder {
  info?: FolderInfo;
  /**
   * Array of items in the folder
   */
  items?: Item[];
  request?: RequestDefaults;
  docs?: Documentation;
}
/**
 * Folder metadata and documentation
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "FolderInfo".
 */
export interface FolderInfo {
  /**
   * The name of the folder
   */
  name?: string;
  description?: Description;
  type?: "folder";
  seq?: Sequence;
  /**
   * Array of tags
   */
  tags?: Tag[];
}
/**
 * Default request configuration for the collection/folder
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "RequestDefaults".
 */
export interface RequestDefaults {
  /**
   * Array of http headers, sent with http, graphql, websocket requests
   */
  headers?: HttpRequestHeader[];
  /**
   * Array of gRPC metadata, sent with grpc requests
   */
  metadata?: GrpcMetadata[];
  auth?: Auth;
  /**
   * Array of variables
   */
  variables?: Variable[];
  scripts?: Scripts;
  settings?: OcRequestSettings;
}
/**
 * Request settings for different request types
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "OcRequestSettings".
 */
export interface OcRequestSettings {
  http?: HttpRequestSettings;
  graphql?: GraphQLRequestSettings;
}
/**
 * Javascript module or shared collection scripts
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "ScriptFile".
 */
export interface ScriptFile {
  type?: "script";
  /**
   * The script
   */
  script?: string;
}
/**
 * Free-form object that allows implementers to extend the spec
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "Extensions".
 */
export interface Extensions {}
/**
 * A gRPC request message with description and data
 *
 * This interface was referenced by `HttpsSchemaOpencollectionComJsonDraft07OpencollectionV100`'s JSON-Schema
 * via the `definition` "GrpcRequestMessage".
 */
export interface GrpcRequestMessage {
  description?: Description;
  /**
   * The message
   */
  message: string;
}

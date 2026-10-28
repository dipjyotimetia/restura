/* biome-ignore-all lint */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: vendor/postman/v2.1.0/schema.json
 * Regenerate with: npm run gen:postman-v21-types
 *
 * Types are STRICT (additionalProperties: false) even though the v2.1 schema is open.
 */

/**
 * A Description can be a raw text, or be an object, which holds the description along with its format.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "description".
 */
export type PostmanV21Description =
  | {
      /**
       * The content of the description goes here, as a raw string.
       */
      content?: string;
      /**
       * Holds the mime type of the raw description content. E.g: 'text/markdown' or 'text/html'.
       * The type is used to correctly render the description when generating documentation, or in the Postman app.
       */
      type?: string;
      /**
       * Description can have versions associated with it, which should be put in this property.
       */
      version?: unknown;
    }
  | string
  | null;
/**
 * Postman allows you to version your collections as they grow, and this field holds the version number. While optional, it is recommended that you use this field to its fullest extent!
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "version".
 */
export type PostmanV21Version =
  | {
      /**
       * Increment this number if you make changes to the collection that changes its behaviour. E.g: Removing or adding new test scripts. (partly or completely).
       */
      major: number;
      /**
       * You should increment this number if you make changes that will not break anything that uses the collection. E.g: removing a folder.
       */
      minor: number;
      /**
       * Ideally, minor changes to a collection should result in the increment of this number.
       */
      patch: number;
      /**
       * A human friendly identifier to make sense of the version numbers. E.g: 'beta-3'
       */
      identifier?: string;
      meta?: unknown;
    }
  | string;
/**
 * Using variables in your Postman requests eliminates the need to duplicate requests, which can save a lot of time. Variables can be defined, and referenced to from any part of a request.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "variable".
 */
export type PostmanV21Variable = PostmanV21Variable1 & {
  /**
   * A variable ID is a unique user-defined value that identifies the variable within a collection. In traditional terms, this would be a variable name.
   */
  id?: string;
  /**
   * A variable key is a human friendly value that identifies the variable within a collection. In traditional terms, this would be a variable name.
   */
  key?: string;
  /**
   * The value that a variable holds in this collection. Ultimately, the variables will be replaced by this value, when say running a set of requests from a collection
   */
  value?: unknown;
  /**
   * A variable may have multiple types. This field specifies the type of the variable.
   */
  type?: "string" | "boolean" | "any" | "number";
  /**
   * Variable name
   */
  name?: string;
  description?: PostmanV21Description;
  /**
   * When set to true, indicates that this variable has been set by Postman
   */
  system?: boolean;
  disabled?: boolean;
};
export type PostmanV21Variable1 = {
  [k: string]: unknown;
};
/**
 * Collection variables allow you to define a set of variables, that are a *part of the collection*, as opposed to environments, which are separate entities.
 * *Note: Collection variables must not contain any sensitive information.*
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "variable-list".
 */
export type PostmanV21VariableList = PostmanV21Variable[];
/**
 * If object, contains the complete broken-down URL for this request. If string, contains the literal request URL.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "url".
 */
export type PostmanV21Url =
  | {
      /**
       * The string representation of the request URL, including the protocol, host, path, hash, query parameter(s) and path variable(s).
       */
      raw?: string;
      /**
       * The protocol associated with the request, E.g: 'http'
       */
      protocol?: string;
      /**
       * The host for the URL, E.g: api.yourdomain.com. Can be stored as a string or as an array of strings.
       */
      host?: string | string[];
      path?:
        | string
        | (
            | string
            | {
                type?: string;
                value?: string;
              }
          )[];
      /**
       * The port number present in this URL. An empty value implies 80/443 depending on whether the protocol field contains http/https.
       */
      port?: string;
      /**
       * An array of QueryParams, which is basically the query string part of the URL, parsed into separate variables
       */
      query?: {
        key?: string | null;
        value?: string | null;
        /**
         * If set to true, the current query parameter will not be sent with the request.
         */
        disabled?: boolean;
        description?: PostmanV21Description;
      }[];
      /**
       * Contains the URL fragment (if any). Usually this is not transmitted over the network, but it could be useful to store this in some cases.
       */
      hash?: string;
      /**
       * Postman supports path variables with the syntax `/path/:variableName/to/somewhere`. These variables are stored in this field.
       */
      variable?: PostmanV21Variable[];
    }
  | string;
/**
 * Postman allows you to configure scripts to run when specific events occur. These scripts are stored here, and can be referenced in the collection by their ID.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "event-list".
 */
export type PostmanV21EventList = PostmanV21Event[];
/**
 * A request represents an HTTP request. If a string, the string is assumed to be the request URL and the method is assumed to be 'GET'.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "request".
 */
export type PostmanV21Request =
  | {
      url?: PostmanV21Url;
      auth?: null | PostmanV21Auth;
      proxy?: PostmanV21ProxyConfig;
      certificate?: PostmanV21Certificate;
      method?:
        | (
            | "GET"
            | "PUT"
            | "POST"
            | "PATCH"
            | "DELETE"
            | "COPY"
            | "HEAD"
            | "OPTIONS"
            | "LINK"
            | "UNLINK"
            | "PURGE"
            | "LOCK"
            | "UNLOCK"
            | "PROPFIND"
            | "VIEW"
          )
        | string;
      description?: PostmanV21Description;
      header?: PostmanV21HeaderList | string;
      body?: {
        /**
         * Postman stores the type of data associated with this request in this field.
         */
        mode?: "raw" | "urlencoded" | "formdata" | "file" | "graphql";
        raw?: string;
        graphql?: {};
        urlencoded?: {
          key: string;
          value?: string;
          disabled?: boolean;
          description?: PostmanV21Description;
        }[];
        formdata?: (
          | {
              key: string;
              value?: string;
              /**
               * When set to true, prevents this form data entity from being sent.
               */
              disabled?: boolean;
              type?: "text";
              /**
               * Override Content-Type header of this form data entity.
               */
              contentType?: string;
              description?: PostmanV21Description;
            }
          | {
              key: string;
              src?: unknown[] | string | null;
              /**
               * When set to true, prevents this form data entity from being sent.
               */
              disabled?: boolean;
              type?: "file";
              /**
               * Override Content-Type header of this form data entity.
               */
              contentType?: string;
              description?: PostmanV21Description;
            }
        )[];
        file?: {
          src?: string | null;
          content?: string;
        };
        /**
         * Additional configurations and options set for various body modes.
         */
        options?: {};
        /**
         * When set to true, prevents request body from being sent.
         */
        disabled?: boolean;
      } | null;
    }
  | string;
/**
 * A representation for a list of headers
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "header-list".
 */
export type PostmanV21HeaderList = PostmanV21Header[];
/**
 * A representation of a list of ssl certificates
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "certificate-list".
 */
export type PostmanV21CertificateList = PostmanV21Certificate[];
/**
 * A representation of a list of cookies
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "cookie-list".
 */
export type PostmanV21CookieList = PostmanV21Cookie[];

export interface PostmanV21Collection {
  info: PostmanV21Info;
  /**
   * Items are the basic unit for a Postman collection. You can think of them as corresponding to a single API endpoint. Each Item has one request and may have multiple API responses associated with it.
   */
  item: (PostmanV21Item | PostmanV21ItemGroup)[];
  event?: PostmanV21EventList;
  variable?: PostmanV21VariableList;
  auth?: null | PostmanV21Auth;
  protocolProfileBehavior?: PostmanV21ProtocolProfileBehavior;
}
/**
 * Detailed description of the info block
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "info".
 */
export interface PostmanV21Info {
  /**
   * A collection's friendly name is defined by this field. You would want to set this field to a value that would allow you to easily identify this collection among a bunch of other collections, as such outlining its usage or content.
   */
  name: string;
  /**
   * Every collection is identified by the unique value of this field. The value of this field is usually easiest to generate using a UID generator function. If you already have a collection, it is recommended that you maintain the same id since changing the id usually implies that is a different collection than it was originally.
   *  *Note: This field exists for compatibility reasons with Collection Format V1.*
   */
  _postman_id?: string;
  description?: PostmanV21Description;
  version?: PostmanV21Version;
  /**
   * This should ideally hold a link to the Postman schema that is used to validate this collection. E.g: https://schema.postman.com/collection/json/v1.0.0/draft-07/docs/index.html
   */
  schema: string;
}
/**
 * Items are entities which contain an actual HTTP request, and sample responses attached to it.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "item".
 */
export interface PostmanV21Item {
  /**
   * A unique ID that is used to identify collections internally
   */
  id?: string;
  /**
   * A human readable identifier for the current item.
   */
  name?: string;
  description?: PostmanV21Description;
  variable?: PostmanV21VariableList;
  event?: PostmanV21EventList;
  request: PostmanV21Request;
  response?: PostmanV21Response[];
  protocolProfileBehavior?: PostmanV21ProtocolProfileBehavior;
}
/**
 * Defines a script associated with an associated event name
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "event".
 */
export interface PostmanV21Event {
  /**
   * A unique identifier for the enclosing event.
   */
  id?: string;
  /**
   * Can be set to `test` or `prerequest` for test scripts or pre-request scripts respectively.
   */
  listen: string;
  script?: PostmanV21Script;
  /**
   * Indicates whether the event is disabled. If absent, the event is assumed to be enabled.
   */
  disabled?: boolean;
}
/**
 * A script is a snippet of Javascript code that can be used to to perform setup or teardown operations on a particular response.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "script".
 */
export interface PostmanV21Script {
  /**
   * A unique, user defined identifier that can  be used to refer to this script from requests.
   */
  id?: string;
  /**
   * Type of the script. E.g: 'text/javascript'
   */
  type?: string;
  exec?: string[] | string;
  src?: PostmanV21Url;
  /**
   * Script name
   */
  name?: string;
}
/**
 * Represents authentication helpers provided by Postman
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "auth".
 */
export interface PostmanV21Auth {
  type:
    "apikey" | "awsv4" | "basic" | "bearer" | "digest" | "edgegrid" | "hawk" | "noauth" | "oauth1" | "oauth2" | "ntlm";
  noauth?: unknown;
  /**
   * The attributes for API Key Authentication.
   */
  apikey?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [AWS Auth](http://docs.aws.amazon.com/AmazonS3/latest/dev/RESTAuthentication.html).
   */
  awsv4?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [Basic Authentication](https://en.wikipedia.org/wiki/Basic_access_authentication).
   */
  basic?: PostmanV21AuthAttribute[];
  /**
   * The helper attributes for [Bearer Token Authentication](https://tools.ietf.org/html/rfc6750)
   */
  bearer?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [Digest Authentication](https://en.wikipedia.org/wiki/Digest_access_authentication).
   */
  digest?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [Akamai EdgeGrid Authentication](https://developer.akamai.com/legacy/introduction/Client_Auth.html).
   */
  edgegrid?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [Hawk Authentication](https://github.com/hueniverse/hawk)
   */
  hawk?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [NTLM Authentication](https://msdn.microsoft.com/en-us/library/cc237488.aspx)
   */
  ntlm?: PostmanV21AuthAttribute[];
  /**
   * The attributes for [OAuth2](https://oauth.net/1/)
   */
  oauth1?: PostmanV21AuthAttribute[];
  /**
   * Helper attributes for [OAuth2](https://oauth.net/2/)
   */
  oauth2?: PostmanV21AuthAttribute[];
}
/**
 * Represents an attribute for any authorization method provided by Postman. For example `username` and `password` are set as auth attributes for Basic Authentication method.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "auth-attribute".
 */
export interface PostmanV21AuthAttribute {
  key: string;
  value?: unknown;
  type?: string;
}
/**
 * Using the Proxy, you can configure your custom proxy into the postman for particular url match
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "proxy-config".
 */
export interface PostmanV21ProxyConfig {
  /**
   * The Url match for which the proxy config is defined
   */
  match?: string;
  /**
   * The proxy server host
   */
  host?: string;
  /**
   * The proxy server port
   */
  port?: number;
  /**
   * The tunneling details for the proxy config
   */
  tunnel?: boolean;
  /**
   * When set to true, ignores this proxy configuration entity
   */
  disabled?: boolean;
}
/**
 * A representation of an ssl certificate
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "certificate".
 */
export interface PostmanV21Certificate {
  /**
   * A name for the certificate for user reference
   */
  name?: string;
  /**
   * A list of Url match pattern strings, to identify Urls this certificate can be used for.
   *
   * Items: An Url match pattern string
   */
  matches?: string[];
  /**
   * An object containing path to file containing private key, on the file system
   */
  key?: {
    /**
     * The path to file containing key for certificate, on the file system
     */
    src?: unknown;
  };
  /**
   * An object containing path to file certificate, on the file system
   */
  cert?: {
    /**
     * The path to file containing key for certificate, on the file system
     */
    src?: unknown;
  };
  /**
   * The passphrase for the certificate
   */
  passphrase?: string;
}
/**
 * Represents a single HTTP Header
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "header".
 */
export interface PostmanV21Header {
  /**
   * This holds the LHS of the HTTP Header, e.g ``Content-Type`` or ``X-Custom-Header``
   */
  key: string;
  /**
   * The value (or the RHS) of the Header is stored in this field.
   */
  value: string;
  /**
   * If set to true, the current header will not be sent with requests.
   */
  disabled?: boolean;
  description?: PostmanV21Description;
}
/**
 * A response represents an HTTP response.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "response".
 */
export interface PostmanV21Response {
  /**
   * A unique, user defined identifier that can  be used to refer to this response from requests.
   */
  id?: string;
  originalRequest?: PostmanV21Request;
  /**
   * The time taken by the request to complete. If a number, the unit is milliseconds. If the response is manually created, this can be set to `null`.
   */
  responseTime?: null | string | number;
  /**
   * Set of timing information related to request and response in milliseconds
   */
  timings?: {} | null;
  header?: (PostmanV21Header | string)[] | (string | null);
  cookie?: PostmanV21Cookie[];
  /**
   * The raw text of the response.
   */
  body?: null | string;
  /**
   * The response status, e.g: '200 OK'
   */
  status?: string;
  /**
   * The numerical response code, example: 200, 201, 404, etc.
   */
  code?: number;
}
/**
 * A Cookie, that follows the [Google Chrome format](https://developer.chrome.com/extensions/cookies)
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "cookie".
 */
export interface PostmanV21Cookie {
  /**
   * The domain for which this cookie is valid.
   */
  domain: string;
  /**
   * When the cookie expires.
   */
  expires?: string | null;
  maxAge?: string;
  /**
   * True if the cookie is a host-only cookie. (i.e. a request's URL domain must exactly match the domain of the cookie).
   */
  hostOnly?: boolean;
  /**
   * Indicates if this cookie is HTTP Only. (if True, the cookie is inaccessible to client-side scripts)
   */
  httpOnly?: boolean;
  /**
   * This is the name of the Cookie.
   */
  name?: string;
  /**
   * The path associated with the Cookie.
   */
  path: string;
  /**
   * Indicates if the 'secure' flag is set on the Cookie, meaning that it is transmitted over secure connections only. (typically HTTPS)
   */
  secure?: boolean;
  /**
   * True if the cookie is a session cookie.
   */
  session?: boolean;
  /**
   * The value of the Cookie.
   */
  value?: string;
  /**
   * Custom attributes for a cookie go here, such as the [Priority Field](https://code.google.com/p/chromium/issues/detail?id=232693)
   */
  extensions?: unknown[];
}
/**
 * Set of configurations used to alter the usual behavior of sending the request
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "protocol-profile-behavior".
 */
export interface PostmanV21ProtocolProfileBehavior {}
/**
 * One of the primary goals of Postman is to organize the development of APIs. To this end, it is necessary to be able to group requests together. This can be achived using 'Folders'. A folder just is an ordered set of requests.
 *
 * This interface was referenced by `Collection`'s JSON-Schema
 * via the `definition` "item-group".
 */
export interface PostmanV21ItemGroup {
  /**
   * A folder's friendly name is defined by this field. You would want to set this field to a value that would allow you to easily identify this folder.
   */
  name?: string;
  description?: PostmanV21Description;
  variable?: PostmanV21VariableList;
  /**
   * Items are entities which contain an actual HTTP request, and sample responses attached to it. Folders may contain many items.
   */
  item: (PostmanV21Item | PostmanV21ItemGroup)[];
  event?: PostmanV21EventList;
  auth?: null | PostmanV21Auth;
  protocolProfileBehavior?: PostmanV21ProtocolProfileBehavior;
}

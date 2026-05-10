import type { AuthConfig, Collection, CollectionItem, FormDataItem, HttpRequest, KeyValue, PostmanCollection } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import type {
  FormParam,
  Header,
  Item,
  ItemGroup,
  QueryParam,
  Request,
  RequestAuth,
  RequestBody,
  Variable,
} from 'postman-collection';

function getDescriptionContent(desc: string | { content?: string } | undefined): string | undefined {
  if (!desc) return undefined;
  if (typeof desc === 'string') return desc;
  return desc.content;
}

export async function importPostmanCollection(postmanData: PostmanCollection): Promise<Collection> {
  const { Collection: PostmanSDKCollection, ItemGroup } = await import('postman-collection');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostmanSDKCollection constructor accepts loose postman data
  const sdkCollection = new PostmanSDKCollection(postmanData as any);

  const variables: KeyValue[] = [];
  if (sdkCollection.variables) {
    sdkCollection.variables.each((variable: Variable) => {
      variables.push({
        id: uuidv4(),
        key: variable.key || '',
        value: variable.value?.toString() || '',
        enabled: !variable.disabled,
        description: getDescriptionContent(variable.description),
      });
    });
  }

  const collection: Collection = {
    id: uuidv4(),
    name: sdkCollection.name || 'Imported Collection',
    description: getDescriptionContent(sdkCollection.description),
    items: [],
    auth: sdkCollection.auth ? convertPostmanSDKAuth(sdkCollection.auth) : undefined,
    variables: variables.length > 0 ? variables : undefined,
  };

  sdkCollection.items.each((item) => {
    const converted = convertPostmanSDKItem(item, collection.auth, ItemGroup);
    if (converted) collection.items.push(converted);
  });

  return collection;
}

type ItemGroupCtor = { isItemGroup(obj: unknown): boolean };

function convertPostmanSDKItem(item: Item | ItemGroup<Item>, parentAuth: AuthConfig | undefined, ItemGroupCtor: ItemGroupCtor): CollectionItem | null {
  if (ItemGroupCtor.isItemGroup(item)) {
    const group = item as ItemGroup<Item>;
    const items: CollectionItem[] = [];
    group.items.each((subItem) => {
      const converted = convertPostmanSDKItem(subItem, parentAuth, ItemGroupCtor);
      if (converted) items.push(converted);
    });
    return { id: uuidv4(), name: group.name || 'Unnamed Folder', type: 'folder', items };
  }

  const requestItem = item as Item;
  const request = requestItem.request;
  if (!request) return null;

  const httpRequest: HttpRequest = {
    id: uuidv4(),
    name: requestItem.name || 'Unnamed Request',
    type: 'http',
    method: (request.method as HttpRequest['method']) || 'GET',
    url: request.url?.toString() || '',
    headers: convertPostmanSDKHeaders(request.headers),
    params: convertPostmanSDKParams(request.url?.query),
    body: convertPostmanSDKBody(request.body),
    auth: request.auth ? convertPostmanSDKAuth(request.auth) : (parentAuth || { type: 'none' }),
    preRequestScript: extractScript(requestItem.events, 'prerequest'),
    testScript: extractScript(requestItem.events, 'test'),
  };

  return { id: uuidv4(), name: requestItem.name || 'Unnamed Request', type: 'request', request: httpRequest };
}

function extractScript(events: Item['events'], listen: string): string | undefined {
  if (!events) return undefined;
  let script: string | undefined;
  events.each((event) => {
    if (event.listen === listen && event.script) {
      const exec = event.script.exec;
      script = Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : undefined;
    }
  });
  return script;
}

function convertPostmanSDKHeaders(headers: Request['headers']): KeyValue[] {
  if (!headers) return [];
  const result: KeyValue[] = [];
  headers.each((header: Header) => {
    result.push({
      id: uuidv4(),
      key: header.key || '',
      value: header.value || '',
      enabled: !header.disabled,
      description: getDescriptionContent(header.description),
    });
  });
  return result;
}

function convertPostmanSDKParams(queryParams: Request['url']['query'] | undefined): KeyValue[] {
  if (!queryParams) return [];
  const result: KeyValue[] = [];
  queryParams.each((param: QueryParam) => {
    result.push({
      id: uuidv4(),
      key: param.key || '',
      value: param.value || '',
      enabled: !param.disabled,
      description: getDescriptionContent(param.description),
    });
  });
  return result;
}

function convertPostmanSDKBody(body: RequestBody | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mode = body.mode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postman-collection body has dynamic options not in types
  const bodyAny = body as any;

  switch (mode) {
    case 'raw': {
      const raw = body.raw || '';
      const language = bodyAny.options?.raw?.language;
      let type: HttpRequest['body']['type'] = 'text';
      if (language === 'json') type = 'json';
      else if (language === 'xml') type = 'xml';
      return { type, raw };
    }

    case 'formdata': {
      const formData: FormDataItem[] = [];
      body.formdata?.each((param: FormParam) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FormParam.type is not in the type definition
        const paramAny = param as any;
        const isFile = paramAny.type === 'file';
        formData.push({
          id: uuidv4(),
          key: param.key || '',
          value: isFile ? (paramAny.src || '') : (param.value || ''),
          enabled: !param.disabled,
          description: getDescriptionContent(param.description),
          type: isFile ? 'file' : 'text',
        });
      });
      return { type: 'form-data', formData };
    }

    case 'urlencoded': {
      const formData: FormDataItem[] = [];
      body.urlencoded?.each((param: QueryParam) => {
        formData.push({
          id: uuidv4(),
          key: param.key || '',
          value: param.value || '',
          enabled: !param.disabled,
          description: getDescriptionContent(param.description),
          type: 'text',
        });
      });
      return { type: 'x-www-form-urlencoded', formData };
    }

    case 'graphql': {
      const graphql = bodyAny.graphql;
      const query = graphql?.query || '';
      const variables = graphql?.variables;
      let raw = query;
      if (variables) {
        try {
          const parsed = typeof variables === 'string' ? JSON.parse(variables) : variables;
          raw = JSON.stringify({ query, variables: parsed }, null, 2);
        } catch {
          raw = JSON.stringify({ query, variables: {} }, null, 2);
        }
      }
      return { type: 'graphql', raw };
    }

    case 'file':
      return { type: 'binary' };

    default:
      return { type: 'none' };
  }
}

function convertPostmanSDKAuth(auth: RequestAuth): AuthConfig {
  const type = auth.type;
  const getParam = (key: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RequestAuth.parameters() is not typed
    const params = (auth as any).parameters?.() || [];
    const param = params.find((p: Variable) => p.key === key);
    return param?.value?.toString() || '';
  };
  const getParamOpt = (key: string): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RequestAuth.parameters() is not typed
    const params = (auth as any).parameters?.() || [];
    const param = params.find((p: Variable) => p.key === key);
    if (!param) return undefined;
    const v = param.value?.toString();
    return v && v.length > 0 ? v : undefined;
  };

  switch (type) {
    case 'basic':
      return { type: 'basic', basic: { username: getParam('username'), password: getParam('password') } };
    case 'bearer':
      return { type: 'bearer', bearer: { token: getParam('token') } };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: { key: getParam('key'), value: getParam('value'), in: getParam('in') === 'query' ? 'query' : 'header' },
      };
    case 'oauth2': {
      // Postman exposes oauth2 with many flow fields. Pull every field we model
      // and strip undefined values so Restura's runtime sees only what was set.
      const oauth2: NonNullable<AuthConfig['oauth2']> = {
        accessToken: getParam('accessToken'),
        tokenType: getParamOpt('tokenType'),
        grantType: mapPostmanGrantType(getParamOpt('grant_type')),
        clientId: getParamOpt('clientId'),
        clientSecret: getParamOpt('clientSecret'),
        authorizationUrl: getParamOpt('authUrl'),
        tokenUrl: getParamOpt('accessTokenUrl'),
        scope: getParamOpt('scope'),
        redirectUri: getParamOpt('redirect_uri'),
        username: getParamOpt('username'),
        password: getParamOpt('password'),
      };
      // Strip undefined keys so consumers don't see explicit `undefined`s.
      for (const k of Object.keys(oauth2) as Array<keyof typeof oauth2>) {
        if (oauth2[k] === undefined) delete oauth2[k];
      }
      return { type: 'oauth2', oauth2 };
    }
    case 'digest':
      return { type: 'digest', digest: { username: getParam('username'), password: getParam('password') } };
    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: getParam('accessKey'),
          secretKey: getParam('secretKey'),
          region: getParam('region'),
          service: getParam('service'),
        },
      };
    case 'noauth':
    default:
      return { type: 'none' };
  }
}

/**
 * Map a Postman `grant_type` value to our internal AuthConfig.oauth2.grantType.
 * Postman's PKCE variant collapses to plain authorization_code on our side
 * (PKCE params live in the redirect/scope flow regardless). Implicit isn't
 * modeled — return undefined and let the runtime fall back to the default.
 */
function mapPostmanGrantType(p: string | undefined): NonNullable<AuthConfig['oauth2']>['grantType'] {
  switch (p) {
    case 'authorization_code':
    case 'authorization_code_with_pkce':
      return 'authorization_code';
    case 'client_credentials':
      return 'client_credentials';
    case 'password_credentials':
      return 'password';
    case 'implicit':
    default:
      return undefined;
  }
}

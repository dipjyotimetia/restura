import type { HttpRequestConfig, HttpResponse } from './http-handler';

type RequestInterceptor = (config: HttpRequestConfig) => HttpRequestConfig | Promise<HttpRequestConfig>;
type ResponseInterceptor = (response: HttpResponse, config: HttpRequestConfig) => HttpResponse | Promise<HttpResponse>;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];

export const interceptorRegistry = {
  addRequestInterceptor: (fn: RequestInterceptor): void => {
    requestInterceptors.push(fn);
  },

  addResponseInterceptor: (fn: ResponseInterceptor): void => {
    responseInterceptors.push(fn);
  },

  runRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => {
    let current = config;
    for (const interceptor of requestInterceptors) {
      current = await interceptor(current);
    }
    return current;
  },

  runResponse: async (response: HttpResponse, config: HttpRequestConfig): Promise<HttpResponse> => {
    let current = response;
    for (const interceptor of responseInterceptors) {
      current = await interceptor(current, config);
    }
    return current;
  },

  clearInterceptors: (): void => {
    requestInterceptors.length = 0;
    responseInterceptors.length = 0;
  },
};

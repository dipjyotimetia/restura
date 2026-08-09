import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { PmSendRequestInput } from './script-executor-types';

/** Normalize the two `pm.sendRequest` input forms accepted by Postman. */
export function normalizeSendRequestInput(input: unknown): PmSendRequestInput {
  if (typeof input === 'string') return { url: input, method: 'GET' };
  if (input && typeof input === 'object') {
    const request = input as Record<string, unknown>;
    const headers =
      request.header && typeof request.header === 'object'
        ? (request.header as Record<string, string>)
        : request.headers && typeof request.headers === 'object'
          ? (request.headers as Record<string, string>)
          : {};
    return {
      url: typeof request.url === 'string' ? request.url : '',
      method: typeof request.method === 'string' ? request.method : 'GET',
      headers,
      body: request.body,
    };
  }
  return { url: '', method: 'GET' };
}

/** Convert a native value into an owned QuickJS handle. */
export function makeJSValue(vm: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return vm.undefined;
  if (value === null) return vm.null;
  if (typeof value === 'boolean') return value ? vm.true : vm.false;
  if (typeof value === 'number') return vm.newNumber(value);
  if (typeof value === 'string') return vm.newString(value);
  if (Array.isArray(value)) {
    const array = vm.newArray();
    value.forEach((item, index) => {
      const handle = makeJSValue(vm, item);
      vm.setProp(array, index, handle);
      handle.dispose();
    });
    return array;
  }
  if (typeof value === 'object') {
    const object = vm.newObject();
    for (const [key, item] of Object.entries(value)) {
      const handle = makeJSValue(vm, item);
      vm.setProp(object, key, handle);
      handle.dispose();
    }
    return object;
  }
  return vm.undefined;
}

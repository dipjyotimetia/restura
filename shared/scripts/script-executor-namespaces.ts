import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { PmCookieAdapter, PmCookieRecord } from './script-executor-types';
import { makeJSValue } from './script-executor-values';

/** Bind a live string map to the Postman-compatible key-value namespace. */
export function buildKvNamespace(
  vm: QuickJSContext,
  store: Record<string, string>,
  mutations?: Record<string, string | null>
): QuickJSHandle {
  const namespace = vm.newObject();
  const get = vm.newFunction('get', (keyHandle) => {
    const value = store[vm.getString(keyHandle)];
    return value !== undefined ? vm.newString(value) : vm.undefined;
  });
  const set = vm.newFunction('set', (keyHandle, valueHandle) => {
    const key = vm.getString(keyHandle);
    const value = vm.getString(valueHandle);
    store[key] = value;
    if (mutations) mutations[key] = value;
  });
  const unset = vm.newFunction('unset', (keyHandle) => {
    const key = vm.getString(keyHandle);
    delete store[key];
    if (mutations) mutations[key] = null;
  });
  const has = vm.newFunction('has', (keyHandle) =>
    store[vm.getString(keyHandle)] !== undefined ? vm.true : vm.false
  );
  vm.setProp(namespace, 'get', get);
  vm.setProp(namespace, 'set', set);
  vm.setProp(namespace, 'unset', unset);
  vm.setProp(namespace, 'has', has);
  get.dispose();
  set.dispose();
  unset.dispose();
  has.dispose();
  return namespace;
}

/** Bind `pm.cookies`, resolving the URL-scoped adapter when a method runs. */
export function bindPmCookies(
  vm: QuickJSContext,
  pmObject: QuickJSHandle,
  getAdapter: () => PmCookieAdapter | undefined
): void {
  const namespace = vm.newObject();
  const cookiesArrayHandle = (records: PmCookieRecord[]): QuickJSHandle => makeJSValue(vm, records);
  const get = vm.newFunction('get', (nameHandle) => {
    const adapter = getAdapter();
    if (!adapter) return vm.undefined;
    const hit = adapter.forCurrentUrl().find((cookie) => cookie.name === vm.getString(nameHandle));
    return hit ? vm.newString(hit.value) : vm.undefined;
  });
  const has = vm.newFunction('has', (nameHandle) => {
    const adapter = getAdapter();
    if (!adapter) return vm.false;
    return adapter.forCurrentUrl().some((cookie) => cookie.name === vm.getString(nameHandle))
      ? vm.true
      : vm.false;
  });
  const toJSON = vm.newFunction('toJSON', () => {
    const adapter = getAdapter();
    return adapter ? cookiesArrayHandle(adapter.forCurrentUrl()) : vm.newArray();
  });
  const jar = vm.newFunction('jar', () => {
    const jarObject = vm.newObject();
    const jarGet = vm.newFunction('get', (urlHandle, nameHandle) => {
      const adapter = getAdapter();
      if (!adapter) return vm.undefined;
      const hit = adapter
        .getForUrl(vm.getString(urlHandle))
        .find((cookie) => cookie.name === vm.getString(nameHandle));
      return hit ? vm.newString(hit.value) : vm.undefined;
    });
    const jarGetAll = vm.newFunction('getAll', (urlHandle) => {
      const adapter = getAdapter();
      return adapter
        ? cookiesArrayHandle(adapter.getForUrl(vm.getString(urlHandle)))
        : vm.newArray();
    });
    const jarSet = vm.newFunction('set', (urlHandle, nameHandle, valueHandle) => {
      getAdapter()?.add(vm.getString(urlHandle), {
        name: vm.getString(nameHandle),
        value: vm.getString(valueHandle),
      });
      return vm.undefined;
    });
    const jarUnset = vm.newFunction('unset', (urlHandle, nameHandle) => {
      getAdapter()?.unset(vm.getString(urlHandle), vm.getString(nameHandle));
      return vm.undefined;
    });
    const jarClear = vm.newFunction('clear', (urlHandle) => {
      getAdapter()?.clear(vm.getString(urlHandle));
      return vm.undefined;
    });
    vm.setProp(jarObject, 'get', jarGet);
    vm.setProp(jarObject, 'getAll', jarGetAll);
    vm.setProp(jarObject, 'set', jarSet);
    vm.setProp(jarObject, 'unset', jarUnset);
    vm.setProp(jarObject, 'clear', jarClear);
    jarGet.dispose();
    jarGetAll.dispose();
    jarSet.dispose();
    jarUnset.dispose();
    jarClear.dispose();
    return jarObject;
  });
  vm.setProp(namespace, 'get', get);
  vm.setProp(namespace, 'has', has);
  vm.setProp(namespace, 'toJSON', toJSON);
  vm.setProp(namespace, 'jar', jar);
  get.dispose();
  has.dispose();
  toJSON.dispose();
  jar.dispose();
  vm.setProp(pmObject, 'cookies', namespace);
  namespace.dispose();
}

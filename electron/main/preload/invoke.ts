import { ipcRenderer } from 'electron';

export function invoke<TMethod>(channel: string): TMethod {
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as unknown as TMethod;
}

export function send<TMethod>(channel: string): TMethod {
  return ((...args: unknown[]) => ipcRenderer.send(channel, ...args)) as unknown as TMethod;
}

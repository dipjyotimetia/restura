/**
 * MCP roots (spec 2025-06-18 "Client → Roots") MUST be `file://` URIs. Restura
 * only accepts local paths: an empty or `localhost` host and no userinfo, so a
 * root can't point at a UNC/remote share or carry credentials. Shared by the
 * renderer editor and the Electron IPC validator.
 */
export function isLocalFileRootUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'file:' &&
      (url.hostname === '' || url.hostname === 'localhost') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

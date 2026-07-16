/** Browser XML validation adapter; DOMParser is not available in backend runtimes. */
export function validateXML(value: string): boolean {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(value, 'text/xml');
    return !doc.querySelector('parsererror');
  } catch {
    return false;
  }
}

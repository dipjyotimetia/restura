import { escapeJson, type GenerateOptions } from './types';

/** Go interpreted string literal; JSON escapes are all valid Go escapes. */
const goString = (str: string): string => `"${escapeJson(str)}"`;

export const generateGo = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;
  const hasParams = Object.keys(resolvedParams).length > 0;
  const hasBody = request.body.type !== 'none' && Boolean(request.body.raw);

  // Go rejects unused imports, so only what the program uses.
  const imports = ['"fmt"', '"io"', '"net/http"'];
  if (hasParams) imports.push('"net/url"');
  if (hasBody) imports.push('"strings"');
  imports.sort();

  let go = `package main\n\n`;
  go += `import (\n${imports.map((i) => `\t${i}\n`).join('')})\n\n`;
  go += `func main() {\n`;
  go += `\tbaseURL := ${goString(resolvedUrl)}\n`;

  if (hasParams) {
    go += `\tparams := url.Values{}\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      go += `\tparams.Add(${goString(key)}, ${goString(value)})\n`;
    });
    go += `\tfullURL := baseURL + "?" + params.Encode()\n\n`;
  } else {
    go += `\tfullURL := baseURL\n\n`;
  }

  if (hasBody) {
    // A quoted literal, not a raw `…` string: the body may contain backticks.
    go += `\tpayload := strings.NewReader(${goString(request.body.raw ?? '')})\n`;
    go += `\treq, err := http.NewRequest(${goString(request.method)}, fullURL, payload)\n`;
  } else {
    go += `\treq, err := http.NewRequest(${goString(request.method)}, fullURL, nil)\n`;
  }

  go += `\tif err != nil {\n\t\tpanic(err)\n\t}\n\n`;

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    go += `\treq.Header.Set(${goString(key)}, ${goString(value)})\n`;
  });

  go += `\n\tclient := &http.Client{}\n`;
  go += `\tresp, err := client.Do(req)\n`;
  go += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
  go += `\tdefer resp.Body.Close()\n\n`;
  go += `\tfmt.Println("Status:", resp.Status)\n`;
  go += `\trespBody, err := io.ReadAll(resp.Body)\n`;
  go += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
  go += `\tfmt.Println("Response:", string(respBody))\n`;
  go += `}`;

  return go;
};

import { escapeJson, type GenerateOptions } from './types';

export const generateGo = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let go = `package main\n\n`;
  go += `import (\n\t"bytes"\n\t"fmt"\n\t"io"\n\t"net/http"\n\t"net/url"\n)\n\n`;
  go += `func main() {\n`;
  go += `\tbaseURL := "${escapeJson(resolvedUrl)}"\n`;

  if (Object.keys(resolvedParams).length > 0) {
    go += `\tparams := url.Values{}\n`;
    Object.entries(resolvedParams).forEach(([key, value]) => {
      go += `\tparams.Add("${escapeJson(key)}", "${escapeJson(value)}")\n`;
    });
    go += `\tfullURL := baseURL + "?" + params.Encode()\n\n`;
  } else {
    go += `\tfullURL := baseURL\n\n`;
  }

  if (request.body.type !== 'none' && request.body.raw) {
    go += `\tbody := []byte(\`${request.body.raw}\`)\n`;
    go += `\treq, err := http.NewRequest("${request.method}", fullURL, bytes.NewBuffer(body))\n`;
  } else {
    go += `\treq, err := http.NewRequest("${request.method}", fullURL, nil)\n`;
  }

  go += `\tif err != nil {\n\t\tpanic(err)\n\t}\n\n`;

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    go += `\treq.Header.Set("${escapeJson(key)}", "${escapeJson(value)}")\n`;
  });

  go += `\n\tclient := &http.Client{}\n`;
  go += `\tresp, err := client.Do(req)\n`;
  go += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
  go += `\tdefer resp.Body.Close()\n\n`;
  go += `\tfmt.Println("Status:", resp.Status)\n`;
  go += `\tbody, _ := io.ReadAll(resp.Body)\n`;
  go += `\tfmt.Println("Response:", string(body))\n`;
  go += `}`;

  return go;
};

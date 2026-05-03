import { escapeJson } from './types';

export interface GraphQLGenerateOptions {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  operationType?: 'query' | 'mutation' | 'subscription';
}

export const generateGraphQLCurl = (options: GraphQLGenerateOptions): string => {
  const { url, query, variables, headers } = options;

  const body = JSON.stringify({ query, variables: variables ?? {} });
  const escapedBody = body.replace(/'/g, "'\\''");

  let cmd = `curl -X POST '${url}' \\\n`;
  cmd += `  -H 'Content-Type: application/json'`;

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      cmd += ` \\\n  -H '${key}: ${value}'`;
    }
  }

  cmd += ` \\\n  -d '${escapedBody}'`;
  return cmd;
};

export const generateGraphQLJavaScript = (options: GraphQLGenerateOptions): string => {
  const { url, query, variables, headers } = options;

  const allHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  let code = `const query = \`\n${query}\n\`;\n\n`;

  if (variables && Object.keys(variables).length > 0) {
    code += `const variables = ${JSON.stringify(variables, null, 2)};\n\n`;
  }

  code += `fetch("${escapeJson(url)}", {\n`;
  code += `  method: "POST",\n`;
  code += `  headers: ${JSON.stringify(allHeaders, null, 2).split('\n').join('\n  ')},\n`;
  code += `  body: JSON.stringify({ query${variables && Object.keys(variables).length > 0 ? ', variables' : ''} }),\n`;
  code += `})\n`;
  code += `  .then(res => res.json())\n`;
  code += `  .then(data => console.log(JSON.stringify(data, null, 2)))\n`;
  code += `  .catch(err => console.error(err));\n`;

  return code;
};

export const generateGraphQLPython = (options: GraphQLGenerateOptions): string => {
  const { url, query, variables, headers } = options;

  let code = `import requests\nimport json\n\n`;
  code += `url = "${escapeJson(url)}"\n\n`;
  code += `query = """\n${query}\n"""\n\n`;

  if (variables && Object.keys(variables).length > 0) {
    code += `variables = ${JSON.stringify(variables, null, 2)}\n\n`;
  }

  code += `headers = {\n`;
  code += `    "Content-Type": "application/json",\n`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      code += `    "${escapeJson(key)}": "${escapeJson(value)}",\n`;
    }
  }
  code += `}\n\n`;

  code += `payload = {"query": query`;
  if (variables && Object.keys(variables).length > 0) {
    code += `, "variables": variables`;
  }
  code += `}\n\n`;

  code += `response = requests.post(url, headers=headers, json=payload)\n`;
  code += `print(json.dumps(response.json(), indent=2))\n`;

  return code;
};

export const graphqlCodeGenerators = {
  curl: { name: 'cURL', generate: generateGraphQLCurl },
  javascript: { name: 'JavaScript (fetch)', generate: generateGraphQLJavaScript },
  python: { name: 'Python (requests)', generate: generateGraphQLPython },
};

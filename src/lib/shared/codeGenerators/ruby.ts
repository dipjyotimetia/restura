import { escapeJson, type GenerateOptions } from './types';

export const generateRuby = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = url.toString();
  } catch {
    // keep urlStr as-is
  }

  let ruby = `require 'net/http'\nrequire 'json'\n\n`;
  ruby += `uri = URI("${escapeJson(urlStr)}")\n\n`;
  ruby += `request = Net::HTTP::${request.method.charAt(0) + request.method.slice(1).toLowerCase()}.new(uri)\n`;

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    ruby += `request["${escapeJson(key)}"] = "${escapeJson(value)}"\n`;
  });

  if (request.body.type !== 'none' && request.body.raw) {
    ruby += `request.body = ${request.body.type === 'json' ? request.body.raw : `"${escapeJson(request.body.raw)}"`}\n`;
  }

  ruby += `\n`;
  ruby += `response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|\n`;
  ruby += `  http.request(request)\n`;
  ruby += `end\n\n`;
  ruby += `puts "Status: #{response.code}"\n`;
  ruby += `puts "Response: #{response.body}"`;

  return ruby;
};

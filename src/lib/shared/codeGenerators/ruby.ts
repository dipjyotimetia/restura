import { isKnownHttpMethod, normalizeHttpMethod } from '@shared/protocol/http-method';
import { escapeJson, type GenerateOptions, singleQuotedLiteral, urlWithVariables } from './types';

export const generateRuby = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    Object.entries(resolvedParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    urlStr = urlWithVariables(url);
  } catch {
    // keep urlStr as-is
  }

  let ruby = `require 'net/http'\nrequire 'json'\n\n`;
  ruby += `uri = URI("${escapeJson(urlStr)}")\n\n`;
  const hasBody = request.body.type !== 'none' && Boolean(request.body.raw);
  const method = normalizeHttpMethod(request.method);
  if (isKnownHttpMethod(method)) {
    ruby += `request = Net::HTTP::${method.charAt(0) + method.slice(1).toLowerCase()}.new(uri)\n`;
  } else {
    // No Net::HTTP class for extension tokens (PURGE, QUERY…) — #857.
    ruby += `request = Net::HTTPGenericRequest.new(${singleQuotedLiteral(method)}, ${hasBody}, true, uri)\n`;
  }

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    ruby += `request["${escapeJson(key)}"] = "${escapeJson(value)}"\n`;
  });

  if (hasBody && request.body.raw) {
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

import { isKnownHttpMethod, normalizeHttpMethod } from '@shared/protocol/http-method';
import { type GenerateOptions, rubyString, singleQuotedLiteral, urlWithParams } from './types';

export const generateRuby = (options: GenerateOptions): string => {
  const { request, resolvedUrl, resolvedHeaders, resolvedParams } = options;

  let urlStr = resolvedUrl || 'https://api.example.com';
  try {
    const url = new URL(urlStr);
    urlStr = urlWithParams(url, resolvedParams);
  } catch {
    // keep urlStr as-is
  }

  let ruby = `require 'net/http'\n\n`;
  ruby += `uri = URI(${rubyString(urlStr)})\n\n`;
  const hasBody = request.body.type !== 'none' && Boolean(request.body.raw);
  const method = normalizeHttpMethod(request.method);
  if (isKnownHttpMethod(method)) {
    ruby += `request = Net::HTTP::${method.charAt(0) + method.slice(1).toLowerCase()}.new(uri)\n`;
  } else {
    // No Net::HTTP class for extension tokens (PURGE, QUERY…) — #857.
    ruby += `request = Net::HTTPGenericRequest.new(${singleQuotedLiteral(method)}, ${hasBody}, true, uri)\n`;
  }

  Object.entries(resolvedHeaders).forEach(([key, value]) => {
    ruby += `request[${rubyString(key)}] = ${rubyString(value)}\n`;
  });

  if (hasBody && request.body.raw) {
    // Net::HTTP sends a String body; JSON goes as its exact text (a Ruby Hash
    // literal would not be a String, and JSON `null` would be a NameError).
    ruby += `request.body = ${rubyString(request.body.raw)}\n`;
  }

  ruby += `\n`;
  ruby += `response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|\n`;
  ruby += `  http.request(request)\n`;
  ruby += `end\n\n`;
  ruby += `puts "Status: #{response.code}"\n`;
  ruby += `puts "Response: #{response.body}"`;

  return ruby;
};

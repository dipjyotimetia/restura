import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import { ensureCerts } from '../../echo-local/certs';
import { test as electronTest } from './electronApp';

export interface GitRemoteFixture {
  workspaceDirectory: string;
  remoteUrl: string;
}

export const test = electronTest.extend<{ gitRemote: GitRemoteFixture }>({
  gitRemote: async ({ electronProfileDirectory }, use) => {
    const root = mkdtempSync(path.join(electronProfileDirectory, 'git-e2e-'));
    const projectRoot = path.join(root, 'projects');
    const bare = path.join(projectRoot, 'workspace.git');
    const workspaceDirectory = path.join(root, 'workspace');
    mkdirSync(projectRoot, { recursive: true });
    git(root, ['init', '--bare', bare]);
    git(root, ['--git-dir', bare, 'config', 'http.receivepack', 'true']);
    git(root, ['init', '-b', 'main', workspaceDirectory]);
    git(workspaceDirectory, ['config', 'user.name', 'Restura E2E']);
    git(workspaceDirectory, ['config', 'user.email', 'e2e@restura.dev']);
    git(workspaceDirectory, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(path.join(workspaceDirectory, 'users'));
    writeFileSync(
      path.join(workspaceDirectory, 'opencollection.yml'),
      ['opencollection: "1.0.0"', 'info:', '  name: "Git E2E"', 'bundled: false', ''].join('\n')
    );
    writeFileSync(
      path.join(workspaceDirectory, 'users', 'get-users.yaml'),
      requestYaml('https://base.example/users')
    );
    git(workspaceDirectory, ['add', '-A']);
    git(workspaceDirectory, ['commit', '-m', 'baseline']);
    git(workspaceDirectory, ['remote', 'add', 'origin', bare]);
    git(workspaceDirectory, ['push', '-u', 'origin', 'main']);
    git(workspaceDirectory, ['checkout', '-b', 'incoming']);
    writeFileSync(
      path.join(workspaceDirectory, 'users', 'get-users.yaml'),
      requestYaml('https://incoming.example/users')
    );
    git(workspaceDirectory, ['add', '-A']);
    git(workspaceDirectory, ['commit', '-m', 'incoming URL']);
    git(workspaceDirectory, ['push', '-u', 'origin', 'incoming']);
    git(workspaceDirectory, ['checkout', 'main']);
    git(workspaceDirectory, ['branch', '-D', 'incoming']);
    writeFileSync(
      path.join(workspaceDirectory, 'users', 'get-users.yaml'),
      requestYaml('https://local.example/users')
    );
    git(workspaceDirectory, ['add', '-A']);
    git(workspaceDirectory, ['commit', '-m', 'local URL']);

    const certs = ensureCerts({ dir: path.join(root, 'certs') });
    const server = createGitHttpsServer(projectRoot, certs.serverKey, certs.serverCert);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Git HTTPS listener unavailable');
    const remoteUrl = `https://localhost:${address.port}/workspace.git`;
    git(workspaceDirectory, ['remote', 'set-url', 'origin', remoteUrl]);

    const gitConfigDirectory = path.join(electronProfileDirectory, 'xdg-config', 'git');
    mkdirSync(gitConfigDirectory, { recursive: true });
    git(root, [
      'config',
      '--file',
      path.join(gitConfigDirectory, 'config'),
      'http.sslCAInfo',
      certs.caCertPath,
    ]);

    try {
      await use({ workspaceDirectory, remoteUrl });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
});

export { expect } from './electronApp';

function createGitHttpsServer(projectRoot: string, key: Buffer, cert: Buffer) {
  return createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://localhost');
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.searchParams.toString(),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: request.headers['content-length'] ?? '0',
          REMOTE_ADDR: request.socket.remoteAddress ?? '127.0.0.1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      child.on('error', (error) => {
        response.writeHead(500).end(error.message);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          response.writeHead(500).end(Buffer.concat(errors));
          return;
        }
        const raw = Buffer.concat(output);
        const headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          response.writeHead(500).end('Malformed git-http-backend response');
          return;
        }
        const headerLines = raw.subarray(0, headerEnd).toString('utf8').split('\r\n');
        let status = 200;
        for (const line of headerLines) {
          const separator = line.indexOf(':');
          if (separator < 0) continue;
          const name = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
          else response.setHeader(name, value);
        }
        response.writeHead(status);
        response.end(raw.subarray(headerEnd + 4));
      });
      child.stdin.end(Buffer.concat(body));
    });
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function requestYaml(url: string): string {
  return [
    'info:',
    '  type: "http"',
    '  name: "Get users"',
    'http:',
    '  method: "GET"',
    `  url: "${url}"`,
    '',
  ].join('\n');
}

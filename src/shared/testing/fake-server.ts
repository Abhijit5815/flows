// Test helper: a local HTTP server that records every request and answers with the handler's reply.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
export type FakeServer = { url: string; requests: FakeRequest[]; close: () => Promise<void> };

export async function startFakeServer(handler: (request: FakeRequest, response: ServerResponse) => void): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(request);
      handler(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function replyJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

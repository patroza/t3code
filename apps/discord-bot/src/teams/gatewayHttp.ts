// @effect-diagnostics nodeBuiltinImport:off globalErrorInErrorChannel:off globalPromise:off
import * as NodeHttp from "node:http";
import type { HttpRouteHandler, IHttpServerAdapter } from "@microsoft/teams.apps";

/** The SDK still owns JWT validation. This adapter exposes only its bounded callback. */
export class LoopbackTeamsAdapter implements IHttpServerAdapter {
  private handler: HttpRouteHandler | undefined;
  private server: NodeHttp.Server | undefined;

  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  registerRoute(method: "POST", path: string, handler: HttpRouteHandler): void {
    if (method !== "POST" || path !== "/api/messages" || this.handler)
      throw new Error("Only one Teams callback may be registered");
    this.handler = handler;
  }

  async start(port: number | string): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error("Teams callback is not registered");
    const server = NodeHttp.createServer(async (request, response) => {
      if (request.url !== "/api/messages") {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      if (!/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")) {
        response.writeHead(415).end();
        return;
      }
      try {
        let size = 0;
        const parts: Buffer[] = [];
        for await (const part of request) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += bytes.length;
          if (size > 262144) {
            response.writeHead(413).end();
            request.resume();
            return;
          }
          parts.push(bytes);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          response.writeHead(400).end();
          return;
        }
        const headers: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(request.headers))
          if (value !== undefined) headers[key] = value;
        const result = await handler({ headers, body });
        response.writeHead(result.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(result.body === undefined ? "" : JSON.stringify(result.body));
      } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(port), "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = undefined;
  }
}

/** SDK debug/error arguments can contain raw activities and bearer tokens. */
export class RedactedTeamsLogger {
  debug(): void {}
  trace(): void {}
  info(): void {}
  warn(): void {
    process.stderr.write("Teams SDK warning\n");
  }
  error(): void {
    process.stderr.write("Teams SDK failure\n");
  }
  log(level: string): void {
    if (level === "warn") this.warn();
    else if (level === "error") this.error();
  }
  child(): RedactedTeamsLogger {
    return this;
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createApp() {
  return createServer(handleRequest);
}

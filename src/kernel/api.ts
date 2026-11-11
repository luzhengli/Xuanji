// 本机接口：内核只听 127.0.0.1。来源、接单程序、通道、xj 都是它的客户端。
// 入口是协议，不是界面：飞书和 xj 读写的是同一组接口。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kernel } from "./kernel.ts";
import type { EventInput } from "./types.ts";

export function startApi(kernel: Kernel, port: number) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "POST" ? await readJson(req) : null;
      const route = `${req.method} ${url.pathname}`;

      if (route === "POST /events") {               // 一切皆事件
        const e = kernel.ingest(body as EventInput);
        return json(res, 200, { seq: e?.seq ?? null, duplicate: e === null });
      }
      if (route === "POST /runs/claim") {            // 接单程序领活
        const a = kernel.claim((body as { agent: string }).agent);
        return json(res, 200, a ?? { task: null });
      }
      if (route === "GET /cards") return json(res, 200, kernel.cards());
      if (route === "GET /overview") return json(res, 200, kernel.overview());
      if (url.pathname.startsWith("/why/")) return json(res, 200, kernel.why(decodeURIComponent(url.pathname.slice(5))));
      if (url.pathname.startsWith("/recall/")) return json(res, 501, { error: "TODO P2 链式召回" });
      if (route === "GET /health") return json(res, 200, { ok: true });
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data));
}

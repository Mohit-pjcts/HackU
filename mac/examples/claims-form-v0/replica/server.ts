// The replica claims form + its database. The database is the ORACLE: the agent's "done" is only believed
// when GET /api/claims shows exactly the expected new record.
import { join } from "node:path";

export interface Record_ { id: number; payee: string; amount: string; date: string; category: string; paidby: string; t: number }

export const db: Record_[] = [];
let nextId = 1;

const formHtml = await Bun.file(join(import.meta.dir, "form.html")).text();
const noStore = { "Cache-Control": "no-store, max-age=0", "Content-Type": "text/html; charset=utf-8" };

export function startReplica(port = 8765) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        const rid = url.searchParams.get("received");
        const banner = rid ? `<div class="banner" role="status">Claim #${Number(rid)} received.</div>` : "";
        return new Response(formHtml.replace("<!--BANNER-->", banner), { headers: noStore });
      }
      if (req.method === "POST" && url.pathname === "/submit") {
        const f = await req.formData();
        const rec: Record_ = {
          id: nextId++,
          payee: String(f.get("payee") ?? ""),
          amount: String(f.get("amount") ?? ""),
          date: String(f.get("date") ?? ""),
          category: String(f.get("category") ?? ""),
          paidby: String(f.get("paidby") ?? ""),
          t: Date.now(),
        };
        db.push(rec);
        return new Response(null, { status: 303, headers: { Location: `/?received=${rec.id}`, "Cache-Control": "no-store" } });
      }
      if (req.method === "GET" && url.pathname === "/api/claims") {
        return Response.json(db, { headers: { "Cache-Control": "no-store" } });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        db.length = 0;
        nextId = 1;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const s = startReplica();
  console.log(`replica form on http://127.0.0.1:${s.port}/`);
}

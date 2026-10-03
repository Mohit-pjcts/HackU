// The panel, its API and the overlay socket are for this computer only. A web page you visit can still send requests
// to 127.0.0.1, so two checks: the Host must be this computer (a site's own name pointed at 127.0.0.1, "DNS rebinding",
// fails), and when a browser says where a request comes from (Origin, always sent on POST and WebSocket), it must be
// the panel's own page. Native clients (the overlay, scripts, tests) send no Origin and pass.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function fromThisComputer(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!LOCAL_HOSTS.has(name)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // "null" (a sandboxed frame, a file) or garbage
  }
}

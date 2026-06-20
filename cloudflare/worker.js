const BACKEND_ORIGIN = "https://career-engine-theta.vercel.app";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
];

function proxiedHeaders(request, incomingUrl) {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.set("x-career-engine-proxy", "cloudflare");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  return headers;
}

function withProxyHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("x-career-engine-cloudflare", "proxy");
  if (pathname === "/" || pathname === "/index.html") {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/cloudflare-healthz") {
      return Response.json({
        ok: true,
        provider: "cloudflare-worker-proxy",
        backend: BACKEND_ORIGIN,
      });
    }

    const backendUrl = new URL(incomingUrl.pathname + incomingUrl.search, BACKEND_ORIGIN);
    const init = {
      method: request.method,
      headers: proxiedHeaders(request, incomingUrl),
      redirect: "manual",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
    }

    const response = await fetch(backendUrl, init);
    return withProxyHeaders(response, incomingUrl.pathname);
  },
};

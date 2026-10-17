const METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const REQUEST_HEADERS = [
  "accept",
  "accept-profile",
  "authorization",
  "apikey",
  "cache-control",
  "content-profile",
  "content-type",
  "if-match",
  "if-none-match",
  "prefer",
  "range",
  "x-client-info",
  "x-supabase-api-version",
  "x-upsert",
];
const AUTH_PATHS = new Set([
  "/auth/v1/token",
  "/auth/v1/user",
  "/auth/v1/logout",
  "/auth/v1/signup",
  "/auth/v1/recover",
  "/auth/v1/verify",
  "/auth/v1/resend",
  "/auth/v1/settings",
]);

function allowedPath(path: string, env: Env): boolean {
  if (/%2f|%5c|\\|\/{2}/i.test(path)) return false;
  if (AUTH_PATHS.has(path)) return true;
  if (path.startsWith("/rest/v1/")) return true;
  const parts = path.split("/");
  if (path.startsWith("/functions/v1/")) {
    return parts[3].startsWith(env.GEAR_FUNCTION_PREFIX);
  }
  if (path.startsWith("/storage/v1/object/")) {
    const bucketIndex = ["public", "sign", "authenticated", "list"].includes(
      parts[4],
    )
      ? 5
      : 4;
    return parts[bucketIndex] === env.GEAR_STORAGE_BUCKET;
  }
  return false;
}

function responseHeaders(origin: string | null, env: Env): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin === env.FRONTEND_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", METHODS);
    headers.set("Access-Control-Allow-Headers", REQUEST_HEADERS.join(", "));
    headers.set(
      "Access-Control-Expose-Headers",
      "content-range, range, etag, location, x-total-count, x-supabase-api-version",
    );
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = responseHeaders(origin, env);
    const error = (code: string, status: number) =>
      Response.json({ error: code }, { status, headers });

    if (origin && origin !== env.FRONTEND_ORIGIN)
      return error("origin_not_allowed", 403);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (!METHODS.split(", ").includes(request.method))
      return error("method_not_allowed", 405);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json(
        { status: "ready", service: "gear-api-gateway" },
        { headers },
      );
    }
    if (!allowedPath(url.pathname, env)) return error("not_found", 404);
    const emailVerificationLink =
      url.pathname === "/auth/v1/verify" && request.method === "GET";
    if (!emailVerificationLink && !request.headers.get("apikey"))
      return error("api_key_required", 401);

    for (const key of ["Accept-Profile", "Content-Profile"]) {
      const value = request.headers.get(key);
      if (value && value !== env.GEAR_DB_SCHEMA)
        return error("schema_not_allowed", 403);
    }
    const forwarded = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      forwarded.set("Accept-Profile", env.GEAR_DB_SCHEMA);
      forwarded.set("Content-Profile", env.GEAR_DB_SCHEMA);
    }

    const upstream = new URL(env.SUPABASE_URL);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    // This shared Auth identity may have sessions in unrelated applications.
    if (url.pathname === "/auth/v1/logout")
      upstream.searchParams.set("scope", "local");
    try {
      const upstreamRequest = new Request(new Request(upstream, request), {
        headers: forwarded,
        redirect: "manual",
      });
      const result = await fetch(upstreamRequest, {
        cf: { cacheEverything: false, cacheTtl: 0 },
      });
      const output = new Headers(result.headers);
      for (const name of [...output.keys()]) {
        if (name.toLowerCase().startsWith("access-control-"))
          output.delete(name);
      }
      for (const [name, value] of headers) output.set(name, value);
      output.set("Vary", "Origin, Accept-Profile");
      const location = output.get("Location");
      if (location) {
        const redirected = new URL(location, upstream);
        if (redirected.origin === upstream.origin) {
          redirected.protocol = url.protocol;
          redirected.host = url.host;
          output.set("Location", redirected.toString());
        }
      }
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: output,
      });
    } catch {
      console.error(JSON.stringify({ event: "upstream_unavailable" }));
      return error("upstream_unavailable", 502);
    }
  },
} satisfies ExportedHandler<Env>;

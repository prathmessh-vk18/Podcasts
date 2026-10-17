/**
 * Scriptable fetch for adapter tests. Routes match on method + URL substring (or a predicate);
 * each route serves its responses in order and repeats the last one.
 */
export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Throw instead of responding (simulates network errors / timeouts). */
  throws?: Error;
}

interface Route {
  method: string;
  match: string | ((url: URL, init: RequestInit) => boolean);
  responses: FakeResponse[];
  hits: number;
}

export interface Call {
  method: string;
  url: URL;
  body: string | undefined;
  headers: Record<string, string>;
}

export function fakeFetch() {
  const routes: Route[] = [];
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      url,
      body: typeof init.body === 'string' ? init.body : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find(
      (r) =>
        r.method === method &&
        (typeof r.match === 'string' ? url.href.includes(r.match) : r.match(url, init)),
    );
    if (!route) throw new Error(`fakeFetch: no route for ${method} ${url.href}`);
    const res = route.responses[Math.min(route.hits, route.responses.length - 1)]!;
    route.hits++;
    if (res.throws) throw res.throws;
    const body = res.bytes ?? (res.json !== undefined ? JSON.stringify(res.json) : (res.text ?? ''));
    return new Response(res.status === 204 ? null : (body as ConstructorParameters<typeof Response>[0]), {
      status: res.status ?? 200,
      headers: { 'content-type': res.json !== undefined ? 'application/json' : 'text/plain', ...res.headers },
    });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    on(method: string, match: Route['match'], ...responses: FakeResponse[]) {
      routes.push({ method: method.toUpperCase(), match, responses, hits: 0 });
      return this;
    },
  };
}

export const noSleep = async (_ms: number) => {};

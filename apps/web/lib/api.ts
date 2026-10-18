import type {
  Capability,
  Collection,
  CollectionDetail,
  CollectionItem,
  Connection,
  Episode,
  EpisodeLike,
  ExportJob,
  FeedPage,
  LinkList,
  Platform,
  SearchOutcome,
  Topic,
} from './types';

/** Error with the API's `{ error: { code, message, retryable } }` shape. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        // Required by the API for writes (CSRF protection).
        ...(method !== 'GET' ? { 'x-tangent-csrf': '1' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.', true);
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (
      json as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } } | null
    )?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'unknown',
      e?.message ?? `Request failed (${res.status})`,
      e?.retryable ?? res.status >= 500,
      e?.details,
    );
  }
  return json as T;
}

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  providers: () =>
    request<{ providers: Capability[]; youtubeQuotaRemaining: number | null }>('GET', '/v1/providers'),

  feed: (topic: string | null, cursor: string | null, limit = 24) =>
    request<FeedPage>('GET', `/v1/discover/feed${q({ topic, cursor, limit })}`),
  trending: (limit = 16) => request<{ items: Episode[] }>('GET', `/v1/discover/trending${q({ limit })}`),
  topics: () => request<{ topics: Topic[] }>('GET', '/v1/topics'),
  search: (query: string, platforms: Platform[], limit = 12) =>
    request<{ query: string; results: Record<string, SearchOutcome> }>(
      'GET',
      `/v1/search${q({ q: query, platforms: platforms.join(','), limit })}`,
    ),

  saved: () => request<{ saved: Record<string, string[]> }>('GET', '/v1/library/saved'),
  collections: () => request<{ collections: Collection[] }>('GET', '/v1/collections'),
  collection: (id: string) => request<CollectionDetail>('GET', `/v1/collections/${id}`),
  createCollection: (name: string, description?: string) =>
    request<Collection>('POST', '/v1/collections', { name, ...(description ? { description } : {}) }),
  updateCollection: (id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'privacy'>>) =>
    request<Collection>('PATCH', `/v1/collections/${id}`, patch),
  deleteCollection: (id: string) => request<void>('DELETE', `/v1/collections/${id}`),
  restoreCollection: (id: string) => request<Collection>('POST', `/v1/collections/${id}/restore`),
  addToCollection: (id: string, ep: EpisodeLike) =>
    request<{ added: boolean; item: CollectionItem }>('POST', `/v1/collections/${id}/items`, {
      platform: ep.platform,
      sourceId: ep.sourceId,
      ...(ep.showId ? { showId: ep.showId } : {}),
      title: ep.title.slice(0, 300),
    }),
  removeFromCollection: (id: string, itemId: string) =>
    request<void>('DELETE', `/v1/collections/${id}/items/${itemId}`),
  reorder: (id: string, itemIds: string[]) =>
    request<void>('PUT', `/v1/collections/${id}/order`, { itemIds }),
  links: (id: string) => request<LinkList>('GET', `/v1/collections/${id}/links`),

  connections: () => request<{ connections: Connection[] }>('GET', '/v1/connections'),
  disconnect: (platform: Platform) => request<void>('DELETE', `/v1/connections/${platform}`),
  connectUrl: (platform: Platform, returnTo: string) =>
    `/api/v1/connections/${platform}/start${q({ returnTo })}`,

  createExport: (body: {
    collectionId: string;
    destination: Platform;
    idempotencyKey: string;
    playlistTitle?: string;
  }) => request<ExportJob>('POST', '/v1/exports', body),
  exportJob: (id: string) => request<ExportJob>('GET', `/v1/exports/${id}`),
  decide: (id: string, decisions: Array<{ itemId: string; decision: 'accept' | 'reject' | null }>) =>
    request<ExportJob>('POST', `/v1/exports/${id}/decisions`, { decisions }),
  execute: (id: string) => request<ExportJob>('POST', `/v1/exports/${id}/execute`),
  retry: (id: string) => request<ExportJob>('POST', `/v1/exports/${id}/retry`),
  cancel: (id: string) => request<ExportJob>('POST', `/v1/exports/${id}/cancel`),
};

export const savedKey = (ep: Pick<EpisodeLike, 'platform' | 'sourceId'>) => `${ep.platform}:${ep.sourceId}`;

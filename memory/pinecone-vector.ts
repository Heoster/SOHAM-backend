/** Shared Pinecone dense-vector transport. No Upstash fallback or provisioning. */
export function isPineconeReady(): boolean {
  return Boolean(process.env.PINECONE_INDEX_HOST && process.env.PINECONE_API_KEY);
}

function indexOrigin(): string {
  const host = (process.env.PINECONE_INDEX_HOST || '').replace(/\/$/, '');
  if (!isPineconeReady()) throw new Error('PINECONE_INDEX_HOST and PINECONE_API_KEY are required');
  const url = new URL(host.startsWith('https://') ? host : `https://${host}`);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.pinecone.io') || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PINECONE_INDEX_HOST must be a Pinecone HTTPS index host');
  }
  return url.origin;
}

export async function pineconeRequest(path: string, body: unknown, timeoutMs = 8000): Promise<any> {
  const res = await fetch(`${indexOrigin()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.PINECONE_API_KEY! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Pinecone ${path} HTTP ${res.status}`);
  return res.json();
}

/** Transitional internal payload interface used by existing RAG callers. */
export async function vectorRequest(path: string, body: any, timeoutMs = 8000): Promise<any> {
  const namespace = process.env.PINECONE_NAMESPACE || 'soham';
  if (path === '/upsert') {
    return pineconeRequest('/vectors/upsert', {
      namespace,
      vectors: body.vectors.map((v: any) => ({
        id: v.id, values: v.vector,
        metadata: Object.fromEntries(Object.entries({ ...v.metadata, ...(typeof v.data === 'string' ? { _soham_text: v.data } : {}) }).filter(([, value]) => value !== undefined && value !== null)),
      })),
    }, timeoutMs);
  }
  if (path === '/query') {
    let filter = body.filter;
    if (typeof filter === 'string') {
      const clauses = filter.split(/\s+AND\s+/i).map((clause: string) => {
        const match = /^([a-z_]+) = '([^']*)'$/.exec(clause);
        if (!match) throw new Error('Invalid vector metadata filter');
        return { [match[1]]: { $eq: match[2] } };
      });
      filter = clauses.length === 1 ? clauses[0] : { $and: clauses };
    }
    const result = await pineconeRequest('/query', {
      namespace, vector: body.vector, topK: body.topK,
      includeMetadata: true, ...(filter ? { filter } : {}),
    }, timeoutMs);
    return { result: (result.matches || []).map((m: any) => ({ ...m, data: m.metadata?._soham_text })) };
  }
  if (path === '/fetch') {
    const url = new URL('/vectors/fetch', indexOrigin());
    url.searchParams.set('namespace', namespace);
    for (const id of body.ids) url.searchParams.append('ids', id);
    const res = await fetch(url, { headers: { 'Api-Key': process.env.PINECONE_API_KEY! }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Pinecone fetch HTTP ${res.status}`);
    const data: any = await res.json();
    return { result: Object.values(data.vectors || {}).map((v: any) => ({ ...v, data: v.metadata?._soham_text })) };
  }
  if (path === '/update') return pineconeRequest('/vectors/update', { namespace, id: body.id, setMetadata: body.metadata }, timeoutMs);
  if (path === '/delete') return pineconeRequest('/vectors/delete', { namespace, ids: body.ids }, timeoutMs);
  throw new Error(`Unsupported vector operation: ${path}`);
}

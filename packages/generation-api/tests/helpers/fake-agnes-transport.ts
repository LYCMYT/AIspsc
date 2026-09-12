import { AGNES_API_BASE_URL, AGNES_VIDEO_MODEL } from '../../../provider-agnes/src/index.js';
import { checkedMediaUrl } from '../../../provider-agnes/src/download.js';

export interface SimulatedAgnesReply {
  operation: 'create' | 'get';
  body?: unknown;
  status?: number;
  /** Rejection models an ambiguous transport failure without retaining a raw error. */
  timeout?: boolean;
}
export interface FakeAgnesTransportOptions { apiKey: string; replies: SimulatedAgnesReply[]; mediaUrl?: string; mediaBytes?: Uint8Array; downloadStatus?: number }
/** No global fetch or network escape hatch. Only declared requests have synthetic responses. */
export class FakeAgnesTransport {
  readonly #secret: string;
  readonly #replies: SimulatedAgnesReply[];
  readonly #mediaUrl?: string;
  readonly #mediaBytes?: Uint8Array;
  readonly #downloadStatus: number;
  readonly calls: Array<'create' | 'get' | 'download'> = [];
  readonly realCalls = 0;
  constructor(options: FakeAgnesTransportOptions) {
    this.#secret = options.apiKey.trim();
    if (!this.#secret) throw Error('SIMULATION_AUTH_INVALID');
    this.#replies = structuredClone(options.replies);
    this.#mediaUrl = options.mediaUrl;
    this.#mediaBytes = options.mediaBytes?.slice();
    this.#downloadStatus = options.downloadStatus ?? 200;
    if (this.#mediaUrl) checkedMediaUrl(this.#mediaUrl);
  }
  fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (url.origin === AGNES_API_BASE_URL && !url.username && !url.password && !url.hash) {
      if (headers.get('authorization') !== `Bearer ${this.#secret}`) throw Error('SIMULATION_AUTH_INVALID');
      const create = method === 'POST' && url.pathname === '/v1/videos' && !url.search;
      const get = method === 'GET' && url.pathname === '/agnesapi' && url.searchParams.get('model_name') === AGNES_VIDEO_MODEL && /^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('video_id') ?? '') && [...url.searchParams.keys()].sort().join(',') === 'model_name,video_id';
      if (!create && !get) throw Error('SIMULATION_REQUEST_FORBIDDEN');
      const operation = create ? 'create' : 'get';
      const reply = this.#replies[0];
      if (!reply || reply.operation !== operation) throw Error('SIMULATION_REPLY_NOT_DECLARED');
      this.#replies.shift();
      this.calls.push(operation);
      if (reply.timeout) throw Error('SIMULATION_TIMEOUT');
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    if (this.#mediaUrl && url.href === this.#mediaUrl && method === 'GET' && init?.credentials === 'omit' && init.redirect === 'error' && !headers.has('authorization') && !headers.has('cookie')) {
      this.calls.push('download');
      return new Response(this.#mediaBytes ? new Uint8Array(this.#mediaBytes) : undefined, { status: this.#downloadStatus, headers: { 'content-type': 'video/mp4' } });
    }
    throw Error('SIMULATION_REQUEST_FORBIDDEN');
  };
}

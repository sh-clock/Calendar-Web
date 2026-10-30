/**
 * api.js — HTTP client for the calendar PoC server (protocol v4.1, §5 policy).
 *
 * Distinguishes the three failure shapes the wire spec defines:
 *  - silent drop (§4): 404 with an EMPTY body — authentication failed.
 *  - not_found (§5):   404 WITH a JSON body — authenticated, missing resource.
 *  - forbidden (§5):   403 with an empty body — capability violation.
 */

export class ApiError extends Error {
  constructor(kind, status, body, raw) {
    super(kind + (status ? '_' + status : ''));
    this.kind = kind; // 'silent' | 'not_found' | 'forbidden' | 'http' | 'network'
    this.status = status;
    this.body = body;
    this.raw = raw;
  }
}

export class Api {
  constructor(baseUrl, tokenHex) {
    if (!/^[0-9a-f]{64}$/.test(tokenHex)) throw new Error('bad_token');
    this.base = String(baseUrl).replace(/\/+$/, '');
    this.token = tokenHex;
  }

  async #req(method, path, body) {
    const headers = { authorization: 'Bearer ' + this.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError('network', 0, null, String(e));
    }
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.ok) return parsed;
    if (res.status === 404 && !text) throw new ApiError('silent', 404, null);
    if (res.status === 403 && !text) throw new ApiError('forbidden', 403, null);
    if (res.status === 404) throw new ApiError('not_found', 404, parsed);
    throw new ApiError('http', res.status, parsed, text);
  }

  /** §8 — clear params only. */
  getConfig() {
    return this.#req('GET', '/config');
  }

  /** §22 */
  getVersion() {
    return this.#req('GET', '/version');
  }

  /** §10 */
  getStatus() {
    return this.#req('GET', '/status');
  }

  /** §9 — manifest, excludes the config row. */
  getManifest() {
    return this.#req('GET', '/rows');
  }

  /** §9 — full envelope, or null when the row does not exist (404 not_found). */
  async getRow(id) {
    try {
      return await this.#req('GET', '/rows/' + encodeURIComponent(id));
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  /**
   * §9 RMW write. Returns the STORED envelope the server sent back (200 in both
   * the accept and the reject-as-rebase case). Callers detect acceptance by
   * comparing the returned envelope identity with the submitted one
   * (WORKLOG D14 — ver alone is ambiguous when incoming.ver == stored.ver).
   */
  putRow(id, env) {
    return this.#req('PUT', '/rows/' + encodeURIComponent(id), {
      ver: env.ver,
      nonce: env.nonce,
      ct: env.ct,
    });
  }

  /** §9 — idempotent delete. */
  deleteRow(id) {
    return this.#req('DELETE', '/rows/' + encodeURIComponent(id));
  }
}

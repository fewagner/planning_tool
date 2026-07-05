// github.js — minimal GitHub REST client.
// Reads via the branches/trees/blobs endpoints (raw.githubusercontent.com when no
// token is set), writes one atomic commit per save via the git data API.

import { b64DecodeUtf8 } from './util.js';

export class GHError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const encPath = p => p.split('/').map(encodeURIComponent).join('/');

export class GitHubClient {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token || '';
  }

  async req(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    let res;
    try {
      res = await fetch(`https://api.github.com/${path}`, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GHError('Network error — GitHub is unreachable (offline?).', 'network', 0);
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { }
    if (res.status === 401) throw new GHError('GitHub rejected the token (401). Check it in Settings.', 'auth', 401);
    if (res.status === 404) throw new GHError(`Not found: ${path.split('?')[0]} — check repository, branch and token access.`, 'not-found', 404);
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = res.headers.get('x-ratelimit-reset');
        const at = reset ? ' It resets at ' + new Date(reset * 1000).toLocaleTimeString() + '.' : '';
        throw new GHError(`GitHub API rate limit reached.${this.token ? '' : ' Adding a token in Settings raises the limit a lot.'}${at}`, 'rate-limit', res.status);
      }
      throw new GHError(detail || 'GitHub denied the request (403). The token may lack write access to this repository.', 'forbidden', res.status);
    }
    if (res.status === 409 || res.status === 422) throw new GHError(detail || 'GitHub reported a conflict.', 'conflict', res.status);
    throw new GHError(detail || `GitHub API error (${res.status}).`, 'api', res.status);
  }

  base() { return `repos/${this.owner}/${this.repo}`; }

  async getRepo() { return this.req(this.base()); }

  // Head of the configured branch, or null if the repo exists but is empty /
  // the branch doesn't exist yet.
  async getHead() {
    try {
      const b = await this.req(`${this.base()}/branches/${encodeURIComponent(this.branch)}`);
      return { sha: b.commit.sha, treeSha: b.commit.commit.tree.sha };
    } catch (e) {
      if (e.code === 'not-found' || e.code === 'conflict') {
        await this.getRepo();
        return null;
      }
      throw e;
    }
  }

  async getTree(treeSha) {
    const r = await this.req(`${this.base()}/git/trees/${treeSha}?recursive=1`);
    return r.tree || [];
  }

  async getBlobText(sha) {
    const r = await this.req(`${this.base()}/git/blobs/${sha}`);
    return b64DecodeUtf8(r.content || '');
  }

  rawUrl(ref, path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${ref}/${encPath(path)}`;
  }

  async getRawText(ref, path) {
    const res = await fetch(this.rawUrl(ref, path));
    if (!res.ok) throw new GHError(`Could not fetch ${path} (${res.status}). For private repositories, add a token in Settings.`, 'raw', res.status);
    return res.text();
  }

  // Authenticated fetch of a (possibly binary) file as an object URL — used as a
  // fallback for images in private repositories.
  async getFileBlobUrl(path) {
    const r = await this.req(`${this.base()}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`);
    const bin = atob((r.content || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes]));
  }

  // changes: [{path, text} | {path, base64} | {path, delete: true}]
  // parent: {sha, treeSha} or null for an empty repo (bootstraps the branch).
  async commitFiles({ message, parent, changes }) {
    const tree = [];
    for (const ch of changes) {
      if (ch.delete) {
        if (parent) tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
      } else if (ch.base64 != null) {
        const blob = await this.req(`${this.base()}/git/blobs`, {
          method: 'POST', body: { content: ch.base64, encoding: 'base64' },
        });
        tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: blob.sha });
      } else {
        tree.push({ path: ch.path, mode: '100644', type: 'blob', content: ch.text });
      }
    }
    if (!tree.length) return null;
    const newTree = await this.req(`${this.base()}/git/trees`, {
      method: 'POST',
      body: parent ? { base_tree: parent.treeSha, tree } : { tree },
    });
    const commit = await this.req(`${this.base()}/git/commits`, {
      method: 'POST',
      body: { message, tree: newTree.sha, parents: parent ? [parent.sha] : [] },
    });
    if (parent) {
      await this.req(`${this.base()}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        method: 'PATCH', body: { sha: commit.sha },
      });
    } else {
      await this.req(`${this.base()}/git/refs`, {
        method: 'POST', body: { ref: `refs/heads/${this.branch}`, sha: commit.sha },
      });
    }
    return { sha: commit.sha, treeSha: newTree.sha };
  }
}

/**
 * @module net
 * Guarded HTTP(S) fetcher: protocol/allow-list checks, post-DNS IP checks, IP pinning,
 * redirect re-validation, timeout and size limits.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createRequire } from 'node:module';
import { JsonSchemaCommError } from './errors.js';

const require = createRequire(import.meta.url);
const VERSION = require('./package.json').version;
const USER_AGENT = `valid-instance/${VERSION}`;

/**
 * Removes credentials, query string and fragment from a URL so it is safe to log.
 * @param {string} urlText The URL.
 * @returns {string} Sanitized URL.
 */
export function sanitizeUrl(urlText) {
  try {
    const url = new URL(urlText);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '<invalid url>';
  }
}

/**
 * Parses an IPv6 address into 16 bytes.
 * @param {string} ip IPv6 text.
 * @returns {number[]} Bytes.
 */
function parseV6(ip) {
  const clean = ip.split('%')[0];
  const [head, tail] = clean.split('::');
  const toGroups = (part) => {
    if (!part) {
      return [];
    }
    const groups = part.split(':');
    const last = groups[groups.length - 1];
    if (last.includes('.')) {
      const p = last.split('.').map(Number);
      groups.splice(-1, 1, ((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16));
    }
    return groups.map((g) => parseInt(g, 16));
  };
  const h = toGroups(head);
  const t = tail === undefined ? [] : toGroups(tail);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array.from({ length: fill }, () => 0), ...t];
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

/**
 * Checks an IPv4 address (as numbers) against the blocked ranges.
 * @param {number[]} p Four octets.
 * @returns {boolean} True when blocked.
 */
function v4Blocked(p) {
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Tells whether an IP address is in a loopback, private, link-local or unspecified range.
 * @param {string} ip IPv4 or IPv6 text.
 * @returns {boolean} True when the address is blocked.
 */
export function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return v4Blocked(ip.split('.').map(Number));
  }
  if (kind !== 6) {
    return true;
  }
  const b = parseV6(ip);
  const zeros10 = b.slice(0, 10).every((x) => x === 0);
  if (zeros10 && b[10] === 0xff && b[11] === 0xff) {
    return v4Blocked(b.slice(12));
  }
  if (b.slice(0, 15).every((x) => x === 0)) {
    return b[15] <= 1;
  }
  if (b.slice(0, 12).every((x) => x === 0)) {
    return v4Blocked(b.slice(12));
  }
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80);
}

/**
 * Creates a policy error.
 * @param {string} code Error code.
 * @param {string} message Message.
 * @param {Error} [cause] Cause.
 * @returns {JsonSchemaCommError} The error.
 */
function commError(code, message, cause) {
  return new JsonSchemaCommError(message, { code, cause });
}

/**
 * Evaluates the allow list for a URL.
 * @param {string[]|Function} allowList Hostnames or matcher.
 * @param {URL} url The URL.
 * @returns {boolean} True when approved.
 */
function isAllowed(allowList, url) {
  if (typeof allowList === 'function') {
    return Boolean(allowList(url));
  }
  const host = url.hostname.toLowerCase();
  return allowList.some((entry) => {
    const e = String(entry).toLowerCase();
    return e === host || e === url.host.toLowerCase();
  });
}

/**
 * Validates the URL against protocol, credential and allow-list rules.
 * @param {URL} url The URL.
 * @param {object} policy The remote refs policy.
 * @returns {void}
 */
function checkUrl(url, policy) {
  const shown = sanitizeUrl(url.href);
  if (!['http:', 'https:'].includes(url.protocol) || !policy.protocols.includes(url.protocol)) {
    throw commError('REMOTE_REF_BLOCKED', `Protocol '${url.protocol}' is not allowed for ${shown}`);
  }
  if (url.username || url.password) {
    throw commError('REMOTE_REF_BLOCKED', `Credentials in URLs are not allowed: ${shown}`);
  }
  if (!isAllowed(policy.allowList, url)) {
    throw commError('REMOTE_REF_BLOCKED', `Host is not on the allow list: ${shown}`);
  }
}

/**
 * Resolves the host and returns an address that passed the IP checks.
 * @param {URL} url The URL.
 * @param {object} policy The remote refs policy.
 * @returns {Promise<{address: string, family: number}>} The pinned address.
 */
async function resolveAndCheck(url, policy) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  } catch (cause) {
    throw commError('NETWORK', `DNS lookup failed for ${sanitizeUrl(url.href)}`, cause);
  }
  const allowedPrivate = policy.allowPrivateHosts.map((h) => String(h).toLowerCase());
  const hostOk = allowedPrivate.includes(host.toLowerCase());
  for (const { address } of addresses) {
    if (isBlockedIp(address) && !hostOk && !allowedPrivate.includes(address)) {
      throw commError('REMOTE_REF_BLOCKED', `Host resolves to a blocked address: ${sanitizeUrl(url.href)}`);
    }
  }
  return addresses[0];
}

/**
 * Performs one HTTP request pinned to a validated address.
 * @param {URL} url The URL.
 * @param {{address: string, family: number}} pinned Validated address.
 * @param {object} policy The policy.
 * @param {AbortSignal} signal Abort signal.
 * @returns {Promise<{status: number, location?: string, text?: string}>} The outcome.
 */
function request(url, pinned, policy, signal) {
  const lib = url.protocol === 'https:' ? https : http;
  const lookup = (_host, opts, cb) => {
    if (opts && opts.all) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      cb(null, pinned.address, pinned.family);
    }
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET', agent: false, lookup, signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, location: res.headers.location });
        return;
      }
      readBody(res, policy.maxBytes, url).then((text) => resolve({ status, text }), reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Reads a response body enforcing the size limit.
 * @param {import('node:http').IncomingMessage} res The response.
 * @param {number} maxBytes Limit.
 * @param {URL} url URL, for messages.
 * @returns {Promise<string>} The body text.
 */
function readBody(res, maxBytes, url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => {
      res.destroy();
      reject(commError('TOO_LARGE', `Response exceeds ${maxBytes} bytes: ${sanitizeUrl(url.href)}`));
    };
    if (Number(res.headers['content-length']) > maxBytes) {
      tooLarge();
      return;
    }
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge();
      } else {
        chunks.push(chunk);
      }
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/**
 * Fetches the text of a remote schema under the security policy.
 * @param {string} urlText Absolute URL.
 * @param {object} policy Remote refs policy.
 * @returns {Promise<string>} Response text.
 */
export async function guardedFetch(urlText, policy) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    let url;
    try {
      url = new URL(urlText);
    } catch (cause) {
      throw commError('REMOTE_REF_BLOCKED', 'Invalid URL', cause);
    }
    for (let hop = 0; ; hop++) {
      checkUrl(url, policy);
      const pinned = await resolveAndCheck(url, policy);
      const result = await request(url, pinned, policy, controller.signal);
      if (result.location === undefined) {
        if (result.status < 200 || result.status >= 300) {
          throw commError('NETWORK', `HTTP ${result.status} from ${sanitizeUrl(url.href)}`);
        }
        return result.text;
      }
      if (hop >= policy.maxRedirects) {
        throw commError('REDIRECT_LIMIT', `Too many redirects from ${sanitizeUrl(url.href)}`);
      }
      url = new URL(result.location, url);
    }
  } catch (error) {
    if (error instanceof JsonSchemaCommError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw commError('TIMEOUT', `Timed out after ${policy.timeoutMs}ms: ${sanitizeUrl(urlText)}`, error);
    }
    throw commError('NETWORK', `Request failed: ${sanitizeUrl(urlText)}`, error);
  } finally {
    clearTimeout(timer);
  }
}

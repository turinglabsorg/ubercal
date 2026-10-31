/**
 * Fetching a calendar link someone pasted. The link comes from anyone on the
 * internet and the request leaves from our server, so it may only reach public
 * addresses: every address a name resolves to is checked when the connection
 * opens (a name cannot answer differently later), and so is every redirect.
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// Two lists: a BlockList holding an IPv6 range that maps IPv4 would match every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  blocked6.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address) {
  const text = String(address).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(text)) return false;
  const family = isIP(text);
  if (family === 4) return !blocked4.check(text, "ipv4");
  if (family === 6) return !blocked6.check(text, "ipv6");
  return false;
}

export class FetchError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** A pasted link as the https/http URL to fetch: webcal:// becomes https://. Tests and local runs (`allowPrivate`) may use any port. */
export function normalizeUrl(input, { allowPrivate = false } = {}) {
  let text = String(input || "").trim();
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:/i, "https:");
  let url;
  try { url = new URL(text); } catch { throw new FetchError("This is not a link."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new FetchError("Only http, https and webcal links work.");
  if (url.username || url.password) throw new FetchError("Links with a username or password in them are not supported.");
  if (!allowPrivate && !PORTS.has(url.port)) throw new FetchError("Calendar links must use the usual web ports.");
  url.hash = "";
  return url;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || isIP(addresses) }];
      const bad = list.find((entry) => !allowPrivate && !isPublicAddress(entry.address));
      if (bad || !list.length) return callback(new FetchError("This link points to a private address."));
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

function once(url, { headers, timeoutMs, maxBytes, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      headers: { "User-Agent": "ubercal/0.1 (+https://ubercal.fluxkit.dev)", Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "Accept-Encoding": "gzip, deflate, br", ...headers },
      lookup: guardedLookup(allowPrivate),
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 || status === 304 || status >= 400) {
        response.resume();
        return resolve({ status, headers: response.headers, body: "" });
      }
      const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
      const stream = encoding === "gzip" ? response.pipe(createGunzip()) : encoding === "deflate" ? response.pipe(createInflate()) : encoding === "br" ? response.pipe(createBrotliDecompress()) : response;
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy();
          reject(new FetchError("This calendar is too large."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", () => reject(new FetchError("The calendar could not be read.")));
    });
    request.on("timeout", () => request.destroy(new FetchError("The calendar did not answer in time.")));
    request.on("error", (error) => reject(error instanceof FetchError ? error : new FetchError(error.code === "ENOTFOUND" ? "This address does not exist." : "The calendar could not be reached.")));
    request.end();
  });
}

/**
 * GET a calendar link: {status: 200, body, etag, lastModified} or {status: 304}.
 * Redirects are followed (five at most), each checked like the first link.
 */
export async function fetchCalendar(input, { etag = "", lastModified = "", timeoutMs = 30000, maxBytes = 10 * 1024 * 1024, allowPrivate = false } = {}) {
  let url = normalizeUrl(input, { allowPrivate });
  const headers = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;
  for (let hop = 0; hop < 6; hop += 1) {
    // An address written in the link opens the connection without any lookup to check.
    const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!allowPrivate && isIP(literal) && !isPublicAddress(literal)) throw new FetchError("This link points to a private address.");
    const response = await once(url, { headers, timeoutMs, maxBytes, allowPrivate });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      url = normalizeUrl(new URL(response.headers.location, url).toString(), { allowPrivate });
      continue;
    }
    if (response.status === 304) return { status: 304 };
    if (response.status === 401 || response.status === 403) throw new FetchError("This calendar is private: the link does not give access to it.", response.status);
    if (response.status === 404 || response.status === 410) throw new FetchError("Nothing is at this link anymore.", response.status);
    if (response.status !== 200) throw new FetchError(`The calendar answered with an error (${response.status}).`, response.status);
    if (!/BEGIN:VCALENDAR/i.test(response.body.slice(0, 4096))) throw new FetchError("This link does not lead to a calendar (.ics) file.");
    return { status: 200, body: response.body, etag: String(response.headers.etag || ""), lastModified: String(response.headers["last-modified"] || "") };
  }
  throw new FetchError("This link redirects too many times.");
}

import { novadaProxyFetch } from "./fetch.js";
import type { ProxyAdapter, ProxyCredentials } from "../adapters/index.js";
import type { ProxySuccessResponse } from "../types.js";
import { SAFE_COUNTRY, QUOTA_NOTE } from "../validation.js";

export interface MapParams {
  url: string;           // starting URL — domain root or any page
  limit?: number;        // max URLs to return (10-200, default 50)
  include_external?: boolean; // include off-domain links (default false)
  country?: string;
  timeout?: number;
}

/**
 * Crawl a URL and return all internal links found on the page (and optionally
 * linked pages up to limit). This is a shallow map — it fetches the starting URL,
 * extracts all <a href> links, normalises them to absolute URLs, filters to the
 * same domain, and returns the list.
 *
 * For a full sitemap crawl, agents should call novada_proxy_map iteratively on
 * the discovered URLs or use the sitemap.xml directly.
 */
export async function novadaProxyMap(
  params: MapParams,
  adapter: ProxyAdapter,
  credentials: ProxyCredentials
): Promise<string> {
  const { url, limit = 50, include_external = false, country, timeout = 60 } = params;

  const startTime = Date.now();

  // Parse origin for relative-URL resolution and same-domain filtering
  let origin: string;
  let hostname: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    hostname = parsed.hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Fetch the starting page
  const fetchResultStr = await novadaProxyFetch(
    { url, format: "raw", country, timeout },
    adapter,
    credentials
  );

  let html: string;
  try {
    const fetchResult = JSON.parse(fetchResultStr) as ProxySuccessResponse;
    html = (fetchResult.data.content as string) || "";
  } catch {
    html = fetchResultStr;
  }

  // Extract all <a href> links.
  // INC-71: allow pagination links (?page=N, /page/N) — previously the [^"'#?] exclusion
  // dropped all query-string-only hrefs, making paginated sites invisible to the map tool.
  // We still skip bare fragments (#anchor) and javascript: hrefs.
  const hrefRe = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  const seen = new Set<string>();
  const internalUrls: string[] = [];
  const externalUrls: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    // Skip javascript: and mailto: pseudo-schemes
    if (/^(?:javascript|mailto|tel|data):/i.test(raw)) continue;

    let resolved: string;
    try {
      resolved = new URL(raw, origin).toString();
    } catch {
      continue; // skip malformed hrefs
    }

    // Normalise: strip trailing slash, fragments already excluded by regex
    resolved = resolved.replace(/\/$/, "");
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    // Strip query strings from internal links for cleaner output
    let resolvedHostname: string;
    try {
      resolvedHostname = new URL(resolved).hostname;
    } catch {
      continue;
    }

    if (resolvedHostname === hostname || resolvedHostname.endsWith(`.${hostname}`)) {
      internalUrls.push(resolved);
    } else if (include_external) {
      externalUrls.push(resolved);
    }
  }

  // Also check for sitemap.xml at the root
  const sitemapUrl = `${origin}/sitemap.xml`;
  const hasSitemap = !seen.has(sitemapUrl) ? `${sitemapUrl} (check manually — not on this page)` : null;

  // Apply limit
  const internal = internalUrls.slice(0, limit);
  const external = include_external ? externalUrls.slice(0, Math.max(0, limit - internal.length)) : [];

  const latency_ms = Date.now() - startTime;

  const result: ProxySuccessResponse = {
    ok: true,
    tool: "novada_proxy_map",
    data: {
      source_url: url,
      domain: hostname,
      internal_url_count: internal.length,
      external_url_count: external.length,
      total_found: internalUrls.length + (include_external ? externalUrls.length : 0),
      truncated: internalUrls.length > limit,
      internal_urls: internal,
      ...(include_external ? { external_urls: external } : {}),
      ...(hasSitemap ? { sitemap_hint: hasSitemap } : {}),
    },
    meta: {
      latency_ms,
      country,
      quota: { credits_estimated: 1, note: QUOTA_NOTE },
    },
  };

  if (!result.meta.country) delete result.meta.country;

  return JSON.stringify(result);
}

export function validateMapParams(raw: Record<string, unknown>): MapParams {
  if (!raw.url || typeof raw.url !== "string") {
    throw new Error("url is required and must be a string");
  }
  if (!raw.url.startsWith("http://") && !raw.url.startsWith("https://")) {
    throw new Error("url must start with http:// or https://");
  }

  const limit = raw.limit !== undefined ? Number(raw.limit) : 50;
  if (!Number.isFinite(limit) || limit < 10 || limit > 200) {
    throw new Error("limit must be between 10 and 200");
  }

  if (raw.country !== undefined) {
    if (typeof raw.country !== "string" || raw.country.length > 10 || !SAFE_COUNTRY.test(raw.country)) {
      throw new Error("country must be a 2-letter ISO code with no hyphens (e.g. US, DE, GB)");
    }
  }

  const timeout = raw.timeout !== undefined ? Number(raw.timeout) : 60;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
    throw new Error("timeout must be between 1 and 120 seconds");
  }

  return {
    url: raw.url,
    limit,
    include_external: raw.include_external === true,
    country: raw.country as string | undefined,
    timeout,
  };
}

import { vi, describe, it, expect, beforeEach } from "vitest";
import { novadaProxyMap, validateMapParams } from "../src/tools/map.js";
import type { ProxyAdapter, ProxyCredentials } from "../src/adapters/index.js";
import type { ProxySuccessResponse } from "../src/types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { novadaProxyFetchSpy } = vi.hoisted(() => ({
  novadaProxyFetchSpy: vi.fn(),
}));

vi.mock("../src/tools/fetch.js", () => ({
  novadaProxyFetch: novadaProxyFetchSpy,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockAdapter: ProxyAdapter = {
  name: "test",
  displayName: "Test",
  lastVerified: "2026-01-01",
  capabilities: { country: true, city: true, sticky: true },
  credentialDocs: "test",
  sensitiveFields: ["pass"] as readonly string[],
  loadCredentials: () => ({ user: "u", pass: "p", host: "h", port: "7777" }),
  buildProxyUrl: () => "http://u:p@h:7777",
};

const mockCreds: ProxyCredentials = { user: "u", pass: "p", host: "h", port: "7777" };

function makeFetchResponse(url: string, html: string): string {
  return JSON.stringify({
    ok: true,
    tool: "novada_proxy_fetch",
    data: {
      url,
      status_code: 200,
      content: html,
    },
    meta: {
      latency_ms: 50,
      cache_hit: false,
      truncated: false,
      quota: { credits_estimated: 1 },
    },
  });
}

// ─── validateMapParams ───────────────────────────────────────────────────────

describe("validateMapParams", () => {
  it("accepts valid url with defaults", () => {
    const p = validateMapParams({ url: "https://example.com" });
    expect(p.url).toBe("https://example.com");
    expect(p.limit).toBe(50);
    expect(p.include_external).toBe(false);
    expect(p.timeout).toBe(60);
  });

  it("rejects missing url", () => {
    expect(() => validateMapParams({})).toThrow("url is required");
  });

  it("rejects non-http url", () => {
    expect(() => validateMapParams({ url: "ftp://example.com" })).toThrow(
      "url must start with http://"
    );
  });

  it("rejects limit below 10", () => {
    expect(() =>
      validateMapParams({ url: "https://example.com", limit: 5 })
    ).toThrow("limit must be between 10 and 200");
  });

  it("rejects limit above 200", () => {
    expect(() =>
      validateMapParams({ url: "https://example.com", limit: 300 })
    ).toThrow("limit must be between 10 and 200");
  });

  it("rejects country with hyphens", () => {
    expect(() =>
      validateMapParams({ url: "https://example.com", country: "us-east" })
    ).toThrow("country must be a 2-letter ISO code");
  });

  it("rejects timeout out of range", () => {
    expect(() =>
      validateMapParams({ url: "https://example.com", timeout: 0 })
    ).toThrow("timeout must be between 1 and 120");

    expect(() =>
      validateMapParams({ url: "https://example.com", timeout: 121 })
    ).toThrow("timeout must be between 1 and 120");
  });

  it("accepts valid country code", () => {
    const p = validateMapParams({ url: "https://example.com", country: "US" });
    expect(p.country).toBe("US");
  });

  it("passes include_external through", () => {
    const p = validateMapParams({ url: "https://example.com", include_external: true });
    expect(p.include_external).toBe(true);
  });
});

// ─── novadaProxyMap ───────────────────────────────────────────────────────────

describe("novadaProxyMap", () => {
  beforeEach(() => {
    novadaProxyFetchSpy.mockReset();
  });

  it("extracts internal links from HTML", async () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
      <a href="/blog">Blog</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("novada_proxy_map");
    expect(result.data.domain).toBe("example.com");
    expect(result.data.internal_url_count).toBe(3);
    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://example.com/about");
    expect(urls).toContain("https://example.com/contact");
    expect(urls).toContain("https://example.com/blog");
  });

  it("excludes external links by default", async () => {
    const html = `<html><body>
      <a href="/local">Local</a>
      <a href="https://other.com/page">External</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.data.internal_url_count).toBe(1);
    expect(result.data.external_url_count).toBe(0);
    expect(result.data).not.toHaveProperty("external_urls");
  });

  it("includes external URLs when include_external is true", async () => {
    const html = `<html><body>
      <a href="/local">Local</a>
      <a href="https://other.com/page">External</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com", include_external: true },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.data.internal_url_count).toBe(1);
    expect(result.data.external_url_count).toBe(1);
    const external = result.data.external_urls as string[];
    expect(external).toContain("https://other.com/page");
  });

  it("caps results at the limit parameter", async () => {
    // Generate more links than the limit
    const links = Array.from({ length: 30 }, (_, i) =>
      `<a href="/page${i}">Page ${i}</a>`
    ).join("\n");
    const html = `<html><body>${links}</body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com", limit: 10 },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls.length).toBe(10);
    expect(result.data.truncated).toBe(true);
    expect(result.data.total_found).toBe(30);
  });

  it("resolves relative URLs to absolute", async () => {
    const html = `<html><body>
      <a href="/path/to/page">Relative</a>
      <a href="subpage">Also relative</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com/base/", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com/base/" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://example.com/path/to/page");
    // "subpage" resolves against origin (https://example.com), not the path
    expect(urls).toContain("https://example.com/subpage");
  });

  it("deduplicates URLs", async () => {
    const html = `<html><body>
      <a href="/about">About 1</a>
      <a href="/about">About 2</a>
      <a href="/about/">About 3 with trailing slash</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    // /about and /about/ both normalise to "https://example.com/about" (trailing slash stripped)
    const urls = result.data.internal_urls as string[];
    expect(urls.length).toBe(1);
    expect(urls[0]).toBe("https://example.com/about");
  });

  it("throws on invalid URL", async () => {
    await expect(
      novadaProxyMap(
        { url: "not-a-url" },
        mockAdapter,
        mockCreds
      )
    ).rejects.toThrow("Invalid URL");
  });

  it("returns correct response format", async () => {
    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", "<html><body></body></html>")
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw);

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("tool", "novada_proxy_map");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("meta");
    expect(result.data).toHaveProperty("source_url", "https://example.com");
    expect(result.data).toHaveProperty("domain", "example.com");
    expect(result.meta).toHaveProperty("latency_ms");
    expect(result.meta).toHaveProperty("quota");
  });

  it("includes sitemap_hint when sitemap URL not found on page", async () => {
    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", "<html><body>No links</body></html>")
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.data.sitemap_hint).toContain("sitemap.xml");
  });

  it("handles page with no links", async () => {
    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", "<html><body>No links here</body></html>")
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.data.internal_url_count).toBe(0);
    expect(result.data.internal_urls).toEqual([]);
  });

  it("treats subdomains as internal links", async () => {
    const html = `<html><body>
      <a href="https://blog.example.com/post">Blog post</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://blog.example.com/post");
  });

  it("omits country from meta when not provided", async () => {
    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", "<html><body></body></html>")
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    expect(result.meta.country).toBeUndefined();
  });
});

// ─── INC-71: map.ts pagination + nested-tag link support ─────────────────────

describe("INC-71: novadaProxyMap — pagination and nested-tag link support", () => {
  beforeEach(() => {
    novadaProxyFetchSpy.mockReset();
  });

  it("extracts ?page=N pagination links", async () => {
    const html = `<html><body>
      <a href="?page=2">Next page</a>
      <a href="?page=3">Page 3</a>
      <a href="/article">Article</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com/blog", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com/blog" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    // Pagination hrefs should now be included
    expect(urls.some(u => u.includes("page=2"))).toBe(true);
    expect(urls.some(u => u.includes("page=3"))).toBe(true);
    expect(urls).toContain("https://example.com/article");
  });

  it("extracts /page/N path-based pagination links", async () => {
    const html = `<html><body>
      <a href="/page/2">Next</a>
      <a href="/page/5">Last</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://example.com/page/2");
    expect(urls).toContain("https://example.com/page/5");
  });

  it("extracts links nested inside <li>, <div>, and <span> tags", async () => {
    const html = `<html><body>
      <ul>
        <li><a href="/item1">Item 1</a></li>
        <li class="nav-item"><a href="/item2">Item 2</a></li>
      </ul>
      <div class="content-block" data-id="main">
        <span><a href="/deep-link">Deep</a></span>
      </div>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://example.com/item1");
    expect(urls).toContain("https://example.com/item2");
    expect(urls).toContain("https://example.com/deep-link");
  });

  it("skips javascript: hrefs", async () => {
    const html = `<html><body>
      <a href="javascript:void(0)">JS click</a>
      <a href="/valid-page">Valid</a>
    </body></html>`;

    novadaProxyFetchSpy.mockResolvedValueOnce(
      makeFetchResponse("https://example.com", html)
    );

    const raw = await novadaProxyMap(
      { url: "https://example.com" },
      mockAdapter,
      mockCreds
    );
    const result = JSON.parse(raw) as ProxySuccessResponse;

    const urls = result.data.internal_urls as string[];
    expect(urls).toContain("https://example.com/valid-page");
    // javascript: resolved against origin would produce an odd URL — ensure it's excluded
    expect(urls.some(u => u.includes("javascript"))).toBe(false);
  });
});

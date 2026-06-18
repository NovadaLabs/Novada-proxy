import { describe, it, expect } from "vitest";
import { htmlToMarkdown, htmlToText, unicodeSafeTruncate, stripNoiseElements, countHtmlTags, contentDensity } from "../src/utils.js";

describe("unicodeSafeTruncate", () => {
  it("returns short strings unchanged", () => {
    expect(unicodeSafeTruncate("hello", 10)).toBe("hello");
  });

  it("truncates to maxChars", () => {
    expect(unicodeSafeTruncate("abcdef", 3)).toBe("abc");
  });

  it("handles emoji (multi-byte) correctly", () => {
    const emoji = "Hello 🌍🌎🌏";
    // Each emoji = 2 UTF-16 code units (surrogate pair). maxChars=8 lands
    // on the low surrogate of 🌍 → backs up by 2, dropping the whole pair
    expect(unicodeSafeTruncate(emoji, 8)).toBe("Hello ");
    // maxChars=6 lands on ASCII space → no surrogate issue
    expect(unicodeSafeTruncate(emoji, 6)).toBe("Hello ");
    // maxChars=7 lands on high surrogate of 🌍 → backs up by 1
    expect(unicodeSafeTruncate(emoji, 7)).toBe("Hello ");
  });

  it("does not split surrogate pair when boundary is on low surrogate", () => {
    // "AB🌍" = [A, B, 0xD83C, 0xDF0D] — 4 code units
    // maxChars=3 → index 2 is high surrogate → end-- → "AB"
    expect(unicodeSafeTruncate("AB🌍", 3)).toBe("AB");
    // maxChars=4 → full string fits (length === maxChars)
    expect(unicodeSafeTruncate("AB🌍", 4)).toBe("AB🌍");
  });
});

describe("htmlToMarkdown", () => {
  it("strips script tags", () => {
    expect(htmlToMarkdown("<p>Hello</p><script>alert(1)</script>")).not.toContain("alert");
  });

  it("strips style tags", () => {
    expect(htmlToMarkdown("<style>.x{color:red}</style><p>Hello</p>")).not.toContain("color");
  });

  it("strips noscript tags", () => {
    expect(htmlToMarkdown("<noscript>JS disabled</noscript><p>Hello</p>")).not.toContain("JS disabled");
  });

  it("converts headings", () => {
    const md = htmlToMarkdown("<h1>Title</h1><h2>Sub</h2>");
    expect(md).toContain("# Title");
    expect(md).toContain("## Sub");
  });

  it("converts links", () => {
    const md = htmlToMarkdown('<a href="https://example.com">Link</a>');
    expect(md).toContain("[Link](https://example.com)");
  });

  it("converts list items", () => {
    const md = htmlToMarkdown("<ul><li>One</li><li>Two</li></ul>");
    expect(md).toContain("- One");
    expect(md).toContain("- Two");
  });

  it("decodes HTML entities", () => {
    const md = htmlToMarkdown("<p>&amp; &lt; &gt; &quot;</p>");
    expect(md).toContain("& < > \"");
  });

  it("collapses excessive newlines", () => {
    const md = htmlToMarkdown("<p>A</p><p></p><p></p><p>B</p>");
    expect(md).not.toContain("\n\n\n");
  });

  it("strips data: and javascript: URIs from links", () => {
    expect(htmlToMarkdown('<a href="data:text/html,<script>alert(1)</script>">click</a>')).toContain("click");
    expect(htmlToMarkdown('<a href="data:text/html,<script>alert(1)</script>">click</a>')).not.toContain("data:");
    expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a>')).toContain("click");
    expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a>')).not.toContain("javascript:");
  });
});

describe("htmlToText", () => {
  it("strips links but keeps text", () => {
    const text = htmlToText('<a href="http://x.com">Click</a>');
    expect(text).toContain("Click");
    expect(text).not.toContain("http://x.com");
  });

  it("strips heading markers", () => {
    const text = htmlToText("<h1>Title</h1>");
    expect(text).toContain("Title");
    expect(text).not.toContain("#");
  });
});

describe("stripNoiseElements", () => {
  it("strips <nav> elements and their content", () => {
    const html = '<nav><a href="/">Home</a><a href="/about">About</a></nav><p>Main content</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Home");
    expect(result).not.toContain("About");
    expect(result).toContain("Main content");
  });

  it("strips <header> elements and their content", () => {
    const html = '<header><h1>Site Logo</h1></header><article><p>Article text</p></article>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Site Logo");
    expect(result).toContain("Article text");
  });

  it("strips <footer> elements and their content", () => {
    const html = '<p>Content here</p><footer><p>Copyright 2026</p></footer>';
    const result = stripNoiseElements(html);
    expect(result).toContain("Content here");
    expect(result).not.toContain("Copyright");
  });

  it("strips <aside> elements and their content", () => {
    const html = '<aside><p>Sidebar widget</p></aside><main><p>Main text</p></main>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Sidebar widget");
    expect(result).toContain("Main text");
  });

  it("strips <form> elements and their content", () => {
    const html = '<form><input type="text" /><button>Submit</button></form><p>Real content</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Submit");
    expect(result).toContain("Real content");
  });

  it("strips elements with noise class patterns", () => {
    const html = '<div class="cookie-banner">Accept cookies</div><p>Article body</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Accept cookies");
    expect(result).toContain("Article body");
  });

  it("strips elements with noise id patterns", () => {
    const html = '<div id="comments-section">User comments here</div><p>Main article</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("User comments");
    expect(result).toContain("Main article");
  });

  it("strips elements with social-share class", () => {
    const html = '<div class="social-share"><a>Share on X</a></div><p>Content</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Share on X");
    expect(result).toContain("Content");
  });

  it("strips hidden elements with display:none", () => {
    const html = '<div style="display:none">Hidden text</div><p>Visible text</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Hidden text");
    expect(result).toContain("Visible text");
  });

  it("strips hidden elements with aria-hidden=true", () => {
    const html = '<span aria-hidden="true">Screen reader hidden</span><p>Visible</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Screen reader hidden");
    expect(result).toContain("Visible");
  });

  it("strips empty divs and spans", () => {
    const html = '<div>   </div><div class="spacer">  </div><p>Content</p>';
    const result = stripNoiseElements(html);
    expect(result).toContain("Content");
    // Empty divs should be removed
    expect(result).not.toMatch(/<div[^>]*>\s*<\/div>/);
  });

  it("preserves real content in <main>, <article>, <section>", () => {
    const html = '<main><section><h1>Title</h1><p>Important paragraph</p></section></main>';
    const result = stripNoiseElements(html);
    expect(result).toContain("Title");
    expect(result).toContain("Important paragraph");
  });

  it("preserves content in divs without noise classes", () => {
    const html = '<div class="content-wrapper"><p>This is real content</p></div>';
    const result = stripNoiseElements(html);
    expect(result).toContain("This is real content");
  });

  it("handles nested noise elements", () => {
    const html = '<nav><div class="nav-inner"><ul><li>Home</li><li>About</li></ul></div></nav><p>Body</p>';
    const result = stripNoiseElements(html);
    expect(result).not.toContain("Home");
    expect(result).toContain("Body");
  });
});

describe("htmlToMarkdown — whitespace cleanup", () => {
  it("collapses 3+ consecutive newlines to 2", () => {
    const html = "<p>First</p><p></p><p></p><p></p><p>Second</p>";
    const md = htmlToMarkdown(html);
    expect(md).not.toContain("\n\n\n");
    expect(md).toContain("First");
    expect(md).toContain("Second");
  });

  it("removes lines that are only dashes (visual separators)", () => {
    // Simulate separators that would remain after tag stripping
    const html = "<p>Above</p><p>---</p><p>Below</p>";
    const md = htmlToMarkdown(html);
    expect(md).not.toMatch(/^-{3,}$/m);
    expect(md).toContain("Above");
    expect(md).toContain("Below");
  });

  it("removes lines that are only underscores (visual separators)", () => {
    const html = "<p>Above</p><p>_____</p><p>Below</p>";
    const md = htmlToMarkdown(html);
    expect(md).not.toMatch(/^_{3,}$/m);
  });

  it("trims trailing whitespace per line", () => {
    // Test with content that would produce trailing spaces
    const md = htmlToMarkdown("<p>Hello   </p><p>World</p>");
    const lines = md.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe("htmlToMarkdown — noise removal integration", () => {
  it("strips nav/header/footer before converting to markdown", () => {
    const html = `
      <header><h1>Logo</h1></header>
      <nav><a href="/">Home</a></nav>
      <main><h2>Article Title</h2><p>Article content here.</p></main>
      <footer><p>Copyright</p></footer>
    `;
    const md = htmlToMarkdown(html);
    expect(md).not.toContain("Logo");
    expect(md).not.toContain("Copyright");
    expect(md).toContain("## Article Title");
    expect(md).toContain("Article content here.");
  });
});

describe("countHtmlTags", () => {
  it("counts opening tags", () => {
    expect(countHtmlTags("<p>Hello</p><div><span>World</span></div>")).toBe(3);
  });

  it("returns 0 for no tags", () => {
    expect(countHtmlTags("Just plain text")).toBe(0);
  });

  it("counts self-closing tags", () => {
    expect(countHtmlTags('<img src="x.png" /><br />')).toBe(2);
  });
});

describe("contentDensity", () => {
  it("returns high density for text-heavy content", () => {
    // 1000 chars of text, 10 tags → 1000/(1000+100) = 0.91
    const density = contentDensity(1000, 10);
    expect(density).toBeGreaterThan(0.8);
  });

  it("returns low density for tag-heavy content", () => {
    // 100 chars of text, 200 tags → 100/(100+2000) = 0.048
    const density = contentDensity(100, 200);
    expect(density).toBeLessThan(0.1);
  });

  it("returns 0 for empty content", () => {
    expect(contentDensity(0, 0)).toBe(0);
  });

  it("returns 1.0 for text with no tags", () => {
    // 500 chars, 0 tags → 500/(500+0) = 1.0
    expect(contentDensity(500, 0)).toBe(1);
  });
});

// ─── INC-70: O(n²) → O(n log n) noise filter correctness ─────────────────────

describe("INC-70: stripNoiseElements O(n log n) — correctness with many noise elements", () => {
  it("removes multiple noise divs in a single pass without leaving residual fragments", () => {
    // Build a document with N noise divs followed by real content
    const noiseDivs = Array.from({ length: 20 }, (_, i) =>
      `<div class="cookie-banner">Cookie notice ${i}</div>`
    ).join("\n");
    const html = `${noiseDivs}\n<p>Article body</p>`;
    const result = stripNoiseElements(html);

    expect(result).toContain("Article body");
    expect(result).not.toContain("Cookie notice");
    // No partial noise div tags left behind
    expect(result).not.toMatch(/cookie-banner/i);
  });

  it("removes noise elements interleaved with content elements", () => {
    const html = `
      <div class="advertisement">Ad 1</div>
      <p>Real paragraph 1</p>
      <div class="sidebar">Sidebar content</div>
      <p>Real paragraph 2</p>
      <div class="modal">Modal popup</div>
      <p>Real paragraph 3</p>
    `;
    const result = stripNoiseElements(html);

    expect(result).toContain("Real paragraph 1");
    expect(result).toContain("Real paragraph 2");
    expect(result).toContain("Real paragraph 3");
    expect(result).not.toContain("Ad 1");
    expect(result).not.toContain("Sidebar content");
    expect(result).not.toContain("Modal popup");
  });

  it("handles n=50 noise elements without exponential slowdown", () => {
    // Performance guard: 50 noise divs should complete well under 1 second
    const noiseDivs = Array.from({ length: 50 }, (_, i) =>
      `<div class="nav-bar">Nav item ${i}</div>`
    ).join("");
    const html = `${noiseDivs}<article><p>Main content</p></article>`;

    const start = Date.now();
    const result = stripNoiseElements(html);
    const elapsed = Date.now() - start;

    expect(result).toContain("Main content");
    expect(result).not.toContain("Nav item");
    // Should complete in <500ms even on slow CI (O(n log n) vs O(n²))
    expect(elapsed).toBeLessThan(500);
  });

  it("correctly removes nested noise elements at any depth", () => {
    const html = `
      <div class="cookie-consent">
        <div>Inner div 1<div>Deepest</div></div>
        <p>Inner paragraph</p>
      </div>
      <p>Preserved content</p>
    `;
    const result = stripNoiseElements(html);
    expect(result).toContain("Preserved content");
    expect(result).not.toContain("Inner div");
    expect(result).not.toContain("Deepest");
    expect(result).not.toContain("Inner paragraph");
  });
});

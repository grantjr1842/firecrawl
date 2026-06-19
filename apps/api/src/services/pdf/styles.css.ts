// Default PDF stylesheet for the scrape-to-PDF renderer.
//
// Design intent: a complete, accurate, visually elegant document. Paged-media
// features (named pages, running headers, page counters) are first-class so
// the rendered PDF feels like a publication rather than a print of HTML.
// Fonts are system-only — no CDN, no @font-face data URIs — so the renderer
// is fully offline.

export const stylesCss: string = `/* ------------------------------------------------------------------ */
/* Tokens                                                            */
/* ------------------------------------------------------------------ */
:root {
  --bg: #fafaf9;
  --text: #1c1917;
  --muted: #78716c;
  --accent: #b85c38;
  --rule: #e7e5e4;
  --code-bg: #f5f5f4;
}

/* ------------------------------------------------------------------ */
/* Base                                                              */
/* ------------------------------------------------------------------ */
html, body {
  background: var(--bg);
  color: var(--text);
  font-family: "Source Serif Pro", "Charter", "Iowan Old Style",
               "Apple Garamond", Georgia, "Times New Roman", serif;
  font-size: 11pt;
  line-height: 1.7;
  margin: 0;
  padding: 0;
}

* { box-sizing: border-box; }

p { margin: 0 0 0.9em 0; }

a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid rgba(184, 92, 56, 0.35);
  overflow-wrap: break-word;
}

hr {
  border: none;
  border-top: 1px solid var(--rule);
  margin: 2em 0;
}

/* ------------------------------------------------------------------ */
/* Headings                                                          */
/* ------------------------------------------------------------------ */
h1, h2, h3, h4, h5, h6 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  color: var(--text);
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  page-break-after: avoid;
}

h1 { font-size: 22pt; letter-spacing: -0.01em; }
h2 { font-size: 17pt; }
h3 { font-size: 14pt; }
h4 { font-size: 12pt; }
h5 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em; }
h6 { font-size: 11pt; color: var(--muted); }

/* Drop cap on the first paragraph after each h2 — gives long-form content
   a magazine-style opening without modifying user markdown.
   NOTE: disabled because weasyprint 67.0 has a layout bug in
   _in_flow_layout when ::first-letter uses float: left together with
   the rest of the page-box model. Re-enable when upstream fixes the
   regression. The elegant headline accent is preserved via the
   .accent-rule on the cover page and the heavy h1/h2 weights below.
   section > h2 + p::first-letter,
   section > h3 + p::first-letter {
     font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
     color: var(--accent);
     font-size: 3.2em;
     line-height: 0.9;
     float: left;
     padding: 0.05em 0.12em 0 0;
     font-weight: 700;
   }
*/

/* ------------------------------------------------------------------ */
/* Code & pre                                                        */
/* ------------------------------------------------------------------ */
code, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", "Menlo",
               "Consolas", "Liberation Mono", monospace;
  font-size: 10pt;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 4px;
}

pre {
  font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", "Menlo",
               "Consolas", "Liberation Mono", monospace;
  font-size: 9.5pt;
  line-height: 1.55;
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 14px 16px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  page-break-inside: avoid;
}

pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

/* ------------------------------------------------------------------ */
/* Tables                                                            */
/* ------------------------------------------------------------------ */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.2em 0;
  font-size: 10pt;
  page-break-inside: avoid;
}

thead { display: table-header-group; }

th, td {
  border: 1px solid var(--rule);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

th {
  background: #f5f5f4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-weight: 600;
  color: var(--text);
}

tbody tr:nth-child(even) td { background: #fafaf9; }

/* ------------------------------------------------------------------ */
/* Block elements                                                    */
/* ------------------------------------------------------------------ */
blockquote {
  margin: 1.2em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--accent);
  color: #44403c;
  font-style: italic;
  background: rgba(184, 92, 56, 0.04);
  page-break-inside: avoid;
}

ul, ol { margin: 0.8em 0 0.8em 1.4em; padding: 0; }
li { margin: 0.25em 0; }

img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em auto;
  page-break-inside: avoid;
}

figure {
  margin: 1.2em 0;
  page-break-inside: avoid;
}
figcaption {
  font-size: 9.5pt;
  color: var(--muted);
  text-align: center;
  margin-top: 0.4em;
}

/* ------------------------------------------------------------------ */
/* Cover page                                                        */
/* ------------------------------------------------------------------ */
.cover {
  page: cover;
  page-break-after: always;
  text-align: center;
  padding-top: 70mm;
}

.cover .eyebrow {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  color: var(--accent);
  margin-bottom: 24px;
}

.cover h1.title {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 36pt;
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text);
  margin: 0 0 18px 0;
  max-width: 160mm;
  margin-left: auto;
  margin-right: auto;
}

.cover .subtitle {
  font-size: 13pt;
  line-height: 1.5;
  color: var(--muted);
  max-width: 130mm;
  margin: 0 auto 36px auto;
}

.cover .meta {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 9.5pt;
  color: var(--muted);
  margin-top: 60mm;
}

.cover .meta .source-url {
  color: var(--accent);
  overflow-wrap: anywhere;
  border-bottom: 1px solid rgba(184, 92, 56, 0.4);
  /* Capture the URL into the source-url named string so the @bottom-left
     running footer on every subsequent page can render it via
     string(source-url). The element must be in flow (not display:none
     or position:absolute) for WeasyPrint to pick it up. */
  string-set: source-url content();
}

.cover .accent-rule {
  width: 50mm;
  height: 2px;
  background: var(--accent);
  margin: 0 auto 24px auto;
}

/* ------------------------------------------------------------------ */
/* Table of contents                                                 */
/* ------------------------------------------------------------------ */
.toc {
  page: toc;
  page-break-after: always;
  padding-top: 6mm;
}

.toc h1 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 22pt;
  margin-top: 0;
  margin-bottom: 18px;
  border-bottom: 2px solid var(--accent);
  padding-bottom: 8px;
}

.toc .toc-body {
  counter-reset: toc-item;
}

.toc ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc li {
  counter-increment: toc-item;
  margin: 6px 0;
  display: flex;
  align-items: baseline;
  border-bottom: 1px dotted var(--rule);
  padding-bottom: 4px;
}

.toc li::before {
  content: counter(toc-item, decimal-leading-zero) ".";
  font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", monospace;
  color: var(--accent);
  font-size: 9.5pt;
  min-width: 28px;
  flex: 0 0 auto;
}

.toc li a {
  flex: 1 1 auto;
  color: var(--text);
  border: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt;
}

.toc li a::after {
  content: leader('.') target-counter(attr(href), page);
  color: var(--muted);
  font-size: 9.5pt;
  margin-left: 8px;
}

/* ------------------------------------------------------------------ */
/* Body                                                              */
/* ------------------------------------------------------------------ */
.body {
  page: body;
}

.body > section {
  margin: 0;
  padding: 0;
}

.body h2:first-of-type,
.body h1:first-of-type {
  margin-top: 0;
}

/* ------------------------------------------------------------------ */
/* Appendices                                                        */
/* ------------------------------------------------------------------ */
.appendix {
  page: appendix;
  page-break-before: always;
}

.appendix h1 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
               "Helvetica Neue", Arial, sans-serif;
  font-size: 20pt;
  border-bottom: 2px solid var(--accent);
  padding-bottom: 8px;
  margin-top: 0;
}

.appendix ul.links {
  list-style: none;
  margin: 0;
  padding: 0;
}

.appendix ul.links li {
  border-bottom: 1px dotted var(--rule);
  padding: 6px 0;
  overflow-wrap: break-word;
}

.appendix .meta-table {
  font-size: 9.5pt;
}

.appendix .screenshot-block {
  text-align: center;
  page-break-inside: avoid;
  margin: 16px 0;
}

.appendix .screenshot-block img {
  max-height: 200mm;
  border: 1px solid var(--rule);
  border-radius: 6px;
}

.appendix pre.metadata-json {
  font-size: 8.5pt;
  max-height: 140mm;
  overflow: hidden;
}

/* ------------------------------------------------------------------ */
/* @page rules                                                       */
/* ------------------------------------------------------------------ */
@page {
  size: A4;
  margin: 22mm 18mm 22mm 18mm;

  @bottom-left {
    content: string(source-url);
    font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
    color: #78716c;
  }
  @bottom-right {
    content: counter(page) " / " counter(pages);
    font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
    color: #78716c;
  }
}

/* The first page of the document is also the named "cover" page; we let
   the @page cover rule below handle it exclusively. Using @page :first
   here alongside @page cover was triggering WeasyPrint to render the
   cover content twice in some configurations (the cover's hidden
   span was being painted onto subsequent pages). */

@page cover {
  margin: 0;
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

@page toc {
  margin: 24mm 18mm;
  @bottom-right {
    content: "Table of Contents - " counter(page);
    font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
    color: #78716c;
  }
}

@page appendix {
  margin: 22mm 18mm;
  @bottom-left {
    content: string(source-url);
    font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
    color: #78716c;
  }
  @bottom-right {
    content: "Appendix " counter(page) " / " counter(pages);
    font: 8pt -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter",
                  "Helvetica Neue", Arial, sans-serif;
    color: #78716c;
  }
}
`;

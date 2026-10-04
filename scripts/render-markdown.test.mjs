import assert from 'node:assert/strict'
import test from 'node:test'
import { renderInline, renderMarkdownPage } from './render-markdown.mjs'

function renderBody(markdownText) {
  return /<main>\n([\s\S]*)\n<\/main>/.exec(renderMarkdownPage(markdownText, 'fallback'))[1]
}

test('escapes raw HTML instead of passing it through', () => {
  assert.equal(renderInline('<script>alert(1)</script> & "quoted"'), '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;')
})

test('links only http and https targets', () => {
  assert.equal(renderInline('[fare](https://airline.example/a?b=1&c=2)'), '<a href="https://airline.example/a?b=1&amp;c=2" rel="noopener noreferrer">fare</a> <span class="link-host">(airline.example)</span>')
  assert.equal(renderInline('[click](javascript:alert(1))'), 'click)')
  assert.equal(renderInline('[click](data:text/html,x)'), 'click')
})

test('a quote inside a link target cannot break out of the attribute', () => {
  assert.equal(renderInline('[x](https://a.com/"onmouseover="alert(1))'), '<a href="https://a.com/%22onmouseover=%22alert(1" rel="noopener noreferrer">x</a> <span class="link-host">(a.com)</span>)')
})

test('links bare URLs without swallowing trailing punctuation', () => {
  assert.equal(renderInline('see https://posthog.com/docs.'), 'see <a href="https://posthog.com/docs" rel="noopener noreferrer">https://posthog.com/docs</a>.')
})

test('renders emphasis, strikethrough, and code spans without formatting inside code', () => {
  assert.equal(renderInline('**bold** *it* ~~old~~ `a**b**`'), '<strong>bold</strong> <em>it</em> <del>old</del> <code>a**b**</code>')
})

test('leaves underscores inside words alone', () => {
  assert.equal(renderInline('MARKDOWN_CONTENT_PATHS and snake_case_name'), 'MARKDOWN_CONTENT_PATHS and snake_case_name')
})

test('renders headings, paragraphs, and a rule', () => {
  assert.equal(renderBody('# Title\n\nline one\nline two\n\n---\n\n## Next'), '<h1>Title</h1>\n<p>line one line two</p>\n<hr>\n<h2>Next</h2>')
})

test('renders nested bullet lists and ordered lists', () => {
  assert.equal(renderBody('- one\n  - inner\n- two\n\n1. first\n2. second'), '<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>')
})

test('renders a fenced code block verbatim and escaped', () => {
  assert.equal(renderBody('```js\nconst a = "<b>"\n```'), '<pre><code>const a = &quot;&lt;b&gt;&quot;</code></pre>')
})

test('renders a blockquote', () => {
  assert.equal(renderBody('> quoted **text**'), '<blockquote><p>quoted <strong>text</strong></p></blockquote>')
})

test('renders frontmatter as a metadata block and titles the page from the first heading', () => {
  const pageHtml = renderMarkdownPage('---\nquestion: Which <fare>?\nasked: 2026-09-28\n---\n\n## Answer\n', 'fallback')
  assert.match(pageHtml, /<div class="metadata"><div><strong>question:<\/strong> Which &lt;fare&gt;\?<\/div><div><strong>asked:<\/strong> 2026-09-28<\/div><\/div>/)
  assert.match(pageHtml, /<title>Answer<\/title>/)
})

test('falls back to the file name for a page with no heading', () => {
  assert.match(renderMarkdownPage('plain text', '2026-09-28-tasks'), /<title>2026-09-28-tasks<\/title>/)
})

test('a link nested after a bare URL never lands inside the outer href', () => {
  const html = renderInline('https://a.com/[x](https://b/onmouseover=alert(1)//)')
  assert.doesNotMatch(html, /href="[^"]*</)
  assert.equal(html, '<a href="https://a.com/" rel="noopener noreferrer">https://a.com/</a><a href="https://b/onmouseover=alert(1" rel="noopener noreferrer">x</a> <span class="link-host">(b)</span>//)')
})

test('a code span inside a link target never lands inside an href', () => {
  assert.equal(renderInline('[x](https://a.com/`c`)'), '[x](<a href="https://a.com/" rel="noopener noreferrer">https://a.com/</a><code>c</code>)')
})

test('a code span inside link text still renders inside the anchor', () => {
  assert.equal(renderInline('[`code`](https://a.com)'), '<a href="https://a.com/" rel="noopener noreferrer"><code>code</code></a> <span class="link-host">(a.com)</span>')
})

test('a heading line padded with 20000 spaces renders in well under a second', () => {
  const renderStartMs = Date.now()
  assert.equal(renderBody('# a' + ' '.repeat(20000) + 'b'), `<h1>a${' '.repeat(20000)}b</h1>`)
  assert.ok(Date.now() - renderStartMs < 200)
})

test('strips a closing hash sequence from headings and the page title', () => {
  assert.equal(renderBody('## Next ##  '), '<h2>Next</h2>')
  assert.match(renderMarkdownPage('# Answer #\n', 'fallback'), /<title>Answer<\/title>/)
})

test('a loose ordered list stays one list across blank lines', () => {
  assert.equal(renderBody('1. a\n\n2. b\n\n3. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>')
})

test('an ordered list keeps its starting number', () => {
  assert.equal(renderBody('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>')
})

test('a bullet list and an ordered list separated by a blank line stay separate', () => {
  assert.equal(renderBody('- a\n\n1. b'), '<ul><li>a</li></ul>\n<ol><li>b</li></ol>')
})

test('a link whose label differs from its target shows the target host', () => {
  assert.equal(renderInline('[airline.example/checkin](https://airline-checkin.example/x)'), '<a href="https://airline-checkin.example/x" rel="noopener noreferrer">airline.example/checkin</a> <span class="link-host">(airline-checkin.example)</span>')
})

test('a link whose label is its target shows no host', () => {
  assert.equal(renderInline('[https://a.com](https://a.com)'), '<a href="https://a.com/" rel="noopener noreferrer">https://a.com</a>')
})

test('a link target that does not parse as a URL renders its label as plain text', () => {
  assert.equal(renderInline('[fare](https://[bad)'), 'fare')
})

test('the page style carries the muted link host rule', () => {
  assert.match(renderMarkdownPage('x', 'fallback'), /\.link-host \{ color: var\(--muted\);/)
})

test('an apostrophe before an at sign in a link target cannot spoof the shown host', () => {
  assert.equal(renderInline("[Bank](http://bank.com'@evil.com/x)"), 'Bank')
  assert.equal(renderInline("http://bank.com'@evil.com/x"), '<a href="http://bank.com/" rel="noopener noreferrer">http://bank.com</a>&#39;@evil.com/x')
})

test('a link target carrying a username or password renders its label as plain text', () => {
  assert.equal(renderInline('[Bank](https://bank.com@evil.com/)'), 'Bank')
  assert.equal(renderInline('[Bank](https://bank.com:secret@evil.com/)'), 'Bank')
})

test('a link target with an ampersand query keeps one escape in the href and the plain host', () => {
  assert.equal(renderInline('[fare](https://airline.example/a?b=1&c=2)'), '<a href="https://airline.example/a?b=1&amp;c=2" rel="noopener noreferrer">fare</a> <span class="link-host">(airline.example)</span>')
})

test('a double-quoted bare URL links without the quotes', () => {
  assert.equal(renderInline('He said "https://example.com/a" today'), 'He said &quot;<a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>&quot; today')
})

test('a single-quoted bare URL links without the quotes', () => {
  assert.equal(renderInline("He said 'https://example.com/a' today"), 'He said &#39;<a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>&#39; today')
})

test('a bare URL ends before an escaped angle bracket', () => {
  assert.equal(renderInline('<https://example.com/a>'), '&lt;<a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>&gt;')
})

test('a bare URL with an ampersand query keeps the full query', () => {
  assert.equal(renderInline('see https://example.com/a?a=1&b=2 now'), 'see <a href="https://example.com/a?a=1&amp;b=2" rel="noopener noreferrer">https://example.com/a?a=1&amp;b=2</a> now')
})

test('a bare URL followed by 20000 ampersands and quotes renders in well under a second', () => {
  const renderStartMs = Date.now()
  renderInline('https://example.com/' + '&"'.repeat(20000))
  renderInline(('https://a' + '&'.repeat(50)).repeat(2000) + '"')
  assert.ok(Date.now() - renderStartMs < 200)
})

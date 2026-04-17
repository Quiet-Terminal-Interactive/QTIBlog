const PATTERNS = {
    escape: [/\\([\\`*_{}\[\]()#+\-.!~^|])/g],
    inlineCode: [/`([^`]+)`/g],
    linkedImage: [/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g],
    image: [/!\[([^\]]*)\]\(([^)]+)\)/g],
    linkWithTitle: [/\[([^\]]+)\]\((\S+)\s+"([^"]+)"\)/g],
    link: [/\[([^\]]+)\]\(([^)]+)\)/g],
    refLink: [/\[([^\]]+)\]\[([^\]]+)\]/g],
    strikethrough: [/~~(?=\S)([\s\S]*?\S)~~/g],
    boldItalic: [/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g],
    bold: [/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g],
    italicStar: [/(?<!\*)\*(?!\s)([\s\S]*?\S)\*(?!\*)/g],
    italicUScore: [/(?<!_)_(?!\s)([\s\S]*?\S)_(?!_)/g],
    highlight: [/==(?=\S)([\s\S]*?\S)==/g],
    subscript: [/~(?!~)(?=\S)([\s\S]*?\S)~(?!~)/g],
    superscript: [/(?<!\[)\^(?=\S)([^^\]\n]+?)\^(?!\])/g],
};

function re(key) {
    const [r] = PATTERNS[key];
    return new RegExp(r.source, r.flags);
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(text) {
    return text.replace(/[&<>]/g, c => ESC_MAP[c]);
}

function classifyLine(line) {
    const t = line.trim();
    if (t === '') return { kind: 'empty' };
    const c0 = t.charCodeAt(0);
    if (c0 === 35 /*#*/) return { kind: 'heading' };
    if (c0 === 62 /*>*/) return { kind: 'quote' };
    if (t.startsWith('```')) return { kind: 'fence' };
    if (c0 === 124 /*|*/) return { kind: 'table' };
    const item = parseListItem(line);
    if (item !== null) return { kind: 'list', item };
    if (/^( {4}|\t)/.test(line)) return { kind: 'indented-code' };
    return { kind: 'paragraph' };
}

const TOKEN_START = '\uE000';
const TOKEN_END = '\uE001';

function resolveTokens(str, tokens) {
    let result = '';
    let i = 0;
    while (i < str.length) {
        const start = str.indexOf(TOKEN_START, i);
        if (start === -1) { result += str.slice(i); break; }
        result += str.slice(i, start);
        const end = str.indexOf(TOKEN_END, start + 1);
        if (end === -1) { result += str.slice(start); break; }
        const idx = Number(str.slice(start + 1, end));
        const tokenValue = tokens[idx] ?? '';
        result += resolveTokens(tokenValue, tokens);
        i = end + 1;
    }
    return result;
}

function convertInline(string, context = null) {
    const isRoot = context === null;
    const ctx = context || { tokens: [] };

    const stash = (html) => {
        const key = `${TOKEN_START}${ctx.tokens.length}${TOKEN_END}`;
        ctx.tokens.push(html);
        return key;
    };

    let c = string;
    c = c.replace(re('escape'), (_, ch) => stash(ch));
    c = c.replace(re('inlineCode'), (_, code) => stash(convertInlineCode(code)));
    c = c.replace(re('linkedImage'), (_, alt, src, href) =>
        stash(convertLinkedImage(src.trim(), normalizeAltText(alt), href.trim())));
    c = c.replace(re('image'), (_, alt, src) =>
        stash(convertImage(src.trim(), normalizeAltText(alt))));
    c = c.replace(re('linkWithTitle'), (_, text, href, title) =>
        stash(convertHyperlinkWithTitle(href.trim(), convertInline(text.trim(), ctx), title.trim())));
    c = c.replace(re('link'), (_, text, href) =>
        stash(convertHyperlink(href.trim(), convertInline(text.trim(), ctx))));
    c = c.replace(re('refLink'), (_, text, href) =>
        stash(convertReferenceLink(href.trim(), convertInline(text.trim(), ctx))));

    c = c.replace(re('strikethrough'), (_, text) => convertStrikethrough(convertInline(text, ctx)));
    c = c.replace(re('boldItalic'), (_, __, text) => convertBoldItalic(convertInline(text, ctx)));
    c = c.replace(re('bold'), (_, __, text) => convertBold(convertInline(text, ctx)));
    c = c.replace(re('italicStar'), (_, text) => convertItalic(convertInline(text, ctx)));
    c = c.replace(re('italicUScore'), (_, text) => convertItalic(convertInline(text, ctx)));
    c = c.replace(re('highlight'), (_, text) => convertHighlight(convertInline(text, ctx)));
    c = c.replace(re('subscript'), (_, text) => convertSubscript(convertInline(text, ctx)));
    c = c.replace(re('superscript'), (_, text) => convertSuperscript(convertInline(text, ctx)));

    if (!isRoot) return c;

    c = resolveTokens(c, ctx.tokens);
    return normalizeRepeatedTags(c);
}

function renderMarkdown(markdown) {
    const lines = markdown.split(/\r?\n/);
    const html = [];

    let i = 0;
    let inFence = false;
    let fenceLanguage = 'plaintext';
    let fenceLines = [];

    while (i < lines.length) {
        const line = lines[i];

        if (inFence) {
            if (/^```$/.test(line.trim())) {
                html.push(convertCodeBlock(escapeHtml(fenceLines.join('\n')), fenceLanguage));
                inFence = false;
                fenceLines = [];
            } else {
                fenceLines.push(line);
            }
            i++;
            continue;
        }

        const classified = classifyLine(line);

        switch (classified.kind) {
            case 'empty':
                i++;
                break;

            case 'fence': {
                const m = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
                inFence = true;
                fenceLanguage = (m && m[1]) || 'plaintext';
                fenceLines = [];
                i++;
                break;
            }

            case 'indented-code': {
                const codeLines = [];
                while (i < lines.length && /^( {4}|\t)/.test(lines[i])) {
                    codeLines.push(lines[i].replace(/^( {4}|\t)/, ''));
                    i++;
                }
                html.push(convertCodeBlock(escapeHtml(codeLines.join('\n')), 'plaintext'));
                break;
            }

            case 'heading':
            case 'paragraph': {
                html.push(renderBlockLine(line));
                i++;
                break;
            }

            case 'table': {
                if (i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
                    const headers = parseTableRow(line);
                    const alignments = parseTableAlignments(lines[i + 1], headers.length);
                    i += 2;
                    const rows = [];
                    while (i < lines.length && isTableRow(lines[i])) {
                        rows.push(parseTableRow(lines[i]));
                        i++;
                    }
                    html.push(convertTable(headers, rows, alignments));
                } else {
                    html.push(renderBlockLine(line));
                    i++;
                }
                break;
            }

            case 'list': {
                const rendered = renderList(lines, i, classified.item.indent, classified.item);
                html.push(rendered.html);
                i = rendered.nextIndex;
                break;
            }

            case 'quote': {
                const quoteLines = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) {
                    quoteLines.push(lines[i]);
                    i++;
                }
                html.push(renderQuoteLines(quoteLines));
                break;
            }

            default:
                html.push(renderBlockLine(line));
                i++;
        }
    }

    if (inFence) {
        html.push(convertCodeBlock(escapeHtml(fenceLines.join('\n')), fenceLanguage));
    }

    return html.join('');
}

const REPEATED_TAG_RE = [
    [/<strong>\s*<strong>/g, '<strong>'],
    [/<\/strong>\s*<\/strong>/g, '</strong>'],
    [/<em>\s*<em>/g, '<em>'],
    [/<\/em>\s*<\/em>/g, '</em>'],
];
function normalizeRepeatedTags(text) {
    let t = text;
    for (const [pattern, replacement] of REPEATED_TAG_RE) {
        t = t.replace(pattern, replacement);
    }
    return t;
}

function renderBlockLine(line, options = {}) {
    const allowParagraph = options.allowParagraph !== false;
    const trimmedLine = line.trim();
    if (trimmedLine === '') return '';

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) return convertHeading(headingMatch[1].length, convertInline(headingMatch[2].trim()));
    if (/^([-*_])\1{2,}$/.test(trimmedLine)) return convertHorizontalRule();
    if (/\\$/.test(line)) return `${convertInline(line.replace(/\\$/, '').trim())}${convertLineBreak()}`;
    if (allowParagraph) return convertParagraph(convertInline(trimmedLine));
    return convertInline(trimmedLine);
}

function parseListItem(line) {
    const taskMatch = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (taskMatch) return {
        type: 'task',
        indent: normalizeIndent(taskMatch[1]),
        checked: taskMatch[2].toLowerCase() === 'x',
        content: taskMatch[3],
    };

    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (orderedMatch) return { type: 'ol', indent: normalizeIndent(orderedMatch[1]), content: orderedMatch[2] };

    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unorderedMatch) return { type: 'ul', indent: normalizeIndent(unorderedMatch[1]), content: unorderedMatch[2] };

    return null;
}

function renderQuoteLines(lines) {
    const stripped = lines.map(line => line.replace(/^\s*>\s?/, ''));
    return convertBlockQuote(renderMarkdown(stripped.join('\n')));
}

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isTableSeparator(line) { return /^\s*\|[\s:|-]+\|\s*$/.test(line); }

function parseTableRow(line) {
    return line.trim().slice(1, -1).split('|').map(cell => cell.trim());
}

function parseTableAlignments(separatorLine, columnCount) {
    const raw = parseTableRow(separatorLine);
    const alignments = [];
    for (let i = 0; i < columnCount; i++) {
        const col = (raw[i] || '').trim();
        if (/^:-+:$/.test(col)) alignments.push('center');
        else if (/^-+:$/.test(col)) alignments.push('right');
        else if (/^:-+$/.test(col)) alignments.push('left');
        else alignments.push('');
    }
    return alignments;
}

function convertTable(headers, rows, alignments) {
    const th = headers.map((header, i) => {
        const align = alignments[i] ? ` style="text-align:${alignments[i]}"` : '';
        return `<th${align}>${convertInline(header)}</th>`;
    }).join('');

    const body = rows.map(row => {
        const tds = headers.map((_, i) => {
            const align = alignments[i] ? ` style="text-align:${alignments[i]}"` : '';
            return `<td${align}>${convertInline(row[i] || '')}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function normalizeAltText(alt) { return alt.replace(/[*_~`]/g, '').trim(); }

function normalizeIndent(chars) {
    let w = 0;
    for (let i = 0; i < chars.length; i++) w += chars[i] === '\t' ? 4 : 1;
    return w;
}

function renderList(lines, startIndex, baseIndent, firstItem = null) {
    let i = startIndex;
    const first = firstItem ?? parseListItem(lines[i]);
    if (first === null || first.indent !== baseIndent) return { html: '', nextIndex: startIndex + 1 };

    const listType = first.type;
    const items = [];

    let pendingItem = first;
    i++;

    while (true) {
        if (pendingItem !== null) {
            if (pendingItem.indent < baseIndent || pendingItem.type !== listType) break;
            items.push({ content: pendingItem.content, checked: pendingItem.checked === true, nested: [] });
            pendingItem = null;
        }

        if (i >= lines.length) break;

        const current = parseListItem(lines[i]);
        if (current === null || current.indent < baseIndent) break;

        if (current.indent > baseIndent) {
            const nested = renderList(lines, i, current.indent, current);
            if (items.length > 0) items[items.length - 1].nested.push(nested.html);
            i = nested.nextIndex;
            continue;
        }

        if (current.type !== listType) break;

        items.push({ content: current.content, checked: current.checked === true, nested: [] });
        i++;
    }

    const tag = listType === 'ol' ? 'ol' : 'ul';
    const listHtml = items.map(item => {
        const body = listType === 'task'
            ? convertCheckbox(convertInline(item.content), item.checked)
            : convertInline(item.content);
        return `<li>${body}${item.nested.join('')}</li>`;
    }).join('');

    return { html: `<${tag}>${listHtml}</${tag}>`, nextIndex: i };
}

function convertHeading(n, s) { return n === 0 ? s : `<h${n}>${s}</h${n}>`; }
function convertBold(s) { return `<strong>${s}</strong>`; }
function convertItalic(s) { return `<em>${s}</em>`; }
function convertBoldItalic(s) { return convertBold(convertItalic(s)); }
function convertStrikethrough(s) { return `<del>${s}</del>`; }
function convertInlineCode(s) { return `<code>${s}</code>`; }
function convertHighlight(s) { return `<mark>${s}</mark>`; }
function convertSubscript(s) { return `<sub>${s}</sub>`; }
function convertSuperscript(s) { return `<sup>${s}</sup>`; }
function convertHyperlink(href, s) { return `<a href="${href}">${s}</a>`; }
function convertHyperlinkWithTitle(href, s, t) { return `<a href="${href}" title="${t}">${s}</a>`; }
function convertImage(src, alt) { return `<img src="${src}" alt="${alt}">`; }
function convertLinkedImage(src, alt, href) { return `<a href="${href}"><img src="${src}" alt="${alt}"></a>`; }
function convertReferenceLink(href, s) { return `<a href="${href}">${s}</a>`; }
function convertCodeBlock(code, lang) { return `<pre><code class="${lang}">${code}</code></pre>`; }
function convertBlockQuote(q) { return `<blockquote>${q}</blockquote>`; }
function convertHorizontalRule() { return '<hr>'; }
function convertLineBreak() { return '<br>'; }
function convertParagraph(s) { return `<p>${s}</p>`; }
function convertCheckbox(item, checked) { return `<input type="checkbox"${checked ? ' checked' : ''}> ${item}`; }

let _posts = [];
let _layout = null;

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'posts-grid';

    for (const post of _posts) {
        const card = document.createElement('article');
        card.className = 'post-card';
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Read ${post.title}`);

        const date = formatDate(post.date);
        const tagsHtml = (post.tags || []).map(t => `<span class="post-tag">${t}</span>`).join('');

        card.innerHTML = `
            <div class="post-meta">
                ${date ? `<span class="post-date">${date}</span>` : ''}
                ${post.author ? `<span class="post-author">${post.author}</span>` : ''}
            </div>
            <div class="post-title">${post.title}</div>
            ${post.description ? `<div class="post-description">${post.description}</div>` : ''}
            ${tagsHtml ? `<div class="post-tags">${tagsHtml}</div>` : ''}
            <button class="post-read-btn">Read →</button>
        `;

        const open = () => openPost(post);
        card.querySelector('.post-read-btn').addEventListener('click', (e) => { e.stopPropagation(); open(); });
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });

        grid.appendChild(card);
    }

    return grid;
}

function buildSidebarItem(post, active = false) {
    const item = document.createElement('button');
    item.className = 'sidebar-item' + (active ? ' active' : '');
    item.dataset.file = post.file;
    item.innerHTML = `
        <span class="sidebar-item-title">${post.title}</span>
        ${post.date ? `<span class="sidebar-item-date">${formatDate(post.date)}</span>` : ''}
    `;
    item.addEventListener('click', () => openPost(post));
    return item;
}

function buildPostHeader(post) {
    const bar = document.createElement('div');
    bar.className = 'post-action-bar';

    const backBtn = document.createElement('button');
    backBtn.className = 'back-btn';
    backBtn.textContent = '← All posts';
    backBtn.addEventListener('click', closePost);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'share-btn';
    shareBtn.textContent = 'Share';
    shareBtn.addEventListener('click', () => sharePost(post, shareBtn));

    bar.appendChild(backBtn);
    bar.appendChild(shareBtn);
    return bar;
}

async function sharePost(post, btn) {
    const url = `${location.origin}${location.pathname}#${post.id}`;
    try {
        await navigator.clipboard.writeText(url);
    } catch {
        return;
    }
    btn.textContent = 'Copied!';
    btn.classList.add('share-btn--copied');
    setTimeout(() => {
        btn.textContent = 'Share';
        btn.classList.remove('share-btn--copied');
    }, 2000);
}

async function openPost(post) {
    const { contentArea, sidebarList } = _layout;

    history.replaceState(null, '', `#${post.id}`);

    document.getElementById('blog-layout').classList.add('split-view');

    sidebarList.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.toggle('active', el.dataset.file === post.file);
    });

    contentArea.innerHTML = '';
    contentArea.appendChild(buildPostHeader(post));
    const loading = document.createElement('div');
    loading.className = 'post-loading';
    loading.textContent = 'Loading…';
    contentArea.appendChild(loading);

    try {
        const res = await fetch(post.file);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const markdown = await res.text();
        const prose = document.createElement('div');
        prose.className = 'prose';
        prose.innerHTML = renderMarkdown(markdown);
        contentArea.innerHTML = '';
        contentArea.appendChild(buildPostHeader(post));
        contentArea.appendChild(prose);
        contentArea.scrollTop = 0;
    } catch (err) {
        const errEl = document.createElement('p');
        errEl.className = 'post-error';
        errEl.textContent = `Failed to load post: ${err.message}`;
        contentArea.innerHTML = '';
        contentArea.appendChild(buildPostHeader(post));
        contentArea.appendChild(errEl);
    }
}

function closePost() {
    history.replaceState(null, '', location.pathname);
    document.getElementById('blog-layout').classList.remove('split-view');
    _layout.contentArea.innerHTML = '';
    _layout.contentArea.appendChild(buildGrid());
}

async function loadBlog() {
    const root = document.getElementById('root');
    if (!root) return;

    root.innerHTML = `
        <header class="site-header">
            <div class="site-brand">
                <a href="https://quietterminal.co.uk" class="site-brand-link" target="_blank" rel="noopener">
                    <img class="site-logo" src="assets/logo.webp" alt="Quiet Terminal Interactive logo">
                    <span class="site-brand-name">Quiet Terminal Interactive</span>
                </a>
                <span class="site-brand-blog">Blog</span>
            </div>
            <div class="site-subtitle">The weird, wacky, and wonderful all in one place</div>
        </header>
        <div id="blog-layout">
            <div id="content-area"></div>
            <aside id="posts-sidebar"><div id="sidebar-list"></div></aside>
        </div>
    `;

    const contentArea = document.getElementById('content-area');
    const sidebar = document.getElementById('posts-sidebar');
    const sidebarList = document.getElementById('sidebar-list');

    contentArea.innerHTML = '<div class="state-message">Loading posts…</div>';

    try {
        const res = await fetch('assets/manifest.json');
        if (!res.ok) throw new Error(`${res.status}`);
        _posts = await res.json();
    } catch (err) {
        contentArea.innerHTML = `<div class="state-message">Could not load posts: ${err.message}</div>`;
        return;
    }

    _layout = { contentArea, sidebar, sidebarList };

    for (const post of _posts) {
        sidebarList.appendChild(buildSidebarItem(post));
    }

    contentArea.innerHTML = '';
    const linkedPost = location.hash
        ? _posts.find(p => p.id === location.hash.slice(1))
        : null;
    if (linkedPost) {
        openPost(linkedPost);
    } else {
        contentArea.appendChild(buildGrid());
    }
}

document.addEventListener('DOMContentLoaded', loadBlog);
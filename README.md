# QTI Blog

A lightweight, static blog for [Quiet Terminal Interactive](https://quietterminal.co.uk).

## How it works

- **Posts** are Markdown files stored in `assets/`
- **`assets/manifest.json`** is the post index — add an entry here to publish a post
- **`assets/script.js`** contains a hand-rolled Markdown renderer and the blog UI (grid view, split-panel reader, URL hash deep-linking)
- **`assets/styles.css`** provides the dark theme (Midnight Express palette)

## Adding a post

1. Write your post as a `.md` file and place it in `assets/`
2. Add an entry to `assets/manifest.json`:

```json
{
  "id": "my-post-slug",
  "title": "Post Title",
  "author": "Your Name",
  "date": "YYYY-MM-DD",
  "tags": ["tag1", "tag2"],
  "description": "Short description shown on the card.",
  "file": "assets/my-post-slug.md"
}
```

3. Open `index.html` in a browser (served via a local HTTP server — `file://` won't work due to fetch calls).

## Local dev

```sh
npx serve .
# or
python3 -m http.server
```

Then open `http://localhost:3000` (or whatever port is shown).

## Markdown support

The renderer supports headings, paragraphs, bold/italic/strikethrough, inline code, fenced code blocks, blockquotes, ordered/unordered/task lists, tables, images, links, highlights, sub/superscript, and horizontal rules.

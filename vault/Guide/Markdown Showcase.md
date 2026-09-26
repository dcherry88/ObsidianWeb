---
title: Markdown Showcase
tags:
  - guide
  - markdown
status: reference
---
# Markdown Showcase

## Text
**bold**, *italic*, ***both***, ~~strikethrough~~, `inline code`, ==highlighted text==, and a [normal link](https://obsidian.md).

## Lists
- Unordered item
  - Nested item
    - Deeper item
1. First
2. Second
   1. Sub-step

## Tasks
- [x] Render headings
- [x] Render callouts
- [ ] Render everything Obsidian can (plugins are out of scope)

## Callouts
> [!note] A note
> Notes are blue-ish in Obsidian; here they use the accent color.

> [!warning] Careful
> Callout type is shown as the title.

> [!tip]
> Callouts without a custom title work too.

## Blockquote
> Plain quotes still look like quotes.

## Table
| Name | Type | Notes |
|---|---|---|
| `tree()` | method | lists all files |
| `read()` | method | reads a note, optionally at a commit |
| `history()` | method | git log for a note |

## Code
```js
// JavaScript
const notes = await provider.tree();
console.log(`${notes.length} files`);
```

```python
# Python
def backlinks(note: str) -> list[str]:
    return [n for n in notes if f"[[{note}]]" in text[n]]
```

```bash
npm install && npm run build && ALLOW_WRITE=1 npm start
```

```json
{ "attachmentFolderPath": "Attachments" }
```

Tags inside code are ignored: `#not-a-tag`.

```
#also-not-a-tag
```

## Horizontal rule

---

See also [[Reference/Markdown Cheatsheet]].

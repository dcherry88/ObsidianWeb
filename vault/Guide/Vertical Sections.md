---
tags: [guide, layout]
---
# Vertical Sections

Vertical sections lay out several small **key/value tables** side by side, like a dashboard. Each table is a normal markdown table: the header is the section title and the two columns are key and value. In the web view the tables have no gridlines.

The directives are HTML comments, so plain Obsidian ignores them and simply shows the tables one after another.

<!-- sections -->
<!-- col1 -->
| Sites | |
|---|---|
| Home | https://example.com |
| Docs | https://docs.example.com |
| Status | https://status.example.com |

| Repos | |
|---|---|
| ObsidianWeb | https://github.com/dcherry88/ObsidianWeb |
| Notes | [[Welcome]] |

<!-- col2 -->
| Servers | |
|---|---|
| web-01 | 10.0.0.11 |
| db-01 | 10.0.0.21 |
| cache-01 | 10.0.0.31 |

<!-- col3 -->
| Contacts | |
|---|---|
| Lead | [[People/Ada Lovelace]] |
| Engineer | [[People/Grace Hopper]] |
| On call | +1 555 0100 |

<!-- row -->
<!-- col1 -->
| Alpha | |
|---|---|
| Status | **Active** #project/alpha |
| Plan | [[Projects/Alpha/Roadmap]] |

<!-- col2 -->
| Beta | |
|---|---|
| Status | Blocked #project/beta |
| Owner | [[People/Grace Hopper]] |
<!-- /sections -->

Text after the grid continues as normal markdown.

## How to write it
```
<!-- sections -->          start a grid
<!-- col1 -->              content below goes in column 1
| Section title | |
|---|---|
| key | value |
<!-- col2 -->              next column (or just <!-- col -->)
...
<!-- row -->               start a new row of columns
<!-- col1 -->
...
<!-- /sections -->         end the grid
```
- Several tables under one `colN` stack vertically.
- Up to 6 columns per row; on narrow screens they stack into one column.
- The first row is implicit, so `<!-- row -->` is only needed from the second row on.

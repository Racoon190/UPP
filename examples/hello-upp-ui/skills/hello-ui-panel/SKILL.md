---
name: hello-ui-panel
description: "Hello UI panel - inline panel for Hello UPP UI"
renderers:
  hello-ui-panel:
    description: Hello UI panel
    app: app/index.html
---

# Hello UI panel

Show the Hello UPP UI panel inside Accio Work.

1. Run `node scripts/show.mjs` once with the shell tool.
2. If the host attaches a `:::slot[...]` instruction, echo that marker exactly as given.
3. Never fetch `skill-app://` URLs yourself; the host owns the iframe.

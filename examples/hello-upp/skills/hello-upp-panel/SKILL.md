---
name: hello-upp-panel
description: "Hello UPP panel - inline panel for Hello UPP"
renderers:
  hello-panel:
    description: Hello UPP panel
    app: app/index.html
---

# Hello UPP panel

Show the Hello UPP panel inside Accio Work.

1. Run `node scripts/show.mjs` once with the shell tool.
2. If the host attaches a `:::slot[...]` instruction, echo that marker exactly as given.
3. Never fetch `skill-app://` URLs yourself; the host owns the iframe.

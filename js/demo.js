// demo.js — sample data used when the page is opened with ?demo=1 (no GitHub
// connection). Mirrors the sample files shipped in data/.

export const DEMO_FILES = {
  'data/config.yml': `# Planning data configuration.
# Managed by the planning tool settings — safe to edit by hand too.

people:
  - Alice
  - Bob

tags:
  - name: analysis
    color: "#8b5cf6"
  - name: hardware
    color: "#f59e0b"
  - name: paper
    color: "#10b981"
`,

  'data/items/welcome-click-me-d3m0.md': `---
title: "Welcome — click me! 👋"
tag: analysis
person: Alice
discuss: true
x: 0
y: 0
---

This is an **item card**. Click it to edit everything: title, description, tag, responsible people, deadline, status and the 💬 "to discuss" flag (that's why this card shows a speech bubble).

- Drag cards around the whiteboard
- Scroll (or pinch) to zoom, drag the background to pan
- Click any empty spot to add a new item

Paste or attach images right in this description editor.
`,

  'data/items/order-detector-parts-d3m1.md': `---
title: Order detector parts
tag: hardware
person: [Alice, Bob]
deadline: 2026-07-24
status: in-progress
x: 380
y: -60
---

Get quotes for the new mounting brackets and place the order.
`,

  'data/items/draft-results-section-d3m2.md': `---
title: Draft results section
tag: paper
person: Alice
deadline: 2026-08-14
---

First full draft of the results section, including the main figures.

This item has **no whiteboard position** yet — it lives in the whiteboard's
"no position" tray until you drag it onto the board.
`,

  'data/items/brainstorm-follow-ups-d3m3.md': `---
title: Brainstorm follow-up ideas
tag: analysis
x: -320
y: 170
---

Collect ideas for the next iteration.

This item has **no deadline** yet — it sits in the timeline's "no deadline"
tray until you drag it onto a date.
`,

  'data/board/rect-d3m1.md': `---
type: rect
x: -420
y: -230
w: 340
h: 300
size: 3
color: "#8b5cf6"
fill: "#8b5cf61e"
---
`,

  'data/board/text-d3m1.md': `---
type: text
x: -406
y: -216
size: 24
color: "#8b5cf6"
---

Ideas 💡✨
`,

  'data/board/line-d3m1.md': `---
type: line
x: -60
y: -90
x2: 110
y2: -30
size: 4
color: "#f59e0b"
---
`,

  'data/items/calibrate-sensors-d3m4.md': `---
title: Calibrate the sensors
tag: hardware
person: Bob
deadline: 2026-06-30
status: done
x: 150
y: 190
---

Already finished — done items are shown crossed out and greyed on all pages.
`,
};

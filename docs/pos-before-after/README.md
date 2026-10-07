# POS screen: before / after the `Pos.tsx` theme-token change

`Pos.tsx` had 21 hard-coded `#7A1220` class names; they were replaced with the `brand-black` theme token (same CSS variable, `--theme-primary`).

| File | Taken from |
|---|---|
| `pos1-before.png`, `pos2-before.png`, `pos3-before.png` | browser test at commit `f81ecb2` (before the change), Staff on Branch 1 / 2 / 3, one item scanned, cash entered |
| `pos1-after.png`, `pos2-after.png`, `pos3-after.png` | the same test step at commit `716a886` (after the change) |

Both are 1440 x 900. A pixel comparison (any colour channel difference above 12) found **60 differing pixels out of 1,296,000 on each of the three branches**, all inside one 8 x 8 square at x 249-256, y 34-41: the pulsing green status dot in the branch badge (an animation caught at a different moment). Everything else is identical.

These pictures predate the Take250 rebrand, so they still show the old branch names; they only prove the theme-token change.

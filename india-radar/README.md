# India Rain + Lightning

Mobile-first GitHub Pages client for the radar and ILDN lightning archives
generated in the ILDN workspace. The client races the University of Reading
and JASMIN GWS mirrors, then falls back within a fraction of a second to a
72-hour same-origin snapshot bundled with the site. The saved copy keeps the
map usable during a hosting outage and is labelled clearly in the timeline.

The upstream composite currently contains nominal ten-minute frames. The page
checks for updates every five minutes and offers a continuous slider whose
intermediate positions are visibly labelled cross-fades between observations.
The client preloads palette-indexed daily packs into a dedicated 224 x 256 canvas,
so dragging needs no radar request or image decode; releasing restores the full
1792 x 2048 imagery. Separate 448 x 512 previews remain as a compatibility fallback.
At every position, a single canvas layer renders ILDN strokes from the preceding
two hours, with colour, size, and opacity showing their age. Hour-sized chunks and
compressed daily display packs keep archive browsing responsive on phones.

Public radar frames have persistent station-centred radial spokes conservatively
inpainted from adjacent pixels. Unmistakable solid block corruption triggers
whole-frame temporal reconstruction between clean neighbours. The original
source frames are retained in the private archive, and the public manifest
exposes filter diagnostics.

Refresh the emergency snapshot from the ILDN workspace before publishing with:

```bash
python3 github-pages/india-radar/tools/build_emergency_snapshot.py
```

Data attribution and operational caveats are deliberately visible in the page.
Visitor Badge Reloaded provides the cookie-free visible request count. The radar
page increments it once; the portfolio badge uses the same counter in documented
read-only (`hit=false`) mode.

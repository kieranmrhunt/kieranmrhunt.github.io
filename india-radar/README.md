# India Rain + Lightning

Mobile-first GitHub Pages client for the radar and ILDN lightning archives
generated in the ILDN workspace. The client races the University of Reading
and JASMIN GWS mirrors, then falls back within a fraction of a second to a
72-hour same-origin snapshot bundled with the site. The saved copy keeps the
map usable during a hosting outage and is labelled clearly in the timeline.

The upstream composite currently contains nominal ten-minute frames. The page
checks for updates every five minutes and offers a continuous rolling 72-hour
slider whose
intermediate positions are visibly labelled cross-fades between observations.
The client preloads palette-indexed daily packs into a dedicated 224 x 256 canvas,
limited to the visible period, so dragging needs no radar request or image decode;
releasing restores the full 1792 x 2048 imagery. Separate 448 x 512 previews remain
as a compatibility fallback. Older observations remain in the server archive but
are deliberately excluded from the phone slider to preserve fine time control.
At every position, a single canvas layer renders ILDN strokes from the preceding
two hours, with colour, size, and opacity showing their age. Hour-sized chunks and
compressed daily display packs keep archive browsing responsive on phones.
Rain and lightning can be switched independently from the map or About panel.
The lightning readout reports both strokes whose centres are inside the visible
map and strokes over Indian land in the same two-hour interval. The India count
uses a compact 0.02-degree raster of Natural Earth's 1:10m India-viewpoint
Admin-0 boundary; its cumulative count is built once as each hour is decoded, so
it adds no work to timeline dragging.

Public radar frames have persistent station-centred radial spokes conservatively
inpainted from adjacent pixels. Unmistakable solid block corruption triggers
whole-frame temporal reconstruction between clean neighbours. The original
source frames are retained in the private archive, and the public manifest
exposes filter diagnostics.

Render a reproducible 780 x 1266 Android-view timelapse after starting a local
server for the GitHub Pages checkout. Chrome, FFmpeg, and the Python
`websocket-client` package are required:

```bash
python3 github-pages/india-radar/tools/render_android_timelapse.py \
  --url http://127.0.0.1:8765/india-radar/ \
  --output videos/india-radar-72h-android.mp4
```

The renderer also writes machine-readable timeline, cache, interaction, and
viewport QA with `--qa-json`. It waits for the full 1792 x 2048 radar layers at
every captured position and encodes the 72-hour sweep at 60 frames per second,
producing a video of roughly 14.4 seconds. Add an ISO-8601 end time such as
`--end-time-utc 2026-09-24T08:00:00Z` to reproduce a historical 72-hour window.

Refresh the emergency snapshot from the ILDN workspace before publishing with:

```bash
python3 github-pages/india-radar/tools/build_emergency_snapshot.py
```

Regenerate the browser's India land mask after updating the Natural Earth
boundary with:

```bash
python3 github-pages/india-radar/tools/build_india_land_mask.py
```

Data attribution and operational caveats are deliberately visible in the page.
Visitor Badge Reloaded provides the cookie-free visible request count. The radar
page increments it once; the portfolio badge uses the same counter in documented
read-only (`hit=false`) mode.

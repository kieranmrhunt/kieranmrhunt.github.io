# India Rain + Lightning

Mobile-first GitHub Pages client for the radar and ILDN lightning archives
generated in the ILDN workspace. The client tries the University of Reading
mirror first and the JASMIN GWS mirror as a fallback.

The upstream composite currently contains nominal ten-minute frames. The page
checks for updates every five minutes and offers a continuous slider whose
intermediate positions are visibly labelled cross-fades between observations.
At every position, a single canvas layer renders ILDN strokes from the preceding
hour, with colour, size, and opacity showing their age. Hour-sized chunks and
month indexes keep archive browsing light on phones.

Public radar frames have persistent station-centred radial spokes conservatively
inpainted from adjacent pixels. Unmistakable solid block corruption triggers
whole-frame temporal reconstruction between clean neighbours. The original
source frames are retained in the private archive, and the public manifest
exposes filter diagnostics.

Data attribution and operational caveats are deliberately visible in the page.
Visitor Badge Reloaded provides the cookie-free visible request count. The radar
page increments it once; the portfolio badge uses the same counter in documented
read-only (`hit=false`) mode.

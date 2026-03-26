#!/usr/bin/env bash
set -euo pipefail

# Generate a test DVD with a root menu for M3 development.
# Requires: ffmpeg, dvdauthor, spumux
#
# The disc has:
#   - VMGM root menu with 3 buttons (one per title)
#   - First Play PGC jumps to the root menu
#   - Title 1: 6s blue test pattern, 440Hz
#   - Title 2: 6s green test pattern, 880Hz
#   - Title 3: 6s red test pattern, 660Hz
#   - Post-commands return to menu after each title

OUT_DIR="${1:-/tmp/webdvd-menu-test}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Button layout constants (720x480 NTSC)
# Three buttons centered horizontally, stacked vertically
BTN_X0=210
BTN_X1=510
BTN_W=$((BTN_X1 - BTN_X0))
BTN_H=40
BTN1_Y=178
BTN2_Y=238
BTN3_Y=298

echo "=== Generating title videos ==="

# Title 1: blue, 6s
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=240" \
    -f lavfi -i "sine=frequency=440:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title1.mpg"

# Title 2: green, 6s
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=120" \
    -f lavfi -i "sine=frequency=880:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title2.mpg"

# Title 3: red, 6s
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=0:s=3" \
    -f lavfi -i "sine=frequency=660:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title3.mpg"

echo "=== Generating menu background video ==="

# Dark background with colored rectangles marking the button areas.
# We avoid drawtext since it requires freetype support in ffmpeg.
# Each button is a distinct colored bar so they're visually identifiable:
#   Button 1 (Title 1): blue bar
#   Button 2 (Title 2): green bar
#   Button 3 (Title 3): red bar
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0x101830:s=720x480:d=3:r=29.97,\
drawbox=x=${BTN_X0}:y=${BTN1_Y}:w=${BTN_W}:h=${BTN_H}:color=0x3333AA:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN2_Y}:w=${BTN_W}:h=${BTN_H}:color=0x33AA33:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN3_Y}:w=${BTN_W}:h=${BTN_H}:color=0xAA3333:t=fill" \
    -f lavfi -i "sine=frequency=0:duration=3" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/menu_bg.mpg"

echo "=== Generating button overlay images ==="

# Highlight image: white semi-transparent boxes at button positions.
# spumux uses this when a button is navigated to (selected).
# Black (0x000000) is the transparent color.
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=black:s=720x480:d=0.04,\
drawbox=x=${BTN_X0}:y=${BTN1_Y}:w=${BTN_W}:h=${BTN_H}:color=white:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN2_Y}:w=${BTN_W}:h=${BTN_H}:color=white:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN3_Y}:w=${BTN_W}:h=${BTN_H}:color=white:t=fill" \
    -frames:v 1 "$WORK_DIR/highlight.png"

# Select image: gray boxes shown briefly when a button is activated (pressed).
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=black:s=720x480:d=0.04,\
drawbox=x=${BTN_X0}:y=${BTN1_Y}:w=${BTN_W}:h=${BTN_H}:color=0x888888:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN2_Y}:w=${BTN_W}:h=${BTN_H}:color=0x888888:t=fill,\
drawbox=x=${BTN_X0}:y=${BTN3_Y}:w=${BTN_W}:h=${BTN_H}:color=0x888888:t=fill" \
    -frames:v 1 "$WORK_DIR/select.png"

echo "=== Muxing button overlays into menu video ==="

# spumux adds the subpicture stream with button coordinates to the menu VOB.
# The transparent color (black) is not rendered — only the white/gray boxes show.
cat > "$WORK_DIR/spumux.xml" <<XMLEOF
<subpictures>
  <stream>
    <spu force="yes"
         start="00:00:00.00"
         highlight="$WORK_DIR/highlight.png"
         select="$WORK_DIR/select.png"
         transparent="000000">
      <button x0="${BTN_X0}" y0="${BTN1_Y}" x1="${BTN_X1}" y1="$((BTN1_Y + BTN_H))"
              up="3" down="2" left="1" right="1" />
      <button x0="${BTN_X0}" y0="${BTN2_Y}" x1="${BTN_X1}" y1="$((BTN2_Y + BTN_H))"
              up="1" down="3" left="2" right="2" />
      <button x0="${BTN_X0}" y0="${BTN3_Y}" x1="${BTN_X1}" y1="$((BTN3_Y + BTN_H))"
              up="2" down="1" left="3" right="3" />
    </spu>
  </stream>
</subpictures>
XMLEOF

spumux "$WORK_DIR/spumux.xml" < "$WORK_DIR/menu_bg.mpg" > "$WORK_DIR/menu.mpg" 2>/dev/null

echo "=== Building DVD structure ==="
rm -rf "$OUT_DIR"

# VMGM root menu with 3 buttons → jump to titles in separate titlesets.
# Each title's post-command returns to the VMGM menu after playback.
cat > "$WORK_DIR/dvdauthor.xml" <<XMLEOF
<dvdauthor dest="$OUT_DIR">
  <vmgm>
    <fpc>jump vmgm menu 1;</fpc>
    <menus>
      <pgc entry="title">
        <vob file="$WORK_DIR/menu.mpg" pause="inf" />
        <button>jump title 1;</button>
        <button>jump title 2;</button>
        <button>jump title 3;</button>
      </pgc>
    </menus>
  </vmgm>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title1.mpg" />
        <post>call vmgm menu 1;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title2.mpg" />
        <post>call vmgm menu 1;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title3.mpg" />
        <post>call vmgm menu 1;</post>
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
XMLEOF

export VIDEO_FORMAT=NTSC
dvdauthor -x "$WORK_DIR/dvdauthor.xml"

echo "=== Done ==="
echo "VIDEO_TS directory: $OUT_DIR/VIDEO_TS"
echo ""
echo "Disc layout:"
echo "  VMGM root menu with 3 buttons (First Play target)"
echo "  Title 1 (VTS 1): 6s, blue test pattern (440Hz tone)"
echo "  Title 2 (VTS 2): 6s, green test pattern (880Hz tone)"
echo "  Title 3 (VTS 3): 6s, red test pattern (660Hz tone)"
echo "  All titles return to menu after playback"
echo ""
echo "Button coordinates (720x480 NTSC):"
echo "  Button 1: (${BTN_X0},${BTN1_Y})-(${BTN_X1},$((BTN1_Y + BTN_H)))"
echo "  Button 2: (${BTN_X0},${BTN2_Y})-(${BTN_X1},$((BTN2_Y + BTN_H)))"
echo "  Button 3: (${BTN_X0},${BTN3_Y})-(${BTN_X1},$((BTN3_Y + BTN_H)))"
echo ""
echo "Test with:"
echo "  cd server && cargo run -- $OUT_DIR/VIDEO_TS"
ls -la "$OUT_DIR/VIDEO_TS/"

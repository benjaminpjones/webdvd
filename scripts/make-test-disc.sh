#!/usr/bin/env bash
set -euo pipefail

# Generate a multi-title test DVD with menus for development/CI.
# Requires: ffmpeg, dvdauthor, spumux
#
# The test disc has:
#   - Root menu (VMGM) with 4 buttons: "Title 1", "Title 2", "Title 4", "Chapters"
#   - Chapters sub-menu (VTS 1 menu) with 3 buttons: "Chapter 1", "Chapter 2", "Main Menu"
#   - 4 titles across 3 titlesets
#   - Title 1 (VTS 1, PGC 1): 8s, blue-shifted test pattern, 2 chapters (4s each)
#   - Title 2 (VTS 2, PGC 1): 10s, green-shifted test pattern, 3 chapters (~3.3s each)
#   - Title 3 (VTS 3, PGC 1): 6s, red-shifted test pattern, 1 chapter
#   - Title 4 (VTS 2, PGC 2): 4s, yellow-shifted test pattern, 1 chapter
#     (second PGC in same titleset as Title 2 — tests PGC sector bounds)
#   - First Play PGC goes to root menu
#   - Title post-commands return to root menu
#   - AC-3 audio on all titles (440Hz, 880Hz, 660Hz, 550Hz — distinguishable by ear)

OUT_DIR="${1:-/tmp/webdvd-test}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Generating test MPEG-2 videos ==="

# Title 1: blue-shifted test pattern, 8 seconds, 2 chapters
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=8:size=720x480:rate=29.97,hue=h=240" \
    -f lavfi -i "sine=frequency=440:duration=8" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title1.mpg"

# Title 2: green-shifted test pattern, 10 seconds, 3 chapters (the "main feature")
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=10:size=720x480:rate=29.97,hue=h=120" \
    -f lavfi -i "sine=frequency=880:duration=10" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title2.mpg"

# Title 3: red-shifted test pattern, 6 seconds, 1 chapter (bonus)
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=0:s=3" \
    -f lavfi -i "sine=frequency=660:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title3.mpg"

# Title 4: yellow-shifted test pattern, 4 seconds, 1 chapter
# This will be a second PGC in VTS 2 (same titleset as title 2) to test
# that PGC sector bounds are passed correctly when the title doesn't
# start at sector 0 of the VOB.
ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=duration=4:size=720x480:rate=29.97,hue=h=60" \
    -f lavfi -i "sine=frequency=550:duration=4" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title4.mpg"

echo "=== Generating menu videos ==="

# Root menu: dark gray background (buttons will be visible via SPU highlights)
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0x333333:s=720x480:r=29.97:d=3" \
    -f lavfi -i "sine=frequency=330:duration=3" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/root_menu.mpg"

# Chapters sub-menu: dark blue-gray to distinguish from root menu
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0x222244:s=720x480:r=29.97:d=3" \
    -f lavfi -i "sine=frequency=550:duration=3" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/chapters_menu.mpg"

echo "=== Generating button highlight images ==="

# Button highlight images for spumux — white rectangles on transparent background.
# These define the clickable/highlightable button regions.
# Generated with ffmpeg (no imagemagick dependency).

# Root menu: 4 buttons stacked vertically
# Button 1: "Title 1"    y=150..195
# Button 2: "Title 2"    y=210..255
# Button 3: "Title 4"    y=270..315
# Button 4: "Chapters"   y=330..375
ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=black@0:s=720x480:d=0.04,format=rgba,drawbox=x=260:y=150:w=200:h=45:color=white:t=fill,drawbox=x=260:y=210:w=200:h=45:color=white:t=fill,drawbox=x=260:y=270:w=200:h=45:color=white:t=fill,drawbox=x=260:y=330:w=200:h=45:color=white:t=fill" \
    -frames:v 1 "$WORK_DIR/root_highlight.png"

# Chapters sub-menu: 3 buttons (same layout)
cp "$WORK_DIR/root_highlight.png" "$WORK_DIR/chapters_highlight.png"

echo "=== Muxing subtitles into menu videos ==="

# Root menu spumux config — explicit button regions with navigation links
cat > "$WORK_DIR/root_spu.xml" <<XMLEOF
<subpictures>
 <stream>
  <spu start="00:00:00.00" end="00:00:03.00"
       highlight="$WORK_DIR/root_highlight.png"
       select="$WORK_DIR/root_highlight.png"
       force="yes" >
    <button x0="260" y0="150" x1="460" y1="195" up="4" down="2" />
    <button x0="260" y0="210" x1="460" y1="255" up="1" down="3" />
    <button x0="260" y0="270" x1="460" y1="315" up="2" down="4" />
    <button x0="260" y0="330" x1="460" y1="375" up="3" down="1" />
  </spu>
 </stream>
</subpictures>
XMLEOF

# Chapters sub-menu spumux config
cat > "$WORK_DIR/chapters_spu.xml" <<XMLEOF
<subpictures>
 <stream>
  <spu start="00:00:00.00" end="00:00:03.00"
       highlight="$WORK_DIR/chapters_highlight.png"
       select="$WORK_DIR/chapters_highlight.png"
       force="yes" >
    <button x0="260" y0="190" x1="460" y1="235" up="3" down="2" />
    <button x0="260" y0="250" x1="460" y1="295" up="1" down="3" />
    <button x0="260" y0="310" x1="460" y1="355" up="2" down="1" />
  </spu>
 </stream>
</subpictures>
XMLEOF

export VIDEO_FORMAT=NTSC
spumux -v 0 "$WORK_DIR/root_spu.xml" < "$WORK_DIR/root_menu.mpg" > "$WORK_DIR/root_menu_sub.mpg" 2>/dev/null
spumux -v 0 "$WORK_DIR/chapters_spu.xml" < "$WORK_DIR/chapters_menu.mpg" > "$WORK_DIR/chapters_menu_sub.mpg" 2>/dev/null

echo "=== Building DVD structure ==="
rm -rf "$OUT_DIR"

# DVD structure:
#   VMGM: root menu with 4 buttons → Title 1, Title 2, Title 4, or VTS 1 chapters sub-menu
#   VTS 1: title 1 (blue, 8s, 2 chapters) + chapters sub-menu (3 buttons)
#   VTS 2: title 2 (green, 10s, 3 chapters) + title 4 (yellow, 4s, 1 chapter)
#          (two PGCs in one titleset — title 4 starts mid-VOB to test PGC bounds)
#   VTS 3: title 3 (red, 6s, 1 chapter)
#   First Play → root menu
#   Title post-commands → return to root menu
cat > "$WORK_DIR/dvdauthor.xml" <<XMLEOF
<dvdauthor dest="$OUT_DIR">
  <vmgm>
    <fpc>jump vmgm menu 1;</fpc>
    <menus>
      <pgc pause="inf">
        <vob file="$WORK_DIR/root_menu_sub.mpg" pause="inf" />
        <button>jump title 1;</button>
        <button>jump title 2;</button>
        <button>jump title 4;</button>
        <button>jump titleset 1 menu;</button>
      </pgc>
    </menus>
  </vmgm>
  <titleset>
    <menus>
      <pgc pause="inf">
        <vob file="$WORK_DIR/chapters_menu_sub.mpg" pause="inf" />
        <button>jump title 1;</button>
        <button>jump title 1;</button>
        <button>jump vmgm menu 1;</button>
      </pgc>
    </menus>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title1.mpg" chapters="0,4" />
        <post>call vmgm menu 1;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title2.mpg" chapters="0,3.3,6.6" />
        <post>call vmgm menu 1;</post>
      </pgc>
      <pgc>
        <vob file="$WORK_DIR/title4.mpg" />
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

dvdauthor -x "$WORK_DIR/dvdauthor.xml"

echo "=== Done ==="
echo "VIDEO_TS directory: $OUT_DIR/VIDEO_TS"
echo ""
echo "Disc layout:"
echo "  Root Menu (VMGM): 4 buttons — Title 1, Title 2, Title 4, Chapters"
echo "  Chapters Sub-Menu (VTS 1 menu): 3 buttons — Chapter 1, Chapter 2, Main Menu"
echo "  Title 1 (VTS 1): 8s, blue test pattern, 2 chapters (440Hz tone)"
echo "  Title 2 (VTS 2, PGC 1): 10s, green test pattern, 3 chapters (880Hz tone)"
echo "  Title 3 (VTS 3): 6s, red test pattern, 1 chapter (660Hz tone)"
echo "  Title 4 (VTS 2, PGC 2): 4s, yellow test pattern, 1 chapter (550Hz tone)"
echo "  First Play → Root Menu"
echo ""
echo "Test with:"
echo "  cd server && cargo run -- $OUT_DIR/VIDEO_TS"
ls -la "$OUT_DIR/VIDEO_TS/"

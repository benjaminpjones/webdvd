#!/usr/bin/env bash
set -euo pipefail

# Generate a multi-title test DVD with menus for development/CI.
# Requires: ffmpeg (with drawtext/freetype), dvdauthor, spumux
#
# The test disc has:
#   - Root menu (VMGM) with 4 buttons: "Title 1", "Title 2", "Title 4", "Chapters"
#   - Chapters sub-menu (VTS 1 menu) with 3 buttons: "Chapter 1", "Chapter 2", "Main Menu"
#   - 4 titles across 3 titlesets
#   - Title 1 (VTS 1, PGC 1): 8s, blue-shifted test pattern, 2 chapters (4s each)
#   - Title 2 (VTS 2, PGC 1): 10s, green-shifted test pattern, 3 chapters (~3.3s each)
#   - Title 3 (VTS 2, PGC 2): 4s, yellow-shifted test pattern, 1 chapter
#     (second PGC in same titleset as Title 2 — tests PGC sector bounds)
#   - Title 4 (VTS 3, PGC 1): 6s, red-shifted test pattern, 1 chapter
#   - First Play PGC goes to root menu
#   - Title post-commands return to root menu
#   - AC-3 audio on all titles (440Hz, 880Hz, 550Hz, 660Hz — distinguishable by ear)
#
# Each title has text overlays explaining what it tests and what a bug looks like.
# Menus have visible button labels.

OUT_DIR="${1:-/tmp/webdvd-test}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# --- Detect ffmpeg with drawtext support ---
# Prefer ffmpeg-full (Homebrew keg-only) which includes freetype/drawtext.
# Fall back to regular ffmpeg if it has drawtext.
if command -v /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg &>/dev/null; then
    FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
elif ffmpeg -filters 2>/dev/null | grep -q drawtext; then
    FFMPEG=ffmpeg
else
    echo "ERROR: ffmpeg with drawtext filter required." >&2
    echo "Install via: brew install ffmpeg-full" >&2
    echo "(ffmpeg-full is keg-only and won't conflict with regular ffmpeg)" >&2
    exit 1
fi
echo "Using ffmpeg: $FFMPEG"

# --- Drawtext style constants ---
# Semi-transparent black box behind text for legibility against test patterns
DT_HEADER="fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10"
DT_INFO="fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6"
DT_BUG="fontsize=16:fontcolor=orange:box=1:boxcolor=black@0.6:boxborderw=6"
DT_CHAPTER="fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=8"
DT_BTN="fontsize=22:fontcolor=white"

echo "=== Generating test MPEG-2 videos ==="

# Title 1: blue-shifted test pattern, 8 seconds, 2 chapters
# Tests: chapter navigation, chapter sub-menu
$FFMPEG -y -loglevel error \
    -f lavfi -i "testsrc=duration=8:size=720x480:rate=29.97,hue=h=240,\
drawtext=${DT_HEADER}:text='Title 1 — Chapters + Sub-Menu':x=(w-tw)/2:y=30,\
drawtext=${DT_INFO}:text='VTS 1, PGC 1 | 8s, 2 chapters at 0s and 4s':x=(w-tw)/2:y=68,\
drawtext=${DT_INFO}:text='Linked from Chapters sub-menu (tests sub-menu to title flow)':x=(w-tw)/2:y=96,\
drawtext=${DT_BUG}:text='BUG if chapters do not split at the 4s mark':x=36:y=420,\
drawtext=${DT_BUG}:text='BUG if chapter sub-menu buttons play wrong chapter':x=36:y=446,\
drawtext=${DT_CHAPTER}:text='Chapter 1 of 2':x=(w-tw)/2:y=(h-th)/2:enable='between(t,0,3.99)',\
drawtext=${DT_CHAPTER}:text='Chapter 2 of 2':x=(w-tw)/2:y=(h-th)/2:enable='gte(t,4)'" \
    -f lavfi -i "sine=frequency=440:duration=8" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title1.mpg"

# Title 2: green-shifted test pattern, 10 seconds, 3 chapters (the "main feature")
# Tests: multi-chapter playback, shares VOB with Title 3
$FFMPEG -y -loglevel error \
    -f lavfi -i "testsrc=duration=10:size=720x480:rate=29.97,hue=h=120,\
drawtext=${DT_HEADER}:text='Title 2 — Shared VOB (Multi-PGC Titleset)':x=(w-tw)/2:y=30,\
drawtext=${DT_INFO}:text='VTS 2, PGC 1 | 10s, 3 chapters | Shares VOB with Title 3':x=(w-tw)/2:y=68,\
drawtext=${DT_BUG}:text='BUG if Title 3 shows this content instead of yellow':x=36:y=420,\
drawtext=${DT_BUG}:text='BUG if chapter boundaries not at 3.3s and 6.6s':x=36:y=446,\
drawtext=${DT_CHAPTER}:text='Chapter 1 of 3':x=(w-tw)/2:y=(h-th)/2:enable='between(t,0,3.29)',\
drawtext=${DT_CHAPTER}:text='Chapter 2 of 3':x=(w-tw)/2:y=(h-th)/2:enable='between(t,3.3,6.59)',\
drawtext=${DT_CHAPTER}:text='Chapter 3 of 3':x=(w-tw)/2:y=(h-th)/2:enable='gte(t,6.6)'" \
    -f lavfi -i "sine=frequency=880:duration=10" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title2.mpg"

# Title 3: yellow-shifted test pattern, 4 seconds, 1 chapter
# Tests: multi-PGC sector bounds — second PGC in VTS 2, starts mid-VOB (~sector 644)
# This is the key test for PGC sector/lastSector propagation.
$FFMPEG -y -loglevel error \
    -f lavfi -i "testsrc=duration=4:size=720x480:rate=29.97,hue=h=60,\
drawtext=${DT_HEADER}:text='Title 3 — Multi-PGC Sector Bounds':x=(w-tw)/2:y=30,\
drawtext=${DT_INFO}:text='VTS 2, PGC 2 | 4s, 1 chapter':x=(w-tw)/2:y=68,\
drawtext=${DT_INFO}:text='Second PGC in same VOB as Title 2 (starts mid-VOB)':x=(w-tw)/2:y=96,\
drawtext=${DT_BUG}:text='BUG if you see Title 2 content — sector offset is wrong':x=36:y=420,\
drawtext=${DT_BUG}:text='BUG if duration is not ~4s (sector range too wide or narrow)':x=36:y=446" \
    -f lavfi -i "sine=frequency=550:duration=4" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title3.mpg"

# Title 4: red-shifted test pattern, 6 seconds, 1 chapter
# Tests: title switching from menu, standalone titleset
$FFMPEG -y -loglevel error \
    -f lavfi -i "testsrc=duration=6:size=720x480:rate=29.97,hue=h=0:s=3,\
drawtext=${DT_HEADER}:text='Title 4 — Title Switching':x=(w-tw)/2:y=30,\
drawtext=${DT_INFO}:text='VTS 3, PGC 1 | 6s, 1 chapter | Standalone titleset':x=(w-tw)/2:y=68,\
drawtext=${DT_BUG}:text='BUG if transcode URL does not reference VTS 3':x=36:y=420,\
drawtext=${DT_BUG}:text='BUG if video does not start after menu button press':x=36:y=446" \
    -f lavfi -i "sine=frequency=660:duration=6" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/title4.mpg"

echo "=== Generating menu videos ==="

# Root menu: dark gray background with button labels
# Buttons: Title 1..4 + Title 1 Chapters (matching SPU highlight positions)
$FFMPEG -y -loglevel error \
    -f lavfi -i "color=c=0x333333:s=720x480:r=29.97:d=3,\
drawtext=${DT_HEADER}:text='ROOT MENU':x=(w-tw)/2:y=60,\
drawtext=${DT_BTN}:text='Title 1':x=(w-tw)/2:y=140,\
drawtext=${DT_BTN}:text='Title 2':x=(w-tw)/2:y=195,\
drawtext=${DT_BTN}:text='Title 3':x=(w-tw)/2:y=250,\
drawtext=${DT_BTN}:text='Title 4':x=(w-tw)/2:y=305,\
drawtext=${DT_BTN}:text='Title 1 Chapters':x=(w-tw)/2:y=360" \
    -f lavfi -i "sine=frequency=330:duration=3" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/root_menu.mpg"

# Chapters sub-menu: dark blue-gray to distinguish from root menu
$FFMPEG -y -loglevel error \
    -f lavfi -i "color=c=0x222244:s=720x480:r=29.97:d=3,\
drawtext=${DT_HEADER}:text='CHAPTERS SUB-MENU (VTS 1)':x=(w-tw)/2:y=60,\
drawtext=${DT_INFO}:text='Title 1 chapter navigation':x=(w-tw)/2:y=100,\
drawtext=${DT_BTN}:text='Chapter 1':x=(w-tw)/2:y=200,\
drawtext=${DT_BTN}:text='Chapter 2':x=(w-tw)/2:y=260,\
drawtext=${DT_BTN}:text='Main Menu':x=(w-tw)/2:y=320" \
    -f lavfi -i "sine=frequency=550:duration=3" \
    -target ntsc-dvd \
    -c:a ac3 -b:a 192k \
    "$WORK_DIR/chapters_menu.mpg"

echo "=== Generating button highlight images ==="

# Button highlight images for spumux — white rectangles on transparent background.
# These define the clickable/highlightable button regions.
# Generated with ffmpeg (no imagemagick dependency).

# Root menu: 5 buttons stacked vertically
# Button 1: "Title 1"          y=130..170
# Button 2: "Title 2"          y=185..225
# Button 3: "Title 3"          y=240..280
# Button 4: "Title 4"          y=295..335
# Button 5: "Title 1 Chapters" y=350..390
$FFMPEG -y -loglevel error \
    -f lavfi -i "color=c=black@0:s=720x480:d=0.04,format=rgba,drawbox=x=240:y=130:w=240:h=40:color=white:t=fill,drawbox=x=240:y=185:w=240:h=40:color=white:t=fill,drawbox=x=240:y=240:w=240:h=40:color=white:t=fill,drawbox=x=240:y=295:w=240:h=40:color=white:t=fill,drawbox=x=240:y=350:w=240:h=40:color=white:t=fill" \
    -frames:v 1 "$WORK_DIR/root_highlight.png"

# Chapters sub-menu: 3 buttons at correct positions (matching XML button coords)
# Button 1: "Chapter 1"  y=190..235
# Button 2: "Chapter 2"  y=250..295
# Button 3: "Main Menu"  y=310..355
$FFMPEG -y -loglevel error \
    -f lavfi -i "color=c=black@0:s=720x480:d=0.04,format=rgba,drawbox=x=260:y=190:w=200:h=45:color=white:t=fill,drawbox=x=260:y=250:w=200:h=45:color=white:t=fill,drawbox=x=260:y=310:w=200:h=45:color=white:t=fill" \
    -frames:v 1 "$WORK_DIR/chapters_highlight.png"

echo "=== Muxing subtitles into menu videos ==="

# Root menu spumux config — explicit button regions with navigation links
cat > "$WORK_DIR/root_spu.xml" <<XMLEOF
<subpictures>
 <stream>
  <spu start="00:00:00.00" end="00:00:03.00"
       highlight="$WORK_DIR/root_highlight.png"
       select="$WORK_DIR/root_highlight.png"
       force="yes" >
    <button x0="240" y0="130" x1="480" y1="170" up="5" down="2" />
    <button x0="240" y0="185" x1="480" y1="225" up="1" down="3" />
    <button x0="240" y0="240" x1="480" y1="280" up="2" down="4" />
    <button x0="240" y0="295" x1="480" y1="335" up="3" down="5" />
    <button x0="240" y0="350" x1="480" y1="390" up="4" down="1" />
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
#   VMGM: root menu with 5 buttons → Title 1, Title 2, Title 3, Title 4, Title 1 Chapters
#   VTS 1: Title 1 (blue, 8s, 2 chapters) + chapters sub-menu (3 buttons)
#   VTS 2: Title 2 (green, 10s, 3 chapters) + Title 3 (yellow, 4s, 1 chapter)
#          (two PGCs in one titleset — Title 3 starts mid-VOB to test PGC bounds)
#   VTS 3: Title 4 (red, 6s, 1 chapter)
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
        <button>jump title 3;</button>
        <button>jump title 4;</button>
        <button>jump titleset 1 menu;</button>
      </pgc>
    </menus>
  </vmgm>
  <titleset>
    <menus>
      <pgc pause="inf">
        <vob file="$WORK_DIR/chapters_menu_sub.mpg" pause="inf" />
        <button>jump title 1 chapter 1;</button>
        <button>jump title 1 chapter 2;</button>
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
        <vob file="$WORK_DIR/title3.mpg" />
        <post>call vmgm menu 1;</post>
      </pgc>
    </titles>
  </titleset>
  <titleset>
    <titles>
      <pgc>
        <vob file="$WORK_DIR/title4.mpg" />
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
echo "  Title 3 (VTS 2, PGC 2): 4s, yellow test pattern, 1 chapter (550Hz tone)"
echo "  Title 4 (VTS 3): 6s, red test pattern, 1 chapter (660Hz tone)"
echo "  First Play → Root Menu"
echo ""
echo "Test with:"
echo "  cd server && cargo run -- $OUT_DIR/VIDEO_TS"
ls -la "$OUT_DIR/VIDEO_TS/"

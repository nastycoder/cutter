#!/usr/bin/env bash
# Render tutorial/tutorial.html → per-slide PNGs + the full PDF.
# Slides are 1280×720; the page's #N hash shows a single slide for screenshots.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
DIR="$(cd "$(dirname "$0")/../tutorial" && pwd)"
HTML="file://$DIR/tutorial.html"
SLIDES=$(grep -c '<section class="slide"' "$DIR/tutorial.html")

echo "Rendering $SLIDES slides from $DIR/tutorial.html"
rm -f "$DIR"/tutorial-*.png

for n in $(seq 1 "$SLIDES"); do
  out="$DIR/tutorial-$(printf '%02d' "$n").png"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1280,720 \
    --virtual-time-budget=3000 \
    --screenshot="$out" "$HTML#$n" 2>/dev/null
  echo "  $out"
done

"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=5000 \
  --print-to-pdf="$DIR/Cutter-Tutorial.pdf" "$HTML" 2>/dev/null
echo "  $DIR/Cutter-Tutorial.pdf"
echo "Done."

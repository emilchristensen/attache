# Gelasio for the Linux browser journeys

TEST-ONLY fonts: the Dashboard never loads them.
On Linux, `tests/e2e/fonts.ts` starts Chrome with `FONTCONFIG_FILE` pointing at `fonts.conf`, which maps the family "Georgia" to these files.
Gelasio is designed to be metric-compatible with Georgia, so headings in `var(--serif)` take the width they take on macOS and Windows.

Georgia ships only Regular, Bold, Italic and Bold Italic, so a heading at `font-weight: 500` renders Regular and one at 600 renders Bold there.
These four files are the same four faces, so Linux picks the same face for every weight.
A Medium or SemiBold face here would make Linux draw widths macOS and Windows never draw.

Source: `ofl/gelasio` in github.com/google/fonts at commit `a60a77e14f28abd4ef243a1b5dfc48df0cec5205`, Version 1.008, under the SIL Open Font License 1.1 (`OFL.txt`).
Google Fonts ships Gelasio as two variable fonts, so the static faces are instances of them made with fontTools 4.60.1:

```sh
uv run --with 'fonttools==4.60.1' python -c '
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
for src, wght, out in [("Gelasio[wght].ttf", 400, "Gelasio-Regular.ttf"), ("Gelasio[wght].ttf", 700, "Gelasio-Bold.ttf"),
                       ("Gelasio-Italic[wght].ttf", 400, "Gelasio-Italic.ttf"), ("Gelasio-Italic[wght].ttf", 700, "Gelasio-BoldItalic.ttf")]:
    instantiateVariableFont(TTFont(src), {"wght": wght}, updateFontNames=True).save(out)
'
```

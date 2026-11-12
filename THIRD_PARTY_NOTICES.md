# Third-party notices

Each upstream input is recorded here with its source, licence, pinned release and SHA-256.

## Natural Earth

- **What**: admin-0 country boundaries at 1:50m, and the 1:50m breakaway/disputed areas layer, as GeoJSON.
- **Source**: <https://github.com/nvkelso/natural-earth-vector>, tag `v5.1.2`, commit `f1890d9f152c896d250a77557a5751a93d494776`.
- **Licence**: public domain ("All versions of Natural Earth raster + vector map data … are in the public domain"). The upstream terms are kept as `vendor/natural-earth/LICENSE.md`. Made with Natural Earth.
- **Stored**: unmodified, in `vendor/natural-earth/`. The projected, simplified files under `data/geometry/` are derived from them by `scripts/build-geometry.js` (see `docs/DATA.md` → "Geometry").

| File | SHA-256 |
|---|---|
| `vendor/natural-earth/ne_50m_admin_0_countries.geojson` | `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb` |
| `vendor/natural-earth/ne_50m_admin_0_breakaway_disputed_areas.geojson` | `e91f0f9518b24355ceec6668f4df874d6f39db7d0bc9ec22d9b14429bfb6be01` |
| `vendor/natural-earth/LICENSE.md` | `2631b5b39b6d1acc56de75235109b5af2dbb4b0ac5a127b6f06185977247fd4b` |

No 1:10m file is vendored: every quizzed entry is drawn at 1:50m once overseas parts are split out (`docs/DATA.md` explains why).

## Courier Prime

- Project: https://github.com/quoteunquoteapps/CourierPrime (by Alan Dague-Greene for Quote-Unquote Apps)
- Version: **3.018** (the fonts' own version string; the repo has no tags or releases)
- Commit: `7fd585a2dd4c1612c79b3308e300923d1c13df93` (`master` HEAD, the commit Google Fonts onboarded; its TTFs and `OFL.txt` are byte-identical to `google/fonts` `ofl/courierprime/` at `9862abc066c9b83bf84c3e8ed1fc2d8d48f9bbf0`)
- Files (upstream has no `.woff2`, so the TTFs are shipped as they are):
  - https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/7fd585a2dd4c1612c79b3308e300923d1c13df93/fonts/ttf/CourierPrime-Regular.ttf (sha256 `72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af`)
  - https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/7fd585a2dd4c1612c79b3308e300923d1c13df93/fonts/ttf/CourierPrime-Bold.ttf (sha256 `ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638`)
  - https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/7fd585a2dd4c1612c79b3308e300923d1c13df93/OFL.txt (sha256 `9a755af092b494944c99f471be6fddd19b006a448fefdc4717e4ee0aa09a97b0`)
- Used for: `fonts/CourierPrime-Regular.ttf` and `fonts/CourierPrime-Bold.ttf`, all UI text (`css/style.css`). Unmodified and not renamed.
- License: SIL Open Font License 1.1, with no Reserved Font Name. Full text below, also at [`fonts/OFL.txt`](fonts/OFL.txt).

```
Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime).

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Pixel marks

`img/mark-check.svg` and `img/mark-cross.svg` are the 7 × 7 pixel ✓ and ✕ drawings from the sibling `flags` app (same owner), copied unchanged. They are used as CSS masks over the text colour.

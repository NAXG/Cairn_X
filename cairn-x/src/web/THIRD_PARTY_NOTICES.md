# pi-web attribution

Theme and resizable panel hooks adapted from agegr/pi-web, commit ce18006cd25acf937547c6ad13f46ebb75d82418. Workspace and message presentation inspired by that project.
Thinking-level map controls follow the Default / Disabled / Custom layout in agegr/pi-web `ModelsConfig.tsx`, reviewed at commit a26cc68df9227cb74253bddd7c59624aa475e61f.
Workspace shell, colour tokens (`light` / `dark` / `mist` / `rose` / `pine`), settings section icons, theme icons and the settings split view follow the design language of that project, reviewed at commit 1eb5e66a37c468aca7f0d338edb23de4fd84433e. Cairn keeps its own plain-CSS implementation; no Tailwind or Next.js code was copied.
Settings sections, the bottom-left dock, the conversation sliders, the provider list, the add-provider card grid and the plugin list/detail layout were reviewed against the same project on 2026-09-22; values were re-implemented in Cairn's design tokens.
`src/web/public/provider-icons.svg` is copied from agegr/pi-web `public/provider-icons.svg`.

https://github.com/agegr/pi-web

MIT License

Copyright (c) 2026 agegr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# LobeHub icons attribution

`src/web/public/provider-icons.svg` bundles provider brand icons derived from @lobehub/icons
(https://github.com/lobehub/lobe-icons), MIT License, Copyright (c) 2023 LobeHub. The sprite is
redistributed unmodified from agegr/pi-web, which carries the same notice in the file header.

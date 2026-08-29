# Divoom Pixoo64 — Homey App

Control your **Divoom Pixoo64** 64×64 pixel display from Homey Pro flows.

---

## Installation

```bash
npm install -g homey
homey app run       # live dev mode (logs stream to terminal)
homey app install   # install without logs
```

## Pairing

1. Homey app → **Devices → Add device → Pixoo64**
2. Use **Auto-detect** (cloud API + local network scan) or enter the IP manually
3. Find the IP in the Divoom app: *Device → Settings → IP address*

> **Tip:** Set a static DHCP reservation in your router so the IP never changes.

During pairing, the app automatically detects which local API revision your Pixoo64 uses:

| Revision | Endpoint |
|---|---|
| Legacy revision | `http://<ip>:80/post` |
| New revision | `http://<ip>:9000/divoom_api` |

The detected revision and endpoint are visible in the device's advanced settings. They are managed by the app and should not be edited manually.

Manual pairing accepts either a plain IP address, `IP:port`, or a full local API URL copied from a curl command. The app stores only the IP address and detects the correct endpoint itself.

---

## Core concept: two rendering systems

The app exposes two independent rendering systems that live side-by-side on the display. Understanding the difference is key to building reliable flows.

### 1 — Canvas (buffer-based)

The app maintains a **64×64 RGB canvas in memory** for each device. Drawing operations (`Fill`, `Draw rect`, `Draw image`, `Draw pixel text`, `Draw LaMetric icon`) paint pixels onto this canvas. The canvas is sent to the device as an animated GIF via the `Draw/SendHttpGif` firmware command.

| Characteristic | Detail |
|---|---|
| Managed by | Homey app (RAM + disk cache) |
| Compositing | Layers stack — each draw adds on top |
| Animated sprites | Multiple GIF sources merged into one animation |
| Screenshot | Full capture possible |
| Font rendering | PixelFont library (Tiny + 7 PNG fonts) |
| Persistence | Saved to `/userdata/` — survives app restarts |

**Caveats:**
- Every canvas send triggers a full GIF upload. The Pixoo firmware can only receive one frame at a time, so animation frames are sent sequentially — large or fast animations take longer to push.
- Animated GIFs are capped at **60 frames**, matching the Pixoo64 firmware limit. Larger animations take longer to upload because each frame is sent sequentially.
- Multiple animated sprites (different GIFs on the same screen) are merged into a single animation whose length is the LCM of the individual frame counts, capped at 60 frames.

---

### 2 — Firmware overlays (text-based)

Text placed with **Draw text at** or **Display text** uses `Draw/SendHttpText`, a separate firmware command. These overlays are rendered by the Pixoo firmware **on top of** the canvas GIF, independently of it.

| Characteristic | Detail |
|---|---|
| Managed by | Pixoo firmware |
| Fonts available | Firmware fonts 0–7 (selected by number) |
| Supports scrolling | Yes (`Display text`) |
| Captured by screenshot | **No** |
| Survives canvas sends | **Automatically re-applied** (see below) |

**Caveats:**
- `Draw/SendHttpGif` internally calls `Channel/SetIndex`, which **wipes all firmware text overlays**. The app works around this with an internal registry: every `Draw text at` call is stored, and after each canvas send the texts are automatically re-applied. You do not need to manage this manually.
- Up to **19 independent text slots** (IDs 2–20). Each ID is an independent overlay; writing to the same ID replaces it.
- `Display text` (scrolling) uses a different mechanism — it clears the registry and takes over the display. Do not mix `Display text` with `Draw text at` in the same scene.
- **Firmware built-in widgets** — Scoreboard, Timer — are also firmware-side and share the same limitations: they are not captured by screenshots and are cleared when the canvas is next sent.

---

## Flow cards reference

### Device control

| Card | Effect |
|---|---|
| **Set channel** | Switch to a built-in channel: 0=Clock, 1=Cloud, 2=Visualizer, 3=Custom, 4=Black |
| **Channel is** | Flow condition that checks the currently selected built-in channel. |
| **Set animation mode** | Choose how multiple animated sprites are composed: Balanced, Fast, Slow, or Timing-aware. |
| **Sync time** | Push the current time to the device's internal clock |
| **Play buzzer** | Sound the built-in buzzer for N seconds |
| **Screen on/off** | Toggle via the device tile or an on/off flow card |
| **Brightness** | Adjust the display brightness with Homey's standard dim slider (0–100 %). |

### Canvas (buffer) operations

| Card | Notes |
|---|---|
| **Fill screen** | Flood-fills the canvas with a solid colour. Previous content is replaced. |
| **Draw rect** | Paints a filled rectangle with opacity (0–100 %). |
| **Draw image at** | Downloads a URL (PNG/GIF), resizes to W×H, composites at (X,Y). |
| **Display Apple cover** | Same as Draw image at, but auto-switches Apple CDN URLs from .jpg to .png. |
| **Draw LaMetric icon** | Fetches an icon from the LaMetric library by ID. `Frame=0` uses all frames (animated). Zoom 1–8 scales the 8×8 native size. |
| **Draw pixel text** | Renders text onto the canvas using a pixel font. See Font section below. |
| **Display image** | Sends a full-screen image, replacing the canvas entirely (no compositing). |

### Firmware overlay operations

| Card | Notes |
|---|---|
| **Draw text at** | Places static text at pixel coordinates using a firmware font (0–7). Use a unique Text ID per label. |
| **Display text** | Scrolling text — takes over the display, clears all Draw text at overlays. |
| **Clear screen** | Wipes everything: black canvas, all sprites, all text overlays. Respects Hold — if Hold is active, the black screen is sent only on Release. |
| **Clear text overlays** | Removes all `Draw text at` labels from device and registry. Canvas and sprites are untouched. Respects Hold. |
| **Show scoreboard** | Firmware scoreboard widget (red/blue scores). |
| **Start / Stop timer** | Firmware countdown timer. |

### Batching

| Card | Notes |
|---|---|
| **Hold display** | Suspends all canvas sends. Draw operations still update the local canvas. |
| **Release display** | Flushes everything accumulated since Hold as a single send, including Clear screen and Clear text overlays. Use this to avoid the display updating progressively when building a complex scene. |

### Animation modes

| Mode | Behaviour |
|---|---|
| **Balanced** | Uses frame-count LCM and median sprite delay. Good compromise for most mixed LaMetric scenes. |
| **Fast** | Uses frame-count LCM and fastest sprite delay. Keeps motion responsive, but slow icons may run too fast. |
| **Slow** | Uses frame-count LCM and slowest sprite delay. Avoids over-speeding slow icons, but fast icons slow down. |
| **Timing-aware** | Default. Uses delay-aware cycle periods. More faithful to source GIF timing, but much more likely to exceed the 60-frame firmware budget. |

### Screenshots

| Card | Notes |
|---|---|
| **Take screenshot** | Saves the current canvas (with sprites at frame 0) to a numbered slot. **Firmware text overlays are not captured.** |
| **Display screenshot** | Restores a saved slot to the canvas and pushes it to the device. |

---

## Pixel fonts

`Draw pixel text` uses the built-in PixelFont renderer — text is painted directly onto the canvas buffer.

| Font | Style | Notes |
|---|---|---|
| **Tiny** | 3×5 px, uppercase only | Built-in, no external file |
| **Artos Sans** | 9 px tall, proportional | PNG font sheet |
| **Artos Serif** | 9 px tall, proportional | PNG font sheet |
| **Chroma 48** | 9 px tall, proportional | PNG font sheet |
| **Saïkyo Sans** | 9 px tall, wider | PNG font sheet |
| **Torus Sans** | 9 px tall, proportional | PNG font sheet |
| **Victoria** | 9 px tall, proportional | PNG font sheet |
| **Victoria Bold** | 9 px tall, bold | PNG font sheet |

PNG fonts preserve case (a–z and A–Z both present). Accented characters are automatically stripped to their base form (é→e, ç→c, etc.).

**Adding a new font:** drop a `.png` sheet into `assets/fonts/` following the same format (background `#000088`, glyphs `#FCFCFC`, column marker `#FC00FC` at row 0), then add an entry to the font dropdown in `app.json`.

---

## Typical flow patterns

**Static scene with text:**
```
Hold display
→ Fill screen (black)
→ Draw image at (album art, 0,0, 48×48)
→ Draw text at (artist, x=0, y=50, font=2, textId=2)
→ Draw text at (title,  x=0, y=57, font=2, textId=3)
→ Release display
```
Using Hold/Release ensures the display updates atomically — no intermediate states are shown.

**Overlay text on a live canvas:**
```
Draw text at (temperature, x=0, y=0, textId=5)
```
The text persists across subsequent image/animation updates because it is re-applied automatically by the app after every canvas send.

**Restore a saved background:**
```
Display screenshot (slot 1)        ← restore saved background
→ Draw text at (time, textId=2)    ← add live overlay on top
```

**Adjust brightness from ambient light:**
```
When ambient light changes
→ Set brightness / dim level on Pixoo64
```
Use Homey's standard dim action. A bright room can set 80–100 %, while evening or night flows can set a lower value such as 10–30 %.

---

## AI-assisted development

This app is developed and maintained by **DJP** with extensive assistance from **OpenAI Codex**. Codex has been used to analyze the Homey and Divoom documentation, investigate user diagnostics, propose architecture, implement and review changes, write tests, and maintain the project documentation.

The app is not developed or published autonomously. DJP selects the features, reviews the changes, tests the behavior on real Pixoo64 hardware, validates each release with the Homey tooling, and remains responsible for maintenance and publication.

---

## Project structure

```
com.divoom.pixoo64/
├── app.js                    # Flow card listeners
├── app.json                  # Homey manifest (capabilities, flow cards)
├── lib/
│   ├── PixooApi.js           # HTTP client + canvas engine (zero npm deps)
│   ├── PixelFont.js          # Pixel font renderer (Tiny + PNG fonts)
│   └── ImageDecoder.js       # PNG/GIF decoder
├── assets/
│   ├── fonts/                # PNG font sheets (ArtosSans, Victoria, …)
│   └── display/              # Bundled display assets
└── drivers/pixoo64/
    ├── driver.js             # Pairing (auto-discover + manual IP)
    ├── device.js             # on/off capability, 60 s poll
    └── pair/                 # Custom pairing UI
```

Zero npm runtime dependencies — all networking and image decoding uses Node.js built-in modules.

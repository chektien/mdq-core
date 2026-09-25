# Local Runtime Config

MDQ can read optional runtime settings from `data/config.json`.

Quick start:

```bash
cp data/config.example.json data/config.json
```

Then edit the values you want. If `data/config.json` is missing, mdq keeps the existing defaults.

Supported keys:

- `port`: server port, defaults to `3000`
- `portFallbacks`: how many higher ports mdq will try if the requested port is busy, defaults to `10`
- `deckDir`: alternate deck folder, resolved relative to `data/config.json` when you use a relative path
- `quizDir`: legacy alias for `deckDir`
- `instanceId`: stable label for this machine or classroom instance
- `theme`: UI theme, `dark` by default, or set `light` to reuse the optional light palette
- `palette`: slide colour palette, `classic` by default, or set `gruvbox`. It applies in both themes, a deck's `palette:` preamble line overrides it, and the `MDQ_PALETTE` environment variable overrides the file value
- `autoGenerateStudentIds`: set `true` to ask students only for their name and generate a hidden student ID automatically

Example:

```json
{
  "port": 3100,
  "portFallbacks": 3,
  "deckDir": "./decks",
  "instanceId": "seminar-room-a",
  "theme": "dark",
  "palette": "classic",
  "autoGenerateStudentIds": false
}
```

Practical extra customizations you can keep in the same file:

- move deck editing to another local folder with `deckDir`
- reduce `portFallbacks` if you want mdq to fail fast instead of scanning many ports
- set a memorable `instanceId` so logs and access checks are easier to read on shared teaching machines
- switch to `theme: "light"` when you want the alternate light presentation for a room or event
- set `autoGenerateStudentIds: true` when you want a name-only student join form

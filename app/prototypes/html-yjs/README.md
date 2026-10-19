# HTML collaboration prototype

A standalone maintainer-evaluation demo of **ProseMirror + y-prosemirror + Yjs
13**, using HTML scenes. It does not replace Novalist's editor or change project
file formats. All new editor dependencies are development-only.

## Run

From the client repository root, enter `devenv shell`, then:

```sh
cd app
npm ci
npm run prototype:html
```

Open **http://127.0.0.1:5187**. No backend, database, account, or sync server is
needed. The two panes represent different users within one browser page; they
are separate `Y.Doc` instances, not two views of one shared instance. Opening a
second browser tab creates an unrelated demo session.

Outside devenv, use the Node version required by `app/package.json`. The demo
uses the normal app lockfile; no global JavaScript packages are needed.

## Try it

1. Edit the sample in Alice's pane and watch Bob's pane change.
   Each pane lists the participants visible to it. Focusing/selecting text in
   one pane displays its named remote caret and selection in the other.
2. Select text and try Bold, Italic, or Underline. Each pane shows its current
   exported HTML below the rich-text editor.
3. Click **Disconnect peers**, edit both panes, then **Reconnect peers**. Both
   documents should converge while keeping both sets of changes. Remote
   presence disappears on disconnect and is republished on reconnect.
4. Undo in Alice's pane. Alice's edit should disappear without removing Bob's
   contribution. Try Redo, too. Keyboard undo/redo uses the Yjs binding.
5. Paste a **copy of the HTML body** of an existing scene into Source HTML
   fragment, or open a copied `.html` file. Click **Import into fresh demo**.
   Import intentionally discards the current demo documents and undo history.
6. Inspect the **Initial import fidelity report**, including the original,
   sanitized, and projected HTML. Try a table to see a schema-loss report.
7. Use **Download HTML** to export either current document as a new HTML file.

This is memory-only: reloading loses edits. Nothing writes into a project. Do
not use it as your working scene editor. A `.novalist` file also has a scene-ID
comment; this demo handles HTML fragments, not that file-format wrapper.

## What the prototype demonstrates

- Import once into one Yjs document, then transfer its binary state. Independent
  HTML imports on both peers would create duplicate content on merge.
- Fine-grained editor changes via the existing `y-prosemirror` binding, not
  whole-HTML replacement on every keystroke.
- Independent undo histories, offline concurrent editing, and state-vector
  catch-up. `DemoTransport` is a local experiment, not production transport.
- Named remote cursors, selection highlights, and per-pane participant lists
  using `y-protocols` Awareness and the established `yCursorPlugin`. Presence
  updates are separate from document updates and are never saved in the HTML
  or document state. A blurred pane remains present but clears its cursor.
- HTML parsing/serialization through a small explicit ProseMirror schema.
- Reuse of the **actual existing editor sanitizer** (`purify.min.js` and
  `scene-html.js`) for import, paste, and export, including in the static build.
- A representative sample that preserves paragraph class/style, inline marks,
  lists, an image, entity mentions, comment spans, footnote markers, and
  insertion/deletion annotations through initial import/export.

`exactSourceMatch` compares the original and exported strings.
`parsedHtmlMatch` compares parsed DOM trees, ignoring only browser serialization
and attribute order. It does not treat whitespace changes, dropped wrappers, or
`b` → `strong` normalization as equivalent. `sanitizerChanged` and `schemaChanged`
identify which stage changed the fragment. A fidelity match describes the
**initial import only**; it is not a certification of editing behavior or visual
parity. The original input is retained in the report even when import is lossy.

## Deliberate limits and maintainer evaluation

The prototype is evidence for an architectural choice, not a migration proposal
with feature parity already established:

- Tables, arbitrary block wrappers, unsupported attributes, and arbitrary HTML
  are not fully modeled. Import may normalize or lose them; the report exposes
  this. Preserving unsupported HTML requires schema work, not hiding differences.
- Annotation IDs and suggestions markup are preserved by the sample schema, but
  comment/footnote **bodies** in scene metadata are not loaded. There is no comment
  gutter, mention picker, suggestion creation/accept/reject UI, or automatic
  footnote renumbering. Existing suggestion wrappers are editable as ordinary
  annotated rich text, not a complete track-changes implementation.
- CSS classes and inline styles survive where supported; the complete Novalist
  paragraph-style/theme system is not installed. Stored image paths/URIs survive
  import/export, but project asset resolution is not integrated. Only data/blob
  images render; the demo CSP blocks other image fetches and embedded frames.
- Pagination, grammar decorations, dictation, full list-editing commands,
  accessibility parity, IME behavior, and large-scene performance still
  need manual evaluation or further implementation. IME support comes from the
  editor framework but has not been independently validated here.
- Everything runs on the browser's main thread. A production binding needs a
  local Yjs replica in the editor process, with binary updates sent to the
  long-lived host over MessagePort. The host-only manager is not integrated.
- This representation is **not** the generic `sceneCodec.ts` XML representation.
  y-prosemirror uses its own text/mark conventions. The prototype is independent
  of that codec and the unfinished document-manager work.
- No encryption, persistence, networking between computers, file watcher, JSON
  synchronization, binary-state restore UI, or changes to the server design's
  decision log are included. Those remain separate integration work.

Before adopting the editor, evaluate representative scene copies, nested and
overlapping annotations, typing at annotation boundaries, paragraph splitting,
paste/drag/drop, undo across remote changes, input methods, and import/export
against the existing editor. Any migration must preserve content and maintain
the existing HTML-based scene file format.

## Verification and static build

```sh
npm run prototype:html:build
npm run prototype:html:test
```

The build typechecks the prototype and emits `prototypes/html-yjs/dist/`, which
can be served by a normal HTTP static server. Open it at the server root, not a
subpath or a `file://` URL (the sanitizer URLs are root-relative). It contains
only the demo bundle and the two sanitizer assets, not the whole desktop app.

Tests use Playwright Chromium. On Linux, devenv supplies a NixOS-compatible
Chromium executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. On other
systems, install the matching browser with `npx playwright install chromium` if
needed. An existing browser path may also be supplied through that environment
variable. The tests cover sample fidelity, independent initialization, offline
inserts and local undo/redo, concurrent deletion/formatting, lossy/unsafe imports,
local HTML input, and HTML downloads.
Presence tests cover named cursors/selections, participant lists, disconnect/
reconnect, and exclusion of presence decorations from exported HTML.

## Dependency rationale

The additional MIT-licensed development packages are `y-prosemirror` (existing
collaboration binding), its `y-protocols` peer dependency, and ProseMirror's model,
state, view, basic/list schemas, commands, and keymap packages. These let us test
an established rich-text collaboration implementation rather than writing a
custom DOM binding. No provider service, Tiptap backend, or paid component is
required. The production entry points do not import this prototype.

---
name: confluence-whiteboard-export
description: Export a Confluence whiteboard as Confluence's own PNG, PDF, or JPG, or as a cropped SVG with every pasted image embedded. Use for a whiteboard, flowchart, or diagram; for getConfluenceContent; when an SVG image has no href; or when the user runs /confluence-whiteboard-export.
---

# Confluence whiteboard export

The content id is the number in `/wiki/spaces/<space>/whiteboard/<id>`.

Choose the file from the need:

- A picture someone will read: PNG from the whiteboard's Export dialog. Use PDF when they want a document, and JPG only when they ask for JPG.
- The vector file, a crop, or the pasted pictures inside the SVG: the SVG path below.

`getConfluenceContent` with `content_format: png` is a small preview of about 1920×1080. The Export dialog is the downloadable picture.

## Readable picture

Open the whiteboard URL in a browser that is already logged in to that Confluence site.

If that profile is locked by a running Chromium, copy its user-data directory. Exclude `Cache`, `Code Cache`, `GPUCache`, Dawn caches, `SingletonLock`, `SingletonCookie`, and `SingletonSocket`. Launch against the copy, then delete the copy. Leave the running browser on its own profile.

1. In the content header, open the last **More actions** control (the one beside Share) and choose the **Export** menu item. Hovering the item does not open the dialog.
2. The dialog is inside `iframe[title="whiteboard-frame"]`, not the parent page.
3. Set the file type. Set the export area to **Entire board**. Set quality to **High quality** when that option exists. The quality control is the react-select whose value reads "Normal quality" or "High quality". An input covers that value, so force-click its `[id$="single-value"]`, then choose the high-quality option.
4. Click the button whose accessible name is exactly **Export**. Wait for the browser download and save that file.

Check a full-resolution crop of the saved file before calling it readable. A chat preview of a board several thousand pixels wide looks empty even when the file is sharp. Hand over the file and say to open it.

## SVG, crop, and pasted images

1. Call Rovo `getConfluenceContent` with the site cloud id, `content_id`, and `content_format: "svg"`. An empty `notifications/initialized` response is success. Save the raw tool text somewhere temporary, outside the repo.
2. Run `scripts/extract_svg.py <tool-output> <out.svg>` from this skill directory. The tool text is nested JSON. Slicing at the first `<svg` while the payload is still escaped writes an invalid file.
3. Count `<image` elements. Each has an `id` and a `data-file-id` and no pixel href. Attachment listing and a direct media fetch do not return those pixels.
4. In the same whiteboard iframe, the pasted pictures are `blob:` images. Wait until `naturalWidth` is greater than 0. Repeat the collection until every SVG image id has a file, or a second pass adds nothing. A picture can finish loading after the first pass.
5. Match each image's closest parent `data-entity-id` to the SVG attribute named `id`. The attribute is `id`, matched as a whole name. Save the original bytes under that id. Ignore https images whose parent id is not an SVG image id; those are chrome, not pasted pictures.
6. Write the bytes from the browser to disk. When the automation channel truncates large results, return 8 KB slices prefixed with text such as `WBi:<offset>:`, then concatenate and decode locally. The prefix must not start with `data:image/` or `/9j/`. A request from the https page to an http loopback does not carry the bytes out.
7. Put the files in one directory as `<id>.png` or `img-<n>-<id>.png` (jpg and webp are accepted). Run `scripts/embed_and_crop.py <in.svg> <image-dir> <out.svg>`. The script keeps each image's x, y, width, and height, embeds the original bytes as `href` and `xlink:href`, crops the viewBox to the content plus 80 units, and paints a white background. It leaves text, fonts, and tspans as they were. If it prints `missing`, those ids still need their files. Run it again after saving them.
8. A PNG rasterized from this SVG is a picture of the structured file. When someone needs the original lettering, deliver the Export file from the first section.

Media URLs in the page contain a credential query. Do not print, log, or commit them, cookies, or API tokens. Do not commit the profile copy or the raw tool payload.

# Privacy

ChatGPT Archive for Obsidian is designed to work locally in the browser.

## Data handling

- No analytics or telemetry.
- No external project backend or cloud service.
- No extension storage is used for conversation content.
- The content script runs only on `chatgpt.com` and the legacy `chat.openai.com` match pattern declared in `manifest.json`.
- To preserve user-uploaded images whose URLs require the current ChatGPT session, the extension performs a same-origin `fetch(..., { credentials: "include" })` from the active ChatGPT page. When no independently fetchable final URL is available, the image is converted to a data URL inside the temporary archive DOM.
- The temporary archive DOM is handed to Obsidian Web Clipper only when the user opens/runs Web Clipper.

## Important

Obsidian Web Clipper and any Interpreter provider configured inside Web Clipper have their own data-handling behavior. If you enable Interpreter prompts, review the provider and Obsidian settings you use. This extension deliberately creates a text-only Interpreter context so inline Base64 image data is not included in that context.

When reporting bugs publicly, do not paste private conversation text, signed image URLs, or screenshots containing sensitive information. Prefer the diagnostic summary after reviewing it first.

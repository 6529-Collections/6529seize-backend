# Push notification previews

Push previews of drop and DM content use compact plain text. Headings retain
their text on a separate line, emphasis delimiters are removed, lists retain
bullets or numbering, and ordinary links show their labels. Blank lines are
collapsed. Blockquotes are enclosed in curly double quotation marks (“quoted
text”), and inline code uses curly single quotation marks (‘npm test’). Nested
blockquotes alternate double and single quotation marks. Multiline code blocks
remain plain text without added quotation marks. Code content and escaped
punctuation remain readable.

Image references and links to uploaded media are omitted from the text, as in
the existing push sanitizer. When Markdown produces no text, the handler uses
the existing attachment summary or the notification's fallback text. Mentions
and emoji still use the existing push formatting. Preview conversion happens
before notification length limits are applied.

The original drop keeps its Markdown and renders normally inside the app.
Notification titles, attachment filenames, permissions, and delivery settings
are unaffected.

## Help bot corpus handoff

The paragraphs above are the backend-owned facts for questions about Markdown
in push notifications. The live help bot currently consumes the frontend-owned
help index; this backend-only change does not publish these facts into that
index. A future frontend corpus update can incorporate them when this behavior
is released. Until then, the bot should not infer this unreleased preview
behavior from the frontend corpus.

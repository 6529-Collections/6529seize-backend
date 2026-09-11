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
before the outgoing notification is sized.

Android and iOS use the same payload budget. Titles and bodies no longer have
fixed 50- and 250-character limits: text that fits is sent in full. The handler
counts UTF-8 bytes, including JSON escaping, routing data, image URLs, and
platform settings, and reserves 512 bytes below the 4 KB provider limit for
provider-added fields. The recipient token is transport and is not counted.
The phone controls how much of the delivered text it displays.

When necessary, the handler removes text from the end of the body and appends
`...`, preserving Unicode code points. Unusually large titles are shortened
only when necessary after reducing the body. An image that cannot fit even
with minimal text is omitted. Routing data is never truncated; if metadata
alone cannot fit, that notification is reported as failed without preventing
other notifications in the batch from being sent.

The formatter enforces the existing 25,000 UTF-16-code-unit drop-part limit
before parsing. Oversized historical content and parser failures use the
attachment summary or fallback text instead of retrying Markdown formatting or
cutting through a link destination. Bare media URLs are removed before choosing
that fallback, including when they appear in quotes or code.

The original drop keeps its Markdown and renders normally inside the app.
Title formatting, attachment filenames, permissions, badges, and sound settings
are unaffected. The payload budget applies to all outgoing notification types.

## Help bot corpus handoff

The paragraphs above are the backend-owned facts for questions about Markdown
in push notifications. The live help bot currently consumes the frontend-owned
help index; this backend-only change does not publish these facts into that
index. A future frontend corpus update can incorporate them when this behavior
is released. Until then, the bot should not infer this unreleased preview
behavior from the frontend corpus.

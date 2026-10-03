# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub's **[Security advisories](https://github.com/JustinWi/almost-video-feedback/security/advisories/new)**
("Report a vulnerability" on the repo's Security tab). I'll acknowledge within a few days and work with
you on a fix and disclosure timeline.

Good things to include: what an attacker can do, steps to reproduce, the affected file(s), and a
proof-of-concept if you have one.

## Scope

This is a local-only Chrome extension with **no backend** — there are no servers, accounts, or
network endpoints to attack. The most relevant areas are:

- DOM/HTML injection in the overlay, popup, or recordings page from a hostile **page being reviewed**
  (page-derived element text, URLs, selections).
- Anything that could make the extension send data off-device, run remote/dynamic code, or escalate
  the permissions it already has.
- Prompt-injection: `feedback.md` can contain text copied from the reviewed page, which is later
  pasted into an AI agent. Treat the page content as untrusted.

## What this extension does with your data

See the **Privacy & security** section of the [README](README.md). In short: screenshots and
transcripts stay on your device (Downloads + the extension's local storage); the extension sends no
user data anywhere — its only network request is an optional once-a-day GET to `api.github.com` for
the latest release tag (the update check; off in Settings → Updates). Speech transcription uses
Chrome's built-in Web Speech API, which sends
microphone audio to the browser's speech service (Google) — the same as voice typing.

## Supported versions

The latest release on `main` is supported. This is a young project; fixes ship to `main` and a new
release.

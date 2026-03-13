# SignalTrace

`SignalTrace` is a Chrome extension for capturing, inspecting, filtering, replaying, and archiving browser communication in real time.

It started as a `postMessage` listener tracker. It is now a broader browser telemetry and traffic-analysis tool that can observe:

- `postMessage` listeners and traffic
- WebSocket traffic from both the page layer and Chrome DevTools Protocol
- HTTP request/response metadata, headers, and bodies when available
- Cross-tab history with replay tooling

## What It Does

SignalTrace is built for security research, reverse engineering, client-side debugging, and browser protocol analysis.

It gives you:

- Early `MAIN`-world instrumentation at `document_start`
- Multi-frame coverage with `match_about_blank` and `match_origin_as_fallback`
- Browser-level WebSocket capture through `chrome.debugger`
- Joined HTTP request/response capture through CDP `Network`
- Live console output inside the tab where traffic was captured
- Popup controls for enabling, disabling, and filtering each capture surface
- A full `history.html` archive view across tabs
- A `resend` workflow to modify and replay captured traffic
- Persistent archive storage in `chrome.storage.local`

## Core Capabilities

### `postMessage`

- Hooks listener registration and `onmessage`
- Logs sent and received traffic
- Can filter `null` payloads by default
- Supports multiple block filters using contains-or-regex matching

### WebSockets

- Page-level interception for socket creation, sends, receives, and lifecycle events
- Browser-level frame capture via `chrome.debugger`
- Separate controls for client-side and server-side traffic
- Multiple block filters for inbound and outbound frames

### HTTP

- Request and response correlation via CDP `requestId`
- Captures method, URL, status, headers, and best-effort request/response bodies
- Request/response body capture can be toggled independently
- Multiple HTTP block filters supported

### History and Replay

- Unified history across tabs
- Protocol-aware badges for `postMessage`, `WebSocket`, and `HTTP`
- Search and filtering in the archive UI
- Resend tab for editing and replaying captured communications

## Interfaces

### Popup

The extension popup is the operational control plane. It lets you:

- Enable or disable each capture type globally
- Configure block filters
- Tune max events per tab
- Persist or clear the browser-local archive
- Open the full history view

### History Page

The history page is the forensic archive. It lets you:

- Review captured events across all tabs
- Filter by source type
- Search payloads, metadata, and targets
- Open replayable entries in the resend tab

### Resend Page

The resend page is the manual replay console. It supports:

- Editing HTTP method, URL, headers, and body
- Editing WebSocket payloads before replay
- Editing `postMessage` payloads and `targetOrigin`

## Installation

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the `chrome/` directory from this repository.
6. Accept the `debugger` permission when Chrome requests it.

## Practical Notes

- WebSocket frame capture is strongest when `chrome.debugger` is enabled.
- HTTP body capture is best effort and depends on what Chrome exposes through CDP.
- `postMessage` replay can resend into the same tab context, but it cannot perfectly reconstruct every original source frame relationship.
- Resending a WebSocket message opens a new socket to the original URL; it does not reuse the original live connection.
- Large traffic volumes are expected. Use filters and archive settings aggressively on high-churn targets such as exchanges.

## Why This Is Useful

SignalTrace is useful when you need to answer questions like:

- What messages are moving between frames right now?
- Which WebSocket feed is driving this UI?
- Which request created this state transition?
- What exact payload can I replay after modifying it?
- Which noisy channels should be filtered out automatically?

## Current Focus

This project is optimized for:

- Browser application traffic inspection
- Exchange and real-time app analysis
- Security testing and communication mapping
- Rapid capture, triage, and replay from the browser itself

## Limitations

This extension is strong, but not omniscient.

- It cannot guarantee capture of communication that occurs before hooks or debugger attachment are active.
- Some workers and browser-managed contexts remain partially observable or unobservable.
- HTTP and WebSocket capture through `chrome.debugger` can conflict with an active DevTools debugger session on the same tab.
- Chrome extension APIs impose storage and execution constraints that make this a best-effort capture system, not a perfect network recorder.

## Repository Layout

- `chrome/manifest.json`
- `chrome/background.js`
- `chrome/content_script.js`
- `chrome/injected.js`
- `chrome/popup.html`
- `chrome/history.html`
- `chrome/resend.html`

## Credit

The original project concept came from Frans Rosén's `postMessage-tracker`. This repository now extends that foundation into a broader browser communication analysis tool.

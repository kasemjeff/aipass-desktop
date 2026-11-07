# Platform verification checklist

What CI proves and what it does not.

CI runs on all three platforms: the Node suite (`npm test`), the shell's
Rust tests (`cargo test`), and a full bundle build (`npm run desktop:build`,
which produces the NSIS/.app/.dmg/deb/AppImage artifacts with checksums).
That is proof the code **compiles and passes its tests** on Windows, macOS
and Linux.

It is NOT proof the app works on real hardware. The items below need a
person on a real machine. A platform is "ready-to-ship" when every box is
checked on that machine; until then the README calls macOS and Linux
**ready-to-try, not ready-to-ship**.

## Windows (verified)

The reference platform. WebView2 + MSVC. Verified end to end.

- [x] Window opens, tray icon appears, close minimizes to tray
- [x] Backend child starts, sidebar + composer render, SSE stream live
- [x] Backend killed → shell restarts it with backoff, window reconnects
- [x] Window geometry persists across restarts
- [x] Token bootstrap (/token + EventSource ?token=) works in WebView2

## macOS (needs a real Mac)

WebView is WKWebView; the tray and process-group kill are the parts a
Windows machine cannot exercise.

- [ ] App opens from the .app / .dmg; no Gatekeeper block beyond the
      unsigned-app warning (signing status: see RELEASE.md)
- [ ] Window opens, content renders (WKWebView, not a blank shell)
- [ ] Tray/menu-bar icon appears; Quit actually quits (no orphan backend)
- [ ] Closing the window keeps the backend alive; relaunch reattaches to it
- [ ] Killing the backend (or letting it crash) → shell restarts it, the
      window reconnects and replays the tail
- [ ] Window geometry persists across restarts (frame save/restore)
- [ ] Keyboard: Cmd/Ctrl shortcuts, palette, focus ring visible
- [ ] File picker / drag-and-drop attach works; paste of an image attaches
- [ ] Dark/light mode follows the system theme
- [ ] Token bootstrap works in WKWebView (the same-origin path)

## Linux (needs a real Linux desktop)

WebView is WebKitGTK; tray support depends on the desktop environment
(appindicator). Note which desktop environment was used.

- [ ] App opens from the .deb / AppImage; no missing-library errors
- [ ] Window opens, content renders (WebKitGTK)
- [ ] Tray icon appears in the test environment (appindicator); if it does
      not, record the environment and say so in the README
- [ ] Backend child starts, sidebar renders, SSE stream live
- [ ] Killing the backend → shell restarts it with backoff, window
      reconnects
- [ ] Window geometry persists across restarts
- [ ] Keyboard shortcuts, palette, focus visible
- [ ] File picker / drag-and-drop attach works
- [ ] Token bootstrap works in WebKitGTK

## How to flip the README

When macOS or Linux passes its list, change the README wording for that
platform from ready-to-try to verified, and note the date and the machine.
One machine is a signal, not a guarantee — say what was actually run.

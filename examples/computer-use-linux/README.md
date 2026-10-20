# Computer-use on Linux (Docker example)

Builds an image with everything `LocalProvider` needs and runs a short script:
start Xvfb + Chromium + x11vnc, calibrate page↔desktop coordinates, click a
link by page coordinates, take a desktop screenshot.

```bash
cd examples/computer-use-linux
docker build -t node-scraper-computer-use .
docker run --rm --shm-size=1g node-scraper-computer-use
```

Notes

- Containers run as root without user namespaces, so Chrome's sandbox cannot
  start: the image sets `BNCA_CHROME_NO_SANDBOX=1` explicitly. Do not do this
  on a host where the sandbox works.
- VNC binds to `127.0.0.1` with no password by default. To view it from
  outside the container, run your own authenticated viewer bridge (e.g.
  websockify + noVNC behind your auth) or pass
  `vnc: { bind: '0.0.0.0', password: '…' }` and publish the port deliberately.
- The example prints the connection metadata (`host`, `port`, `auth`,
  `loopbackOnly`) so a host application can attach its viewer.

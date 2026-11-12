# ELK.js vendored dependency

Version: **0.12.1** (pinned).

Upstream: https://github.com/kieler/elkjs
npm archive: https://registry.npmjs.org/elkjs/-/elkjs-0.12.1.tgz

The browser bundle, worker, package metadata, and license were copied unchanged
from the npm archive. No install scripts were run. ELK.js is distributed under
EPL-2.0; see `elkjs-LICENSE.md` for the complete upstream license.

The main bundle includes an in-process worker implementation as a fallback.
The separate worker keeps layout calculation off the browser main thread.
Both are served by DSS from this plugin; no CDN calls are made.

## SHA-256

```text
b1032b7cfd2a57c54c6f0e8369d7665e19a579954f7cd20a6dae28f1912ea0d7  elk.bundled.js
dca3a19d9ec37f5634bf5876b4ebd2455c3f43f0d32570136c13c13edaba9bfb  elk-worker.min.js
637e81f4a1b6b4079535c499fca05e238cf7605c1ff5b76d60d7da7ce96700c9  elkjs-LICENSE.md
2cf15ab73c358103ac1bdb94ff4ede887c5ca3efaf3d579ade4b7c289eca3bc5  elkjs-package.json
```

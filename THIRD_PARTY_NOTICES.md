# Third-party notices

Voice rooms include the unmodified LiveKit client (Apache-2.0). HTML previews
bundle unmodified DOMPurify (Apache-2.0 OR MPL-2.0) with Fizzer's guard code.
Their license texts are served in `third-party/` and the preview sanitizer's
license is also included in the backend release's `priv/` directory. Sources:
<https://github.com/livekit/client-sdk-js> and <https://github.com/cure53/DOMPurify>.

Fizzer Desktop includes `@resvg/resvg-js` 2.6.2 and its platform-specific
native binding for rendering SVG attachments. resvg-js is distributed under
the Mozilla Public License 2.0.

The complete MPL-2.0 text is shipped beside this file as `LICENSE`. Source code
is available from <https://github.com/thx/resvg-js> and the corresponding npm
package. Fizzer does not modify resvg-js.

Electron's own notices are shipped as `LICENSE.electron.txt` and
`LICENSES.chromium.html`.

Fizzer Desktop also includes an Erlang/OTP + Elixir release and its Hex
dependencies so the private local service can run without a separately
installed server. Their notice, Apache-2.0 text, and package license files are
shipped under `embedded-runtime/backend-licenses/`.

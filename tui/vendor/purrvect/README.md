# Purrvect

Vector content for terminals. The shared core and CLI use C++17 and ThorVG;
the public interface is plain C. Building Purrvect requires no Zig or Rust.

```sh
brew install cmake pkgconf thorvg
PKG_CONFIG_PATH="$(brew --prefix thorvg)/lib/pkgconfig" cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
build/purrvect render examples/shapes.svg /tmp/shapes.pam 1280 480
build/purrvect encode examples/shapes.svg
build/purrvect encode --width 80 --height 16 examples/shapes.svg
```

CMake discovers ThorVG 1.0.7+ through pkg-config. On other platforms, install
ThorVG and point `PKG_CONFIG_PATH` at its pkg-config directory if necessary.
`cmake --install build --prefix /your/prefix` installs the CLI, library and header.
The default library is static; configure `-DBUILD_SHARED_LIBS=ON` for a shared library.

The renderer owns a ThorVG picture and redraws its retained geometry into a
requested viewport. Output preserves aspect ratio and transparency. The sample
SVG has no background rectangle, so the terminal background shows through.
The PAM command is an offline diagnostic. The transport encoder sends the original SVG,
not a rasterized image, in Kitty-style base64 chunks. After the final chunk,
the encoder returns the cursor to the left margin without adding another row
to the terminal's image-placement cursor movement.
Each transmission lets the terminal allocate a fresh image ID, so repeated
invocations preserve earlier images in scrollback instead of replacing them.
Normal terminal scrollback and image-storage limits still apply.
`encode --width COLUMNS --height ROWS` constrains the terminal placement to an
explicit cell rectangle. Either option may be used independently; omitted height
keeps the terminal's automatic aspect-ratio height. When width is omitted and
stdout is a terminal reporting its pixel dimensions, the encoder chooses
a column count close to the SVG's intrinsic width, capped at the current terminal
width. Command +/− then scales the placement with the font, preserving the SVG's
aspect ratio. Ghostty redraws larger placements from retained vectors after the
CLI exits. The column count stays fixed when the window changes; this is font
zoom, not continuous fit-to-window sizing. Redirected output or terminals without
pixel dimensions keep intrinsic pixel sizing.

Format `f=1001` is a private experimental value, not an upstream Kitty assignment.
Stock Ghostty does not accept it. The sibling Ghostty checkout now has an opt-in
Zig adapter for direct SVG transmission, retained documents, image cleanup, and
placement-sized redraw. Build Purrvect's default static library first, then build
Ghostty on this Apple Silicon development machine with:

```sh
cd ../ghostty
zig build -Doptimize=ReleaseFast -Dxcframework-target=native -Dpurrvect="$PWD/../purrvect"
open -n zig-out/Ghostty.app
```

In the newly opened terminal, run the example using its complete filename:

```sh
~/mystuff/Coding/purrvect/build/purrvect encode ~/mystuff/Coding/purrvect/examples/shapes.svg
```

The build links the Homebrew ThorVG dylib; this is a local development bundle,
not a portable release. In the patched app, `purrvect encode FILE.svg` sends the
experimental stream directly. The CLI does not yet probe terminal capabilities.
Animation commands are unsupported for retained SVG images. Larger placements
trigger redraws, capped at 4096 pixels per axis; smaller placements reuse the
cached higher-resolution texture.

`include/purrvect.h` exposes an opaque document with load, size, render and free
functions. The C++ implementation owns engine references and retained geometry;
callers own their RGBA output buffers. No C++ types or exceptions cross the ABI.
Operations are internally serialized; callers must not free a document while
another call uses it. Other terminals can implement adapters in their own language
and link this library, ThorVG and the C++ runtime. Input is limited to 4 MiB and
render dimensions to 4096 per axis. Before accepting terminal-supplied SVG, the
integration also needs an external-resource policy, font setup, and memory/work
budgets; the current parser is a local-file prototype.

The C test exercises retained redraw at several resolutions, transparent
letterboxing, dimension validation, and independent document lifetimes.
The old Zig core and Rust scaffold have been removed; Zig remains only in Ghostty.

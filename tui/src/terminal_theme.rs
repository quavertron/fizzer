//! Resolve Ghostty's configured background once, including theme/config-file settings.
use ratatui::style::{Color, Modifier, Style};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static BACKGROUND: OnceLock<Option<Color>> = OnceLock::new();

/// The foreground used for ordinary terminal text.  `Reset` lets the terminal
/// choose its configured default instead of baking in a light- or dark-theme
/// assumption.
pub fn body_text() -> Color {
    Color::Reset
}

/// The terminal's configured background, when it can be discovered.
///
/// We intentionally return `Reset` when discovery is unavailable.  A guessed
/// black background makes every hard-coded light foreground unreadable in a
/// light terminal, while `Reset` preserves the terminal's own defaults.
pub fn background() -> Color {
    (*BACKGROUND.get_or_init(discover_background)).unwrap_or(Color::Reset)
}

/// A subdued foreground with the best contrast available for terminal metadata
/// and borders.  Without a known background, leave the color unset so the
/// terminal can supply its own theme-aware default.
pub fn secondary_text() -> Color {
    let Some(background) = discovered_background() else {
        return Color::Reset;
    };
    let gray = Color::Gray;
    let dark_gray = Color::DarkGray;
    if contrast_ratio(gray, background) >= contrast_ratio(dark_gray, background) {
        gray
    } else {
        dark_gray
    }
}

/// Return black or white, whichever has the stronger WCAG contrast against
/// `background`.
pub fn contrast_foreground(background: Color) -> Color {
    let Some(background_luminance) = color_rgb(background).map(relative_luminance) else {
        return Color::Reset;
    };
    let black_contrast = contrast_ratio_from_luminance(0.0, background_luminance);
    let white_contrast = contrast_ratio_from_luminance(1.0, background_luminance);
    if black_contrast >= white_contrast {
        Color::Rgb(0, 0, 0)
    } else {
        Color::Rgb(255, 255, 255)
    }
}

/// Preserve a dynamic identity color when it is readable, otherwise fall back
/// to the strongest terminal-aware foreground.  Unknown backgrounds preserve
/// the caller's color because no safe contrast decision can be made.
pub fn readable_foreground(foreground: Color) -> Color {
    readable_foreground_against(foreground, discovered_background())
}

fn readable_foreground_against(foreground: Color, background: Option<Color>) -> Color {
    let Some(background) = background else {
        return foreground;
    };
    let Some(background_rgb) = color_rgb(background) else {
        return foreground;
    };
    let Some(foreground_rgb) = color_rgb(foreground) else {
        return if foreground == Color::Reset {
            contrast_foreground(background)
        } else {
            foreground
        };
    };
    if contrast_ratio_from_luminance(
        relative_luminance(foreground_rgb),
        relative_luminance(background_rgb),
    ) >= 4.5 {
        foreground
    } else {
        contrast_foreground(background)
    }
}

/// Apply a theme-aware selection pair. Spans with their own backgrounds are
/// badges or embedded content and retain their explicit colors.
pub fn text_selection_style(style: Style) -> Style {
    text_selection_style_against(style, discovered_background())
}

fn text_selection_style_against(style: Style, background: Option<Color>) -> Style {
    let Some(background) = background else {
        return style.add_modifier(Modifier::REVERSED);
    };
    if style.bg.is_some_and(|background| background != Color::Reset) {
        return style;
    }
    let selection = if relative_luminance(color_rgb(background).unwrap_or((0, 0, 0))) > 0.5 {
        Color::Rgb(50, 50, 50)
    } else {
        Color::Rgb(220, 220, 220)
    };
    style
        .fg(contrast_foreground(selection))
        .bg(selection)
}

fn discovered_background() -> Option<Color> {
    *BACKGROUND.get_or_init(discover_background)
}

fn discover_background() -> Option<Color> {
    let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let term = std::env::var("TERM").unwrap_or_default();
    if !is_ghostty(&program, &term) {
        return None;
    }
    for exe in ["ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty"] {
        if let Some(config) = resolved_config(exe) {
            if let Some(background) = parse_background(&config) {
                return Some(background);
            }
        }
    }
    None
}

fn is_ghostty(program: &str, term: &str) -> bool {
    program.eq_ignore_ascii_case("ghostty") || term.eq_ignore_ascii_case("xterm-ghostty")
}

fn parse_background(config: &str) -> Option<Color> {
    config.lines().filter_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "background" { return None; }
        let hex = value.trim().trim_matches('"').trim_start_matches('#');
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
        let value = u32::from_str_radix(hex, 16).ok()?;
        Some(Color::Rgb((value >> 16) as u8, (value >> 8) as u8, value as u8))
    }).last()
}

fn color_rgb(color: Color) -> Option<(u8, u8, u8)> {
    Some(match color {
        Color::Reset => return None,
        Color::Black => (0, 0, 0),
        Color::Red => (205, 0, 0),
        Color::Green => (0, 205, 0),
        Color::Yellow => (205, 205, 0),
        Color::Blue => (0, 0, 238),
        Color::Magenta => (205, 0, 205),
        Color::Cyan => (0, 191, 255),
        Color::Gray => (192, 192, 192),
        Color::DarkGray => (105, 105, 105),
        Color::LightRed => (255, 99, 71),
        Color::LightGreen => (50, 205, 50),
        Color::LightYellow => (255, 255, 0),
        Color::LightBlue => (30, 144, 255),
        Color::LightMagenta => (238, 130, 238),
        Color::LightCyan => (127, 255, 212),
        Color::White => (255, 255, 255),
        Color::Rgb(r, g, b) => (r, g, b),
        Color::Indexed(index) => indexed_rgb(index),
    })
}

fn indexed_rgb(index: u8) -> (u8, u8, u8) {
    const ANSI: [(u8, u8, u8); 16] = [
        (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
        (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
        (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
        (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
    ];
    match index {
        0..=15 => ANSI[index as usize],
        16..=231 => {
            let n = index - 16;
            let channel = |value: u8| if value == 0 { 0 } else { 55 + value * 40 };
            (channel(n / 36), channel((n / 6) % 6), channel(n % 6))
        }
        232..=255 => {
            let gray = 8 + (index - 232) * 10;
            (gray, gray, gray)
        }
    }
}

fn relative_luminance((r, g, b): (u8, u8, u8)) -> f64 {
    fn linear(channel: u8) -> f64 {
        let channel = f64::from(channel) / 255.0;
        if channel <= 0.03928 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

fn contrast_ratio(first: Color, second: Color) -> f64 {
    match (color_rgb(first), color_rgb(second)) {
        (Some(first), Some(second)) => contrast_ratio_from_luminance(
            relative_luminance(first),
            relative_luminance(second),
        ),
        _ => 1.0,
    }
}

fn contrast_ratio_from_luminance(first: f64, second: f64) -> f64 {
    let (lighter, darker) = if first >= second { (first, second) } else { (second, first) };
    (lighter + 0.05) / (darker + 0.05)
}


fn resolved_config(exe: &str) -> Option<String> {
    let mut child = Command::new(exe).arg("+show-config")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let stdout = child.stdout.take()?;
    // Drain output while waiting so pipe capacity cannot stall Ghostty.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(1024 * 1024).read_to_end(&mut bytes);
        result.ok().and_then(|_| String::from_utf8(bytes).ok())
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let output = reader.join().ok().flatten();
    if success { output } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Style;

    #[test]
    fn resolved_background_ignores_related_settings_and_accepts_hex_forms() {
        assert_eq!(parse_background("background-opacity = 0.9\nbackground = #101112\nforeground = #ffffff"),
            Some(Color::Rgb(16, 17, 18)));
        assert_eq!(parse_background("background = \"abcdef\""), Some(Color::Rgb(171, 205, 239)));
        assert_eq!(parse_background("background = 000001\nbackground = 123456"), Some(Color::Rgb(18, 52, 86)));
        for config in ["", "# background = ff0000", "background = nope", "background = 123"] {
            assert_eq!(parse_background(config), None);
        }
    }

    #[test]
    fn only_ghostty_uses_config_lookup() {
        assert!(is_ghostty("Ghostty", "xterm-256color"));
        assert!(is_ghostty("", "xterm-ghostty"));
        assert!(!is_ghostty("kitty", "xterm-kitty"));
        assert!(!is_ghostty("WezTerm", "xterm-256color"));
    }
    #[test]
    fn unknown_terminal_theme_inherits_defaults() {
        assert_eq!(body_text(), Color::Reset);
        if discovered_background().is_none() {
            assert_eq!(background(), Color::Reset);
            assert_eq!(secondary_text(), Color::Reset);
        }
    }

    #[test]
    fn contrast_foreground_uses_wcag_luminance() {
        assert_eq!(contrast_foreground(Color::Rgb(0, 0, 0)), Color::Rgb(255, 255, 255));
        assert_eq!(contrast_foreground(Color::Rgb(255, 255, 255)), Color::Rgb(0, 0, 0));
        assert_eq!(contrast_foreground(Color::Rgb(255, 0, 0)), Color::Rgb(0, 0, 0));
        assert_eq!(contrast_foreground(Color::Reset), Color::Reset);
    }

    #[test]
    fn readable_foreground_preserves_or_replaces_colors_by_contrast() {
        let white = Some(Color::Rgb(255, 255, 255));
        assert_eq!(
            readable_foreground_against(Color::Rgb(255, 0, 0), white),
            Color::Rgb(0, 0, 0),
        );
        assert_eq!(
            readable_foreground_against(Color::Rgb(0, 0, 255), white),
            Color::Rgb(0, 0, 255),
        );
        assert_eq!(
            readable_foreground_against(Color::Reset, white),
            Color::Rgb(0, 0, 0),
        );
        assert_eq!(
            readable_foreground_against(Color::Rgb(1, 2, 3), None),
            Color::Rgb(1, 2, 3),
        );
    }

    #[test]
    fn selections_remain_visible_for_known_and_unknown_backgrounds() {
        let original = Style::default().fg(Color::Rgb(1, 2, 3));
        let unknown = text_selection_style_against(original, None);
        assert!(unknown.add_modifier.contains(Modifier::REVERSED));

        let light = text_selection_style_against(original, Some(Color::Rgb(255, 255, 255)));
        assert_eq!(light.bg, Some(Color::Rgb(50, 50, 50)));
        assert_eq!(light.fg, Some(Color::Rgb(255, 255, 255)));

        let dark = text_selection_style_against(original, Some(Color::Rgb(0, 0, 0)));
        assert_eq!(dark.bg, Some(Color::Rgb(220, 220, 220)));
        assert_eq!(dark.fg, Some(Color::Rgb(0, 0, 0)));

        let badge = Style::default().fg(Color::Black).bg(Color::Yellow);
        assert_eq!(
            text_selection_style_against(badge, Some(Color::Rgb(255, 255, 255))),
            badge,
        );
    }
}

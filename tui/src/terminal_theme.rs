//! Resolve Ghostty's configured background once, including theme/config-file settings.
use ratatui::style::Color;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const BLACK: Color = Color::Rgb(0, 0, 0);

pub fn background() -> Color {
    static BACKGROUND: OnceLock<Color> = OnceLock::new();
    *BACKGROUND.get_or_init(|| {
        let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
        let term = std::env::var("TERM").unwrap_or_default();
        if !is_ghostty(&program, &term) { return BLACK; }
        for exe in ["ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty"] {
            if let Some(config) = resolved_config(exe) {
                return parse_background(&config).unwrap_or(BLACK);
            }
        }
        BLACK
    })
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
    #[test]
    fn resolved_background_ignores_related_settings_and_accepts_hex_forms() {
        assert_eq!(parse_background("background-opacity = 0.9\nbackground = #101112\nforeground = #ffffff"),
            Some(Color::Rgb(16, 17, 18)));
        assert_eq!(parse_background("background = \"abcdef\""), Some(Color::Rgb(171, 205, 239)));
        assert_eq!(parse_background("background = 000001\nbackground = 123456"), Some(Color::Rgb(18, 52, 86)));
        for config in ["", "# background = ff0000", "background = nope", "background = 123"] {
            assert_eq!(parse_background(config).unwrap_or(BLACK), BLACK);
        }
    }
    #[test]
    fn only_ghostty_uses_config_lookup() {
        assert!(is_ghostty("Ghostty", "xterm-256color"));
        assert!(is_ghostty("", "xterm-ghostty"));
        assert!(!is_ghostty("kitty", "xterm-kitty"));
        assert!(!is_ghostty("WezTerm", "xterm-256color"));
    }
}

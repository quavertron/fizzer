use ratatui::layout::Rect;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub image_id: u32,
    pub area: Rect,
    pub svg: String,
}
static FRAME: OnceLock<Mutex<Vec<Placement>>> = OnceLock::new();
fn frame() -> &'static Mutex<Vec<Placement>> {
    FRAME.get_or_init(|| Mutex::new(Vec::new()))
}
pub fn begin_frame() {
    frame().lock().unwrap().clear();
}
pub fn place(value: Placement) {
    frame().lock().unwrap().push(value);
}
fn placements() -> Vec<Placement> {
    frame().lock().unwrap().clone()
}

pub fn is_kitty_terminal() -> bool {
    if std::env::var_os("KITTY_WINDOW_ID").is_some() {
        return true;
    }
    let identity = format!(
        "{} {}",
        std::env::var("TERM").unwrap_or_default(),
        std::env::var("TERM_PROGRAM").unwrap_or_default()
    )
    .to_ascii_lowercase();
    ["kitty", "ghostty", "wezterm"]
        .iter()
        .any(|name| identity.contains(name))
}

pub fn image_id(message_id: &str, index: usize, svg: &str) -> u32 {
    let mut hash = Sha256::new();
    hash.update(message_id.as_bytes());
    hash.update(index.to_le_bytes());
    hash.update(svg.as_bytes());
    let digest = hash.finalize();
    u32::from_le_bytes(digest[..4].try_into().unwrap()).max(1)
}

#[derive(Default)]
pub struct Display {
    shown: HashMap<u32, Rect>,
    enabled: bool,
}
impl Display {
    pub fn new() -> Self {
        Self {
            shown: HashMap::new(),
            enabled: is_kitty_terminal(),
        }
    }
    pub fn sync(&mut self, out: &mut impl Write) -> io::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let current = placements();
        let ids: HashSet<u32> = current.iter().map(|item| item.image_id).collect();
        for id in self
            .shown
            .keys()
            .copied()
            .filter(|id| !ids.contains(id))
            .collect::<Vec<_>>()
        {
            delete(out, id)?;
            self.shown.remove(&id);
        }
        for item in current {
            if self.shown.get(&item.image_id) == Some(&item.area) {
                continue;
            }
            if self.shown.contains_key(&item.image_id) {
                delete(out, item.image_id)?;
            }
            transmit(out, &item)?;
            self.shown.insert(item.image_id, item.area);
        }
        out.flush()
    }
    pub fn clear(&mut self, out: &mut impl Write) -> io::Result<()> {
        for id in self.shown.keys().copied().collect::<Vec<_>>() {
            delete(out, id)?;
        }
        self.shown.clear();
        out.flush()
    }
}
fn delete(out: &mut impl Write, id: u32) -> io::Result<()> {
    write!(out, "\x1b_Ga=d,d=I,i={id},q=2\x1b\\")
}
fn transmit(out: &mut impl Write, item: &Placement) -> io::Result<()> {
    let encoded = encode(item)?;
    write!(out, "\x1b7\x1b[{};{}H", item.area.y + 1, item.area.x + 1)?;
    out.write_all(&encoded)?;
    out.write_all(b"\x1b8")
}

// The native helper owns the SVG protocol. Rust only places its output in the TUI.
fn encode(item: &Placement) -> io::Result<Vec<u8>> {
    let binary = std::env::var_os("FIZZER_PURRVECT_BIN")
        .map(PathBuf::from)
        .or_else(|| {
            [
                std::env::current_exe()
                    .ok()
                    .map(|p| p.with_file_name("purrvect")),
                Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.native-tools/purrvect")),
                Some(PathBuf::from("/usr/local/libexec/fizzer/purrvect")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("purrvect"));
    let mut child = Command::new(binary)
        .args([
            "encode",
            "--width",
            &item.area.width.to_string(),
            "--height",
            &item.area.height.to_string(),
            "--id",
            &item.image_id.to_string(),
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let written = child.stdin.take().unwrap().write_all(item.svg.as_bytes());
    let result = child.wait_with_output()?;
    if !result.status.success() {
        return Err(io::Error::other(format!(
            "purrvect: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        )));
    }
    written?;
    Ok(result.stdout)
}

pub enum InlinePart<'a> {
    Text(&'a str),
    Svg(&'a str),
}
pub fn split_inline_svgs(input: &str) -> Vec<InlinePart<'_>> {
    let mut parts = Vec::new();
    let lower = input.to_ascii_lowercase();
    let (mut cursor, mut text_start) = (0, 0);
    while let Some(offset) = input[cursor..].find(['`', '<']) {
        let start = cursor + offset;
        let found = if input.as_bytes()[start] == b'`' {
            let count = input.as_bytes()[start..]
                .iter()
                .take_while(|&&b| b == b'`')
                .count();
            let after = start + count;
            let delimiter = &input[start..after];
            let Some(close_offset) = input[after..].find(delimiter) else {
                break;
            };
            let close = after + close_offset;
            cursor = close + count;
            // Inline code and non-SVG fences are examples, not images.
            let body = input[after..close].find('\n').map(|n| after + n + 1);
            match body {
                Some(body)
                    if count >= 3 && input[after..body].trim().eq_ignore_ascii_case("svg") =>
                {
                    Some((start, cursor, body, close))
                }
                _ => None,
            }
        } else {
            cursor = start + 1;
            let boundary = lower
                .as_bytes()
                .get(start + 4)
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>');
            if lower[start..].starts_with("<svg") && boundary {
                lower[start..]
                    .find("</svg>")
                    .map(|end| (start, start + end + 6, start, start + end + 6))
            } else {
                None
            }
        };
        if let Some((start, end, body, close)) = found {
            if start > text_start {
                parts.push(InlinePart::Text(&input[text_start..start]));
            }
            parts.push(InlinePart::Svg(&input[body..close]));
            cursor = end;
            text_start = end;
        }
    }
    if text_start < input.len() {
        parts.push(InlinePart::Text(&input[text_start..]));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoted_svg_examples_stay_text() {
        for body in [
            "Done. Any message containing raw `<svg>...</svg>` now renders inline.",
            "Use ``<svg><rect/></svg>`` here.",
            "```html\n<svg><rect/></svg>\n```",
            "An unfinished `<svg><rect/></svg>",
            "<svg-not-a-document></svg>",
        ] {
            assert!(
                matches!(split_inline_svgs(body).as_slice(), [InlinePart::Text(text)] if *text == body)
            );
        }
    }
    #[test]
    fn quoted_example_does_not_hide_a_later_real_svg() {
        let body = "Example `<svg>...</svg>`, then <svg><circle/></svg> end";
        assert!(matches!(
            split_inline_svgs(body).as_slice(),
            [
                InlinePart::Text("Example `<svg>...</svg>`, then "),
                InlinePart::Svg("<svg><circle/></svg>"),
                InlinePart::Text(" end")
            ]
        ));
    }
    #[test]
    #[ignore = "requires npm run build:agent-tools"]
    fn native_encoder_preserves_chunked_svg_and_placement() {
        use base64::Engine;
        let svg = format!("<svg><!--{}--></svg>", "x".repeat(9000));
        let item = Placement {
            image_id: 123,
            area: Rect::new(4, 5, 20, 8),
            svg: svg.clone(),
        };
        let mut output = Vec::new();
        transmit(&mut output, &item).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.starts_with("\x1b7\x1b[6;5H\x1b_Ga=T,f=1001,t=d,c=20,r=8,i=123,q=2,m=1;"));
        assert!(text.ends_with("\r\x1b8"));
        let mut decoded = Vec::new();
        for chunk in text.split("\x1b_G").skip(1) {
            let (_, payload) = chunk.split_once(';').unwrap();
            let (payload, _) = payload.split_once("\x1b\\").unwrap();
            decoded.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .unwrap(),
            );
        }
        assert_eq!(decoded, svg.as_bytes());
    }
    #[test]
    fn extracts_raw_and_fenced_svg_in_order() {
        let body = "before <svg><circle/></svg> between\n```svg\n<svg><rect/></svg>\n``` after";
        let svg: Vec<_> = split_inline_svgs(body)
            .into_iter()
            .filter_map(|part| match part {
                InlinePart::Svg(value) => Some(value),
                InlinePart::Text(_) => None,
            })
            .collect();
        assert_eq!(svg, ["<svg><circle/></svg>", "<svg><rect/></svg>\n"]);
    }
}

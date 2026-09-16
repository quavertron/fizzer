use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use ratatui::layout::Rect;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
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
    uploaded: HashSet<u32>,
    enabled: bool,
}
impl Display {
    pub fn new() -> Self {
        Self {
            shown: HashMap::new(),
            uploaded: HashSet::new(),
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
            delete_placement(out, id)?;
            self.shown.remove(&id);
        }

        if self.uploaded.len() > 64 {
            let evictable: Vec<u32> = self
                .uploaded
                .iter()
                .copied()
                .filter(|id| !self.shown.contains_key(id))
                .take(self.uploaded.len() - 64)
                .collect();
            for id in evictable {
                delete(out, id)?;
                self.uploaded.remove(&id);
            }
        }

        for item in current {
            if item.area.width == 0 || item.area.height == 0 {
                continue;
            }
            if self.shown.get(&item.image_id) == Some(&item.area) {
                continue;
            }
            if self.uploaded.contains(&item.image_id) {
                if self.shown.contains_key(&item.image_id) {
                    delete_placement(out, item.image_id)?;
                }
                place_existing(out, &item)?;
            } else {
                if self.shown.contains_key(&item.image_id) {
                    delete(out, item.image_id)?;
                }
                transmit(out, &item)?;
                self.uploaded.insert(item.image_id);
            }
            self.shown.insert(item.image_id, item.area);
        }
        out.flush()
    }
    pub fn clear(&mut self, out: &mut impl Write) -> io::Result<()> {
        for id in self.uploaded.drain() {
            delete(out, id)?;
        }
        self.shown.clear();
        out.flush()
    }
}
fn delete(out: &mut impl Write, id: u32) -> io::Result<()> {
    write!(out, "\x1b_Ga=d,d=I,i={id},q=2\x1b\\")
}
fn delete_placement(out: &mut impl Write, id: u32) -> io::Result<()> {
    write!(out, "\x1b_Ga=d,d=i,i={id},q=2\x1b\\")
}
fn place_existing(out: &mut impl Write, item: &Placement) -> io::Result<()> {
    write!(
        out,
        "\x1b7\x1b[{};{}H\x1b_Ga=p,i={},c={},r={},q=2\x1b\\\x1b8",
        item.area.y + 1,
        item.area.x + 1,
        item.image_id,
        item.area.width,
        item.area.height,
    )
}
fn transmit(out: &mut impl Write, item: &Placement) -> io::Result<()> {
    let encoded = encode(item)?;
    write!(out, "\x1b7\x1b[{};{}H", item.area.y + 1, item.area.x + 1)?;
    out.write_all(&encoded)?;
    out.write_all(b"\x1b8")
}

fn encode(item: &Placement) -> io::Result<Vec<u8>> {
    if let Some(binary) = std::env::var_os("FIZZER_PURRVECT_BIN") {
        return encode_external(PathBuf::from(binary), item);
    }
    encode_native(item)
}

fn encode_native(item: &Placement) -> io::Result<Vec<u8>> {
    let bytes = item.svg.as_bytes();
    if bytes.is_empty() {
        return Err(io::Error::other("purrvect: SVG must be 1 byte to 4 MiB"));
    }
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    if bytes.len() > MAX_BYTES {
        return Err(io::Error::other("purrvect: SVG must be 1 byte to 4 MiB"));
    }

    let mut output = Vec::new();
    let chunk_size = 3072;
    let mut offset = 0;
    while offset < bytes.len() {
        let n = std::cmp::min(chunk_size, bytes.len() - offset);
        let slice = &bytes[offset..offset + n];
        let more = if offset + n < bytes.len() { 1 } else { 0 };
        if offset == 0 {
            let header = format!(
                "\x1b_Ga=T,f=1001,t=d,c={},r={},i={},q=2,m={};",
                item.area.width, item.area.height, item.image_id, more
            );
            output.extend_from_slice(header.as_bytes());
        } else {
            let header = format!("\x1b_Gm={};", more);
            output.extend_from_slice(header.as_bytes());
        }
        let encoded_chunk = BASE64_STANDARD.encode(slice);
        output.extend_from_slice(encoded_chunk.as_bytes());
        output.extend_from_slice(b"\x1b\\");
        offset += n;
    }
    output.push(b'\r');
    Ok(output)
}

fn encode_external(binary: PathBuf, item: &Placement) -> io::Result<Vec<u8>> {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InlinePart<'a> {
    Text(&'a str),
    Svg {
        svg: Cow<'a, str>,
        width: Option<u16>,
        height: Option<u16>,
    },
}

fn parse_fence_dimensions(header: &str) -> Option<(&str, Option<u16>, Option<u16>)> {
    let mut parts = header.split_whitespace();
    let lang = parts.next()?;
    if !lang.eq_ignore_ascii_case("svg") && !lang.eq_ignore_ascii_case("mermaid") {
        return None;
    }
    let mut width = None;
    let mut height = None;
    let mut iter = parts.peekable();
    while let Some(tok) = iter.next() {
        let lower = tok.to_ascii_lowercase();
        if lower == "--height" || lower == "-h" || lower == "--rows" || lower == "-r" {
            if let Some(val) = iter.next() {
                if let Ok(h) = val.parse::<u16>() {
                    height = Some(h.clamp(1, 100));
                }
            }
        } else if lower == "--width" || lower == "-w" || lower == "--cols" || lower == "-c" {
            if let Some(val) = iter.next() {
                if let Ok(w) = val.parse::<u16>() {
                    width = Some(w.clamp(1, 4096));
                }
            }
        } else if let Some(val) = lower
            .strip_prefix("height=")
            .or_else(|| lower.strip_prefix("rows="))
            .or_else(|| lower.strip_prefix("h="))
            .or_else(|| lower.strip_prefix("--height="))
            .or_else(|| lower.strip_prefix("--rows="))
        {
            if let Ok(h) = val.parse::<u16>() {
                height = Some(h.clamp(1, 100));
            }
        } else if let Some(val) = lower
            .strip_prefix("width=")
            .or_else(|| lower.strip_prefix("cols="))
            .or_else(|| lower.strip_prefix("w="))
            .or_else(|| lower.strip_prefix("--width="))
            .or_else(|| lower.strip_prefix("--cols="))
        {
            if let Ok(w) = val.parse::<u16>() {
                width = Some(w.clamp(1, 4096));
            }
        } else if let Ok(n) = tok.parse::<u16>() {
            height = Some(n.clamp(1, 100));
        }
    }
    Some((lang, width, height))
}

fn render_mermaid(source: &str) -> Option<String> {
    let site_config = merman::MermaidConfig::from_value(serde_json::json!({
        "theme": "dark",
        "themeVariables": {
            "darkMode": true,
            "background": "transparent",
            "mainBkg": "#21262d",
            "nodeBorder": "#58a6ff",
            "lineColor": "#8b949e",
            "textColor": "#f0f6fc",
            "primaryTextColor": "#f0f6fc",
            "primaryColor": "#21262d",
            "primaryBorderColor": "#58a6ff",
            "edgeLabelBackground": "#161b22"
        }
    }));
    let mut svg = merman::render::HeadlessRenderer::new()
        .with_diagram_id("fizzer-mermaid")
        .with_site_config(site_config)
        .render_svg_resvg_safe_sync(source)
        .ok()
        .flatten()?;

    let thorvg_style = "<style>.label-container { fill: #21262d; stroke: #58a6ff; stroke-width: 1.5px; }rect.label-container { fill: #21262d; stroke: #58a6ff; stroke-width: 1.5px; }polygon.label-container { fill: #21262d; stroke: #58a6ff; stroke-width: 1.5px; }.merman-foreignobject-fallback-text { fill: #f0f6fc; font-family: Arial, sans-serif; }.flowchart-link { stroke: #8b949e; stroke-width: 1.5px; fill: none; }.arrowMarkerPath { fill: #8b949e; stroke: #8b949e; }.marker { fill: #8b949e; stroke: #8b949e; }</style>";

    if let Some(idx) = svg.find('>') {
        svg.insert_str(idx + 1, thorvg_style);
    }
    let svg = svg.replace("fill=\"#333\"", "fill=\"#f0f6fc\"");
    let svg = svg.replace("background-color:white", "background-color:transparent");
    Some(svg)
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
            let body = input[after..close].find('\n').map(|n| after + n + 1);
            match body {
                Some(body) if count >= 3 => {
                    let header = input[after..body].trim();
                    if let Some((lang, width, height)) = parse_fence_dimensions(header) {
                        if lang.eq_ignore_ascii_case("svg") {
                            Some((
                                start,
                                cursor,
                                InlinePart::Svg {
                                    svg: Cow::Borrowed(&input[body..close]),
                                    width,
                                    height,
                                },
                            ))
                        } else if lang.eq_ignore_ascii_case("mermaid") {
                            render_mermaid(&input[body..close]).map(|svg| {
                                (
                                    start,
                                    cursor,
                                    InlinePart::Svg {
                                        svg: Cow::Owned(svg),
                                        width,
                                        height,
                                    },
                                )
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    }
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
                lower[start..].find("</svg>").map(|end| {
                    let end = start + end + 6;
                    (
                        start,
                        end,
                        InlinePart::Svg {
                            svg: Cow::Borrowed(&input[start..end]),
                            width: None,
                            height: None,
                        },
                    )
                })
            } else {
                None
            }
        };
        if let Some((start, end, part)) = found {
            if start > text_start {
                parts.push(InlinePart::Text(&input[text_start..start]));
            }
            parts.push(part);
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
                InlinePart::Svg(svg),
                InlinePart::Text(" end")
            ] if svg == "<svg><circle/></svg>"
        ));
    }
    #[test]
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

    #[test]
    fn renders_mermaid_dark_mode_flowchart() {
        let body = "```mermaid\nflowchart LR\n    A[Start] --> B(Process)\n    B --> C{Decision}\n    C -- Yes --> D[Done]\n    C -- No --> B\n```";
        let parts = split_inline_svgs(body);
        let svgs: Vec<_> = parts
            .into_iter()
            .filter_map(|p| match p {
                InlinePart::Svg(s) => Some(s),
                InlinePart::Text(_) => None,
            })
            .collect();
        assert_eq!(svgs.len(), 1);
        let svg = &svgs[0];
        assert!(svg.contains("Start"));
        assert!(svg.contains("Process"));
        assert!(svg.contains("Decision"));
        assert!(svg.contains("Done"));
        assert!(svg.contains(".label-container"));
        assert!(svg.contains("#21262d"));
    }

    #[test]
    fn renders_mermaid_fences_as_svg() {
        let body = "before\n```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```\nafter";
        let parts = split_inline_svgs(body);
        assert!(matches!(
            parts.as_slice(),
            [InlinePart::Text("before\n"), InlinePart::Svg(svg), InlinePart::Text("\nafter")]
                if svg.starts_with("<svg") && svg.contains("Start") && svg.contains("Done")
        ));
    }

    #[test]
    fn invalid_mermaid_fences_stay_text() {
        let body = "```mermaid\nthis is not a diagram\n```";
        assert!(matches!(
            split_inline_svgs(body).as_slice(),
            [InlinePart::Text(text)] if *text == body
        ));
    }

    #[test]
    fn display_sync_uses_placement_on_scroll_without_retransmitting() {
        let mut display = Display {
            shown: HashMap::new(),
            uploaded: HashSet::new(),
            enabled: true,
        };
        let item1 = Placement {
            image_id: 42,
            area: Rect::new(5, 10, 30, 10),
            svg: "<svg><rect/></svg>".to_string(),
        };

        // 1. First sync: initial placement and transmit
        begin_frame();
        place(item1.clone());
        let mut out1 = Vec::new();
        display.sync(&mut out1).unwrap();
        let text1 = String::from_utf8(out1).unwrap();
        assert!(text1.contains("\x1b_Ga=T,f=1001,t=d,c=30,r=10,i=42,q=2,m=0;"));
        assert!(display.uploaded.contains(&42));
        assert_eq!(display.shown.get(&42), Some(&item1.area));

        // 2. Idle sync: no movement, no output
        let mut out_idle = Vec::new();
        display.sync(&mut out_idle).unwrap();
        assert!(out_idle.is_empty());

        // 3. Scroll sync: y changed from 10 to 9
        begin_frame();
        let item2 = Placement {
            image_id: 42,
            area: Rect::new(5, 9, 30, 10),
            svg: "<svg><rect/></svg>".to_string(),
        };
        place(item2.clone());
        let mut out2 = Vec::new();
        display.sync(&mut out2).unwrap();
        let text2 = String::from_utf8(out2).unwrap();
        assert!(text2.contains("\x1b_Ga=d,d=i,i=42,q=2\x1b\\"));
        assert!(text2.contains("\x1b7\x1b[10;6H\x1b_Ga=p,i=42,c=30,r=10,q=2\x1b\\\x1b8"));
        assert!(!text2.contains("a=T"));
        assert!(display.uploaded.contains(&42));

        // 4. Scrolled off screen: delete placement only
        begin_frame();
        let mut out3 = Vec::new();
        display.sync(&mut out3).unwrap();
        let text3 = String::from_utf8(out3).unwrap();
        assert_eq!(text3, "\x1b_Ga=d,d=i,i=42,q=2\x1b\\");
        assert!(display.uploaded.contains(&42));
        assert!(!display.shown.contains_key(&42));

        // 5. Scrolled back on screen: re-place with a=p without retransmitting a=T
        begin_frame();
        let item3 = Placement {
            image_id: 42,
            area: Rect::new(5, 12, 30, 10),
            svg: "<svg><rect/></svg>".to_string(),
        };
        place(item3);
        let mut out4 = Vec::new();
        display.sync(&mut out4).unwrap();
        let text4 = String::from_utf8(out4).unwrap();
        assert!(text4.contains("\x1b_Ga=p,i=42,c=30,r=10,q=2\x1b\\"));
        assert!(!text4.contains("a=T"));

        // 6. Clear display on exit: purges uploaded image with d=I
        let mut out5 = Vec::new();
        display.clear(&mut out5).unwrap();
        let text5 = String::from_utf8(out5).unwrap();
        assert_eq!(text5, "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
        assert!(display.uploaded.is_empty());
        assert!(display.shown.is_empty());
    }
}

//! A single persistent awatch process, displayed inside ordinary Fizzer windows.
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind, MouseButton};
use portable_pty::{CommandBuilder, MasterPty, Child, PtySize};
use ratatui::{Frame, layout::Rect, style::{Color, Modifier, Style}, widgets::{Block, Borders, Paragraph}};

#[derive(Default)]
pub struct Awatch {
    session: Option<Session>,
    attempted: bool,
    error: String,
    term_prefix: bool,
    character_mode: bool,
    bounds: Option<Rect>,
}
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    screen: Arc<Mutex<vt100::Parser>>,
    size: (u16, u16),
}

fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("FIZZER_AWATCH_BIN") { return path.into(); }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("awatch");
        if sibling.is_file() { return sibling; }
    }
    source_binary(std::path::Path::new(env!("CARGO_MANIFEST_DIR")))
        .or_else(|| { let path = PathBuf::from("/usr/local/libexec/fizzer/awatch"); path.is_file().then_some(path) })
        .unwrap_or_else(|| "awatch".into())
}

fn source_binary(manifest: &std::path::Path) -> Option<PathBuf> {
    let path = manifest.join("../.native-tools/awatch");
    path.is_file().then_some(path)
}

impl Awatch {
    pub fn set_bounds(&mut self, bounds: Rect) { self.bounds = Some(bounds); }

    pub fn content_area(&self, area: Rect) -> Rect {
        self.panel_block(area).inner(area)
    }

    fn panel_block(&self, area: Rect) -> Block<'static> {
        match self.bounds {
            Some(bounds) => panel_block().borders(crate::ui::buffer_borders(area, bounds)),
            None => panel_block(),
        }
    }
    pub fn enter_character_mode(&mut self) {
        self.term_prefix = false;
        self.character_mode = true;
    }

    pub fn prepare(&mut self, area: Rect) {
        let inner = self.content_area(area);
        let (cols, rows) = (inner.width, inner.height);
        if cols == 0 || rows == 0 { return; }
        if !self.attempted {
            self.attempted = true;
            match Session::start(binary(), cols, rows) {
                Ok(session) => self.session = Some(session),
                Err(error) => self.error = format!("Cannot start awatch: {error}\nRun npm run build:agent-tools or set FIZZER_AWATCH_BIN.\nEnter retries; C-x b switches buffers."),
            }
        }
        if let Some(session) = &mut self.session {
            match session.child.try_wait() {
                Ok(Some(status)) => {
                    self.error = format!("awatch exited ({status}). Another instance may already own /tmp/awatch.sock. Enter retries.");
                    // Preserve the last screen, including the child's diagnostic.
                }
                Ok(None) => {
                    if session.size != (cols, rows) {
                        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
                        let mut parser = session.screen.lock().unwrap();
                        if let Err(error) = session.master.resize(size) {
                            self.error = format!("Cannot resize awatch: {error}");
                        } else {
                            parser.screen_mut().set_size(rows, cols);
                            session.size = (cols, rows);
                        }
                    }
                }
                Err(error) => self.error = format!("Cannot check awatch: {error}"),
            }
        }
    }

    pub fn key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if self.term_prefix {
            self.term_prefix = false;
            if ctrl && matches!(key.code, KeyCode::Char('k' | 'K')) {
                self.character_mode = true;
                return;
            }
            // A non-C-k sequence keeps the prefix's C-c byte intact.
            self.send(&[3]);
        } else if !self.character_mode && ctrl && matches!(key.code, KeyCode::Char('c' | 'C')) {
            self.term_prefix = true;
            return;
        }
        if key.code == KeyCode::Enter && !self.error.is_empty() {
            self.session = None;
            self.attempted = false;
            self.error.clear();
            return;
        }
        self.send(&key_bytes(key));
    }
    fn send(&mut self, bytes: &[u8]) {
        if let Some(session) = &mut self.session {
            if let Err(error) = session.writer.write_all(bytes).and_then(|_| session.writer.flush()) {
                self.error = format!("Cannot send input to awatch: {error}. Enter retries.");
            }
        }
    }
    pub fn mouse(&mut self, mouse: MouseEvent, area: Rect) {
        if !area.contains((mouse.column, mouse.row).into()) { return; }
        let (button, end) = match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => (0, 'M'),
            MouseEventKind::Drag(MouseButton::Left) => (32, 'M'),
            MouseEventKind::Up(MouseButton::Left) => (0, 'm'),
            MouseEventKind::ScrollUp => (64, 'M'),
            MouseEventKind::ScrollDown => (65, 'M'),
            _ => return,
        };
        self.send(format!("\x1b[<{button};{};{}{end}", mouse.column - area.x + 1, mouse.row - area.y + 1).as_bytes());
    }
    pub fn render(&self, frame: &mut Frame, area: Rect, focused: bool) {
        let block = self.panel_block(area)
            .border_style(Style::default().fg(if focused { Color::Cyan } else { Color::DarkGray }));
        let inner = self.content_area(area);
        frame.render_widget(block, area);
        if let Some(session) = &self.session {
            let parser = session.screen.lock().unwrap();
            render_screen(frame, inner, parser.screen());
        }
        if !self.error.is_empty() {
            let message_area = if self.session.is_some() {
                Rect::new(inner.x, inner.bottom().saturating_sub(2).max(inner.y), inner.width, inner.height.min(2))
            } else { inner };
            frame.render_widget(Paragraph::new(self.error.as_str()).style(Style::default().fg(Color::Yellow)), message_area);
        }
    }
}
impl Session {
    fn start(path: PathBuf, cols: u16, rows: u16) -> Result<Self, String> {
        let pair = portable_pty::native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let screen = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, 0)));
        let output = Arc::clone(&screen);
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => output.lock().unwrap().process(&bytes[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        Ok(Self { master: pair.master, writer, child, screen, size: (cols, rows) })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        // Let awatch release its owned socket before falling back to termination.
        let _ = self.writer.write_all(b"q");
        let _ = self.writer.flush();
        for _ in 0..25 {
            if matches!(self.child.try_wait(), Ok(Some(_))) { return; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn panel_block() -> Block<'static> {
    Block::default().borders(Borders::ALL).title(" Awatch ")
}
#[cfg(test)]
fn content_area(area: Rect) -> Rect {
    panel_block().inner(area)
}
fn color(value: vt100::Color) -> Color {
    match value { vt100::Color::Default => Color::Reset, vt100::Color::Idx(n) => Color::Indexed(n), vt100::Color::Rgb(r,g,b) => Color::Rgb(r,g,b) }
}
fn render_screen(frame: &mut Frame, area: Rect, screen: &vt100::Screen) {
    for row in 0..area.height {
        for col in 0..area.width {
            let Some(cell) = screen.cell(row, col) else { continue; };
            if cell.is_wide_continuation() || (cell.is_wide() && col + 1 >= area.width) { continue; }
            let mut style = Style::default().fg(color(cell.fgcolor())).bg(color(cell.bgcolor()));
            for (enabled, flag) in [(cell.bold(), Modifier::BOLD), (cell.dim(), Modifier::DIM),
                (cell.italic(), Modifier::ITALIC), (cell.underline(), Modifier::UNDERLINED), (cell.inverse(), Modifier::REVERSED)] {
                if enabled { style = style.add_modifier(flag); }
            }
            frame.buffer_mut()[(area.x + col, area.y + row)]
                .set_symbol(if cell.has_contents() { cell.contents() } else { " " }).set_style(style);
        }
    }
}
fn key_bytes(key: KeyEvent) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    // Emacs scrolling within the monitor, alongside awatch's native controls.
    let code = match (ctrl, alt, key.code) {
        (true, _, KeyCode::Char('n')) => KeyCode::Down,
        (true, _, KeyCode::Char('p')) => KeyCode::Up,
        (true, _, KeyCode::Char('v')) => KeyCode::PageDown,
        (_, true, KeyCode::Char('v')) => KeyCode::PageUp,
        (_, true, KeyCode::Char('<')) => return b"g".to_vec(),
        (_, true, KeyCode::Char('>')) => return b"G".to_vec(),
        _ => key.code,
    };
    let mut bytes = match code {
        KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::SUPER) && c.eq_ignore_ascii_case(&'c') => vec![25],
        KeyCode::Char(c) if ctrl && c.is_ascii_alphabetic() => vec![c.to_ascii_lowercase() as u8 - b'a' + 1],
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter => vec![13], KeyCode::Esc => vec![27], KeyCode::Tab => vec![9], KeyCode::Backspace => vec![127],
        KeyCode::Up => b"\x1b[A".to_vec(), KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(), KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"g".to_vec(), KeyCode::End => b"G".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(), KeyCode::PageDown => b"\x1b[6~".to_vec(),
        _ => vec![],
    };
    if alt && matches!(code, KeyCode::Char(_)) { bytes.insert(0, 27); }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn child_terminal_size_matches_drawable_panel_after_resize() {
        let mut awatch = Awatch {
            session: Some(Session::start("/bin/sh".into(), 10, 4).unwrap()),
            attempted: true, error: String::new(), term_prefix: false, character_mode: false, bounds: None,
        };
        for area in [Rect::new(5, 3, 42, 10), Rect::new(5, 3, 73, 17)] {
            awatch.prepare(area);
            let inner = content_area(area);
            let session = awatch.session.as_mut().unwrap();
            let actual = session.master.get_size().unwrap();
            assert_eq!((actual.cols, actual.rows), (inner.width, inner.height));
            assert_eq!(session.screen.lock().unwrap().screen().size(), (inner.height, inner.width));
        }
        let session = awatch.session.as_mut().unwrap();
        session.writer.write_all(b"stty size; exit\n").unwrap();
        session.writer.flush().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let contents = session.screen.lock().unwrap().screen().contents();
            if contents.lines().any(|line| line.trim() == "15 71") { break; }
            assert!(std::time::Instant::now() < deadline, "child did not receive exact size: {contents}");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[test]
    fn final_available_column_is_rendered_without_touching_border() {
        let area = Rect::new(2, 1, 12, 5);
        let inner = content_area(area);
        assert_eq!(inner.width, 10);
        let mut parser = vt100::Parser::new(inner.height, inner.width, 0);
        parser.process(b"0123456789X");
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(20, 8)).unwrap();
        terminal.draw(|frame| {
            frame.render_widget(panel_block(), area);
            render_screen(frame, inner, parser.screen());
        }).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(inner.right()-1, inner.y)].symbol(), "9");
        assert_eq!(buffer[(inner.x, inner.y+1)].symbol(), "X");
        assert_eq!(buffer[(area.right()-1, inner.y)].symbol(), "│");
    }
    #[test]
    fn source_build_uses_only_the_fizzer_bundle() {
        let root = std::env::temp_dir().join(format!("fizzer-awatch-lookup-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let manifest = root.join("fizzer/tui");
        std::fs::create_dir_all(&manifest).unwrap();
        std::fs::create_dir_all(root.join("awatch")).unwrap();
        assert!(source_binary(&manifest).is_none());
        std::fs::write(root.join("awatch/awatch"), b"fixture").unwrap();
        assert!(source_binary(&manifest).is_none());
        let vendor = manifest.join("../.native-tools");
        std::fs::create_dir_all(&vendor).unwrap();
        std::fs::write(vendor.join("awatch"), b"fixture").unwrap();
        assert_eq!(source_binary(&manifest), Some(vendor.join("awatch")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn child_output_is_read_in_background_and_exits_cleanly() {
        let mut session = Session::start("/bin/sh".into(), 40, 8).unwrap();
        session.writer.write_all(b"printf 'awatch-pty-ok\\n'; exit\n").unwrap();
        session.writer.flush().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if session.child.try_wait().unwrap().is_some() { break; }
            assert!(std::time::Instant::now() < deadline, "child failed to exit");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        while !session.screen.lock().unwrap().screen().contents().contains("awatch-pty-ok") {
            assert!(std::time::Instant::now() < deadline, "PTY output was lost");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[test]
    fn emacs_scrolling_and_copy_translate_to_awatch_input() {
        assert_eq!(key_bytes(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL)), b"\x1b[B");
        assert_eq!(key_bytes(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::ALT)), b"\x1b[5~");
        assert_eq!(key_bytes(KeyEvent::new(KeyCode::Char('>'), KeyModifiers::ALT)), b"G");
        assert_eq!(key_bytes(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::SUPER)), [25]);
        assert_eq!(key_bytes(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL)), [15]);
    }
    #[test]
    fn terminal_output_stays_in_panel_and_preserves_color() {
        let mut parser = vt100::Parser::new(3, 12, 0);
        parser.process(b"\x1b[31mhello\x1b[0m\r\nworld");
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(20, 8)).unwrap();
        terminal.draw(|frame| render_screen(frame, Rect::new(3, 2, 12, 3), parser.screen())).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(3, 2)].symbol(), "h");
        assert_eq!(buffer[(3, 2)].fg, Color::Indexed(1));
        assert_eq!(buffer[(3, 3)].symbol(), "w");
        assert_eq!(buffer[(2, 2)].symbol(), " ");
    }
}

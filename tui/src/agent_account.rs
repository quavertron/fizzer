use std::{fs, path::PathBuf, process::Command, time::Duration};
use color_eyre::Result;
use crossterm::{event::{self, Event, KeyCode, KeyEventKind}, execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen}};
use ratatui::{backend::CrosstermBackend, layout::{Alignment, Rect},
    widgets::{Block, Borders, Clear, Paragraph, Wrap}, Terminal};

fn data_directory() -> Option<PathBuf> {
    std::env::var_os("CASCADE_DATA_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".fizzer")))
}

pub fn needs_setup(directory: &std::path::Path) -> bool {
    !directory.join("agent-writes-enabled").exists() && !directory.join("agent-writes-declined").exists()
}

fn alock_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("FIZZER_ALOCK_BIN") { candidates.push(PathBuf::from(path)); }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() { candidates.push(parent.join("alock")); }
    }
    candidates.push(PathBuf::from("/usr/local/libexec/fizzer/alock"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.native-tools/alock"));
    candidates.into_iter().find(|path| path.is_file())
}

/// Uses a real terminal for sudo, never a password field in the application.
pub fn offer_setup() -> Result<()> {
    if !cfg!(any(target_os = "macos", target_os = "linux")) { return Ok(()); }
    let Some(directory) = data_directory() else { return Ok(()); };
    if !needs_setup(&directory) { return Ok(()); }
    enable_raw_mode()?;
    let mut output = std::io::stdout();
    execute!(output, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(output))?;
    let choice = (|| -> Result<KeyCode> {
        loop {
            terminal.draw(|frame| {
                let size = frame.area();
                let width = size.width.min(76);
                let height = size.height.min(16);
                let area = Rect::new((size.width - width) / 2, (size.height - height) / 2, width, height);
                frame.render_widget(Clear, area);
                frame.render_widget(Paragraph::new(
                    "Coordinate agent file writes without agent hooks?\n\nOptional setup creates a separate fizzer account. All agents can propose existing-file edits across your computer through your human-owned alock bridge, without root privileges. Human editors keep write access; direct human edits can still race.\n\nEnter opens setup in this terminal. sudo asks for your password, then setup offers selected credential copying.\n\nEnter: Set up    Esc: Not now    n: Don't ask again")
                    .block(Block::default().title(" Agent write setup ").borders(Borders::ALL))
                    .alignment(Alignment::Left).wrap(Wrap { trim: true }), area);
            })?;
            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press && matches!(key.code, KeyCode::Enter | KeyCode::Esc | KeyCode::Char('n')) {
                        return Ok(key.code);
                    }
                }
            }
        }
    })();
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    match choice? {
        KeyCode::Char('n') => {
            fs::create_dir_all(&directory)?;
            fs::write(directory.join("agent-writes-declined"), "1\n")?;
        }
        KeyCode::Enter => {
            if let Some(binary) = alock_binary() {
                let temporary = std::env::temp_dir().join(format!("fizzer-account-{}-{}", std::process::id(),
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
                fs::create_dir(&temporary)?;
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))?;
                }
                let result = (|| -> Result<bool> {
                    fs::write(temporary.join("setup-fizzer-user.sh"), include_str!("../../scripts/setup-fizzer-user.sh"))?;
                    let installer = temporary.join("install-agent-writes.sh");
                    fs::write(&installer, include_str!("../../install-agent-writes.sh"))?;
                    Ok(Command::new("/bin/bash").arg(installer).arg(binary).status()?.success())
                })();
                let _ = fs::remove_dir_all(temporary);
                if !result? { eprintln!("Agent write setup did not finish. It will be offered again next launch."); }
            } else { eprintln!("Native alock is missing. Install an alock binary with bridge support or set FIZZER_ALOCK_BIN."); }
            eprintln!("Press Enter to continue to Fizzer.");
            let _ = std::io::stdin().read_line(&mut String::new());
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remembers_decline_and_completed_setup() {
        let directory = std::env::temp_dir().join(format!("fizzer-account-state-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        assert!(needs_setup(&directory));
        fs::write(directory.join("agent-writes-declined"), "1\n").unwrap();
        assert!(!needs_setup(&directory));
        fs::remove_file(directory.join("agent-writes-declined")).unwrap();
        fs::write(directory.join("agent-writes-enabled"), "1\n").unwrap();
        assert!(!needs_setup(&directory));
        fs::remove_dir_all(directory).unwrap();
    }
}

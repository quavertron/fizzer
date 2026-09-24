use std::{collections::HashMap, path::Path, process::Command};
use crate::storage_bin;

pub fn read(directory: &Path) -> HashMap<String, String> {
    let output = Command::new(storage_bin::binary())
        .arg("server-sessions").arg("read").arg(directory)
        .output().ok();
    output.and_then(|out| if out.status.success() { serde_json::from_slice(&out.stdout).ok() } else { None })
        .unwrap_or_default()
}

pub fn remember(directory: &Path, origin: &str, token: &str) -> Result<(), String> {
    let output = Command::new(storage_bin::binary())
        .arg("server-sessions").arg("remember").arg(directory).arg(origin).arg(token)
        .output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn concurrent_writers_preserve_each_other_and_legacy_sessions() {
        // Electron and the TUI both write through fizzer-storage.
        if !storage_bin::binary().is_file() {
            return;
        }
        let directory = std::env::temp_dir().join(format!("fizzer-session-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("server-sessions.json"), r#"{"local":"legacy"}"#).unwrap();
        let other = {
            let directory = directory.clone();
            std::thread::spawn(move || for i in 0..50 { remember(&directory, &format!("https://electron{i}.example"), "electron").unwrap(); })
        };
        for i in 0..50 { remember(&directory, &format!("https://tui{i}.example"), "tui").unwrap(); }
        other.join().unwrap();
        assert_eq!(read(&directory).len(), 101);
        remember(&directory, "local", "updated").unwrap();
        let sessions = read(&directory);
        assert_eq!(sessions.len(), 101);
        assert_eq!(sessions["local"], "updated");
        remember(&directory, "local", "second-update").unwrap();
        assert_eq!(read(&directory)["local"], "second-update");
        fs::remove_dir_all(directory).unwrap();
    }
}

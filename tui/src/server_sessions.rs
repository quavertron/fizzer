use std::{collections::HashMap, fs, path::Path};
use sha2::{Digest, Sha256};

// One atomic file per server: concurrent clients never rewrite other logins.
// The old shared file remains a read-only fallback for existing installations.
pub fn read(directory: &Path) -> HashMap<String, String> {
    let mut sessions: HashMap<String, String> = fs::read(directory.join("server-sessions.json"))
        .ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if let Ok(entries) = fs::read_dir(directory.join("server-sessions")) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Some(values) = fs::read(entry.path()).ok()
                .and_then(|bytes| serde_json::from_slice::<HashMap<String, String>>(&bytes).ok()) {
                sessions.extend(values);
            }
        }
    }
    sessions
}

pub fn remember(directory: &Path, origin: &str, token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let entries = directory.join("server-sessions");
    fs::create_dir_all(&entries).map_err(|e| e.to_string())?;
    let name = format!("{:x}", Sha256::digest(origin.as_bytes()));
    let destination = entries.join(format!("{name}.json"));
    let temporary = entries.join(format!("{name}.{}.{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    let result = (|| {
        let value = HashMap::from([(origin, token)]);
        file.write_all(&serde_json::to_vec(&value).unwrap())?;
        drop(file);
        fs::rename(&temporary, destination)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_and_tui_writers_preserve_each_other_and_legacy_sessions() {
        let directory = std::env::temp_dir().join(format!("fizzer-session-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("server-sessions.json"), r#"{"local":"legacy"}"#).unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../cascade-electron/server-sessions.cjs");
        let mut electron = std::process::Command::new("node").arg("-e")
            .arg("const {rememberSession}=require(process.argv[1]); for(let i=0;i<50;i++) rememberSession(process.argv[2], 'https://electron'+i+'.example', 'electron');")
            .arg(module).arg(&directory).spawn().unwrap();
        for i in 0..50 { remember(&directory, &format!("https://tui{i}.example"), "tui").unwrap(); }
        assert!(electron.wait().unwrap().success());
        assert_eq!(read(&directory).len(), 101);
        remember(&directory, "local", "updated").unwrap();
        let status = std::process::Command::new("node").arg("-e")
            .arg("const s=require(process.argv[1]).readSessions(process.argv[2]); require('node:assert/strict').equal(Object.keys(s).length,101); require('node:assert/strict').equal(s.local,'updated'); require(process.argv[1]).rememberSession(process.argv[2],'local','electron-update');")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../cascade-electron/server-sessions.cjs"))
            .arg(&directory).status().unwrap();
        assert!(status.success());
        assert_eq!(read(&directory)["local"], "electron-update");
        fs::remove_dir_all(directory).unwrap();
    }
}

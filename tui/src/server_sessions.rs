use std::{collections::HashMap, fs, path::Path, process::Command};
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

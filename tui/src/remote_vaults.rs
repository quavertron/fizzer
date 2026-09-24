use std::{path::Path, process::Command};
use crate::{RemoteVaultRecord, storage_bin};

pub fn read(directory: &Path) -> Vec<RemoteVaultRecord> {
    let output = Command::new(storage_bin::binary())
        .arg("remote-vaults").arg("read").arg(directory)
        .output().ok();
    output.and_then(|out| if out.status.success() { serde_json::from_slice(&out.stdout).ok() } else { None })
        .unwrap_or_default()
}

pub fn save(directory: &Path, record: RemoteVaultRecord) -> Result<(), String> {
    let input = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut child = Command::new(storage_bin::binary())
        .arg("remote-vaults").arg("save").arg(directory).arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&input).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
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
    fn concurrent_connection_updates_do_not_lose_other_vaults() {
        // Electron and the TUI both write through fizzer-storage.
        if !storage_bin::binary().is_file() {
            return;
        }
        let directory = std::env::temp_dir().join(format!("fizzer-vault-writers-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let record = |id: &str, origin: &str, token: &str| RemoteVaultRecord {
            id: id.into(), name: "Test vault".into(), origin: origin.into(), token: token.into(), role: None,
        };
        let legacy = serde_json::to_vec(&vec![record("legacy", "https://legacy.example", "original")]).unwrap();
        fs::write(directory.join("remote-vaults.json"), &legacy).unwrap();
        let other = {
            let directory = directory.clone();
            std::thread::spawn(move || for i in 0..50 {
                save(&directory, record("cloned", &format!("https://server{i}.example"), "electron")).unwrap();
            })
        };
        for i in 0..50 { save(&directory, record(&format!("tui-{i}"), "https://tui.example", "tui")).unwrap(); }
        other.join().unwrap();
        assert_eq!(read(&directory).len(), 101);
        save(&directory, record("cloned", "https://server0.example", "renewed-by-tui")).unwrap();
        let records = read(&directory);
        assert_eq!(records.len(), 101);
        assert_eq!(records.iter().find(|r| r.origin == "https://server0.example").unwrap().token, "renewed-by-tui");
        save(&directory, record("legacy", "https://legacy.example", "renewed-by-electron")).unwrap();
        assert_eq!(read(&directory).iter().find(|r| r.id == "legacy").unwrap().token, "renewed-by-electron");
        assert_eq!(fs::read(directory.join("remote-vaults.json")).unwrap(), legacy);
        assert_eq!(fs::read_dir(directory.join("remote-vaults")).unwrap().count(), 101);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(directory.join("remote-vaults")).unwrap().flatten() {
                assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        fs::remove_dir_all(directory).unwrap();
    }
}

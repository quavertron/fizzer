use std::{fs, path::{Path, PathBuf}, process::Command};
use crate::RemoteVaultRecord;


fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("FIZZER_STORAGE_BIN") { return path.into(); }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("fizzer-storage");
        if sibling.is_file() { return sibling; }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("../.native-tools/fizzer-storage");
    if dev.is_file() { return dev; }
    let system = PathBuf::from("/usr/local/libexec/fizzer/fizzer-storage");
    if system.is_file() { return system; }
    "fizzer-storage".into()
}

pub fn read(directory: &Path) -> Vec<RemoteVaultRecord> {
    let output = Command::new(binary())
        .arg("remote-vaults").arg("read").arg(directory)
        .output().ok();
    output.and_then(|out| if out.status.success() { serde_json::from_slice(&out.stdout).ok() } else { None })
        .unwrap_or_default()
}

pub fn save(directory: &Path, record: RemoteVaultRecord) -> Result<(), String> {
    let input = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut child = Command::new(binary())
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
    #[test]
    fn electron_and_tui_connection_updates_do_not_lose_other_vaults() {
        let directory = std::env::temp_dir().join(format!("fizzer-vault-writers-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let record = |id: &str, origin: &str, token: &str| RemoteVaultRecord {
            id: id.into(), name: "Test vault".into(), origin: origin.into(), token: token.into(), role: None,
        };
        let legacy = serde_json::to_vec(&vec![record("legacy", "https://legacy.example", "original")]).unwrap();
        fs::write(directory.join("remote-vaults.json"), &legacy).unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../cascade-electron/remote-vaults.cjs");
        let mut electron = std::process::Command::new("node").arg("-e")
            .arg("const {saveRemoteVault}=require(process.argv[1]); for(let i=0;i<50;i++) saveRemoteVault(process.argv[2], {id:'cloned', name:'Electron', origin:'https://server'+i+'.example', token:'electron'});")
            .arg(&module).arg(&directory).spawn().unwrap();
        for i in 0..50 { save(&directory, record(&format!("tui-{i}"), "https://tui.example", "tui")).unwrap(); }
        assert!(electron.wait().unwrap().success());
        assert_eq!(read(&directory).len(), 101);
        save(&directory, record("cloned", "https://server0.example", "renewed-by-tui")).unwrap();
        let status = std::process::Command::new("node").arg("-e")
            .arg("const m=require(process.argv[1]), assert=require('node:assert/strict'); const records=m.readRemoteVaults(process.argv[2]); assert.equal(records.length,101); assert.equal(records.find(r=>r.origin==='https://server0.example').token,'renewed-by-tui'); m.saveRemoteVault(process.argv[2], {id:'legacy',name:'Updated',origin:'https://legacy.example',token:'renewed-by-electron'});")
            .arg(&module).arg(&directory).status().unwrap();
        assert!(status.success());
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

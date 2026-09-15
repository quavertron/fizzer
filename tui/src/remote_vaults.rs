use std::{collections::BTreeMap, fs, path::Path};
use sha2::{Digest, Sha256};
use crate::RemoteVaultRecord;

fn key(record: &RemoteVaultRecord) -> String {
    serde_json::to_string(&[&record.origin, &record.id]).unwrap()
}

pub fn read(directory: &Path) -> Vec<RemoteVaultRecord> {
    let legacy: Vec<RemoteVaultRecord> = fs::read(directory.join("remote-vaults.json")).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let mut records = BTreeMap::new();
    let mut add = |mut record: RemoteVaultRecord| {
        if let Ok(url) = reqwest::Url::parse(&record.origin) {
            record.origin = url.origin().ascii_serialization();
            records.insert(key(&record), record);
        }
    };
    for record in legacy { add(record); }
    if let Ok(entries) = fs::read_dir(directory.join("remote-vaults")) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") { continue; }
            if let Some(record) = fs::read(entry.path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) { add(record); }
        }
    }
    records.into_values().collect()
}

pub fn save(directory: &Path, mut record: RemoteVaultRecord) -> Result<(), String> {
    use std::io::Write;
    record.origin = reqwest::Url::parse(&record.origin).map_err(|e| e.to_string())?.origin().ascii_serialization();
    let entries = directory.join("remote-vaults");
    fs::create_dir_all(&entries).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(key(&record).as_bytes()));
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let temporary = entries.join(format!("{hash}.{}.{timestamp}.tmp", std::process::id()));
    let destination = entries.join(format!("{hash}.json"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(&record).unwrap())?;
        drop(file);
        fs::rename(&temporary, destination)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result.map_err(|e| e.to_string())
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

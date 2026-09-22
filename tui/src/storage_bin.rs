use std::path::{Path, PathBuf};

pub fn binary() -> PathBuf {
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

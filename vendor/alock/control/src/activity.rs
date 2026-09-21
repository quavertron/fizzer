//! Activity shares the daemon command socket. Slow viewers never block writers.
use super::*;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;

const HISTORY_BYTES: usize = 16 * 1024 * 1024;
struct Viewer {
    socket: UnixStream,
    queue: VecDeque<Arc<Vec<u8>>>,
    offset: usize,
    bytes: usize,
}
struct Hub {
    epoch: String,
    seq: u64,
    history: VecDeque<(u64, Arc<Vec<u8>>)>,
    bytes: usize,
    viewers: Vec<Viewer>,
}
static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
fn hub() -> &'static Mutex<Hub> {
    HUB.get_or_init(|| {
        Mutex::new(Hub {
            epoch: token().unwrap_or_else(|_| std::process::id().to_string()),
            seq: 0,
            history: VecDeque::new(),
            bytes: 0,
            viewers: Vec::new(),
        })
    })
}
fn packet(value: serde_json::Value) -> Arc<Vec<u8>> {
    let mut data = value.to_string().into_bytes();
    data.push(b'\n');
    Arc::new(data)
}
pub fn publish(mut event: serde_json::Value) {
    if !event.is_object() {
        return;
    }
    if event["id"].as_str().unwrap_or("").is_empty() {
        event["id"] = serde_json::json!(token().unwrap_or_default());
    }
    let mut h = hub().lock().unwrap();
    h.seq += 1;
    let seq = h.seq;
    let data = packet(serde_json::json!({"Cursor":{"Epoch":h.epoch,"Seq":seq},"Event":event}));
    if data.len() > HISTORY_BYTES {
        return;
    }
    h.bytes += data.len();
    h.history.push_back((seq, data.clone()));
    while h.history.len() > 1024 || h.bytes > HISTORY_BYTES {
        if let Some((_, old)) = h.history.pop_front() {
            h.bytes -= old.len();
        }
    }
    h.viewers.retain_mut(|viewer| {
        if viewer.bytes + data.len() > HISTORY_BYTES * 2 {
            return false;
        }
        viewer.bytes += data.len();
        viewer.queue.push_back(data.clone());
        true
    });
}
pub fn tool(raw: &[u8], root: Option<&str>) -> Result<serde_json::Value> {
    if raw.len() > 16384 {
        return err(413, "Tool event too large");
    }
    let input: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| (400, "Invalid tool event".into()))?;
    if input["kind"] != "tool" {
        return err(400, "Only tool activity may be submitted");
    }
    let mut event = serde_json::json!({"kind":"tool","file":"","timestamp":
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()});
    for (key, limit) in [
        ("id", 128),
        ("agent", 128),
        ("tool", 256),
        ("detail", 1024),
        ("result", 32),
        ("root", 4096),
        ("run_id", 64),
    ] {
        if let Some(value) = input[key].as_str() {
            event[key] = serde_json::json!(value.chars().take(limit).collect::<String>());
        }
    }
    if let Some(root) = root {
        event["root"] = serde_json::json!(root);
    }
    Ok(event)
}
extern "C" {
    fn dup(fd: c_int) -> c_int;
}
#[no_mangle]
pub extern "C" fn activity_client(fd: c_int, data: *const u8, size: usize) {
    if data.is_null() || size > 16384 {
        return;
    }
    let Ok(request) = serde_json::from_slice::<serde_json::Value>(unsafe {
        std::slice::from_raw_parts(data, size)
    }) else {
        return;
    };
    if request["cmd"] == "activity" {
        if let Ok(event) = tool(request["event"].to_string().as_bytes(), None) {
            publish(event);
        }
        return;
    }
    if request["cmd"] != "watch" {
        return;
    }
    let mut h = hub().lock().unwrap();
    if h.viewers.len() >= 64 {
        return;
    }
    let copied = unsafe { dup(fd) };
    if copied < 0 {
        return;
    }
    let socket = unsafe { UnixStream::from_raw_fd(copied) };
    if socket.set_nonblocking(true).is_err() {
        return;
    }
    let epoch = request["cursor"]["Epoch"].as_str().unwrap_or("");
    let seq = request["cursor"]["Seq"].as_u64().unwrap_or(0);
    let first = h.history.front().map_or(h.seq + 1, |(seq, _)| *seq);
    let gap =
        !epoch.is_empty() && (epoch != h.epoch || seq.saturating_add(1) < first || seq > h.seq);
    let mut status = serde_json::json!({"Status":if gap {"Activity history changed or expired; some events could not be replayed."} else {""}});
    if request["tail"] == true {
        status["Cursor"] = serde_json::json!({"Epoch":h.epoch,"Seq":h.seq});
    }
    let mut queue = VecDeque::from([packet(status)]);
    for (index, data) in &h.history {
        if request["tail"] != true && (epoch != h.epoch || *index > seq) {
            queue.push_back(data.clone());
        }
    }
    let bytes = queue.iter().map(|data| data.len()).sum();
    h.viewers.push(Viewer {
        socket,
        queue,
        offset: 0,
        bytes,
    });
}
#[no_mangle]
pub extern "C" fn activity_poll() -> c_int {
    let mut h = hub().lock().unwrap();
    h.viewers.retain_mut(|v| {
        match v.socket.read(&mut [0u8; 1]) {
            Ok(0) => return false,
            Err(e) if e.kind() != std::io::ErrorKind::WouldBlock => return false,
            _ => {}
        }
        while let Some(data) = v.queue.front() {
            match v.socket.write(&data[v.offset..]) {
                Ok(0) => return false,
                Ok(size) => {
                    v.offset += size;
                    v.bytes -= size;
                    if v.offset == data.len() {
                        v.queue.pop_front();
                        v.offset = 0;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return false,
            }
        }
        true
    });
    h.viewers.len() as c_int
}
#[no_mangle]
pub extern "C" fn activity_edit(
    file: *const c_char,
    agent: *const c_char,
    author: *const c_char,
    start: u32,
    end: u32,
    before: *const u8,
    before_size: usize,
    after: *const u8,
    after_size: usize,
) {
    let text = |ptr| unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    let mut event = activity("edit", &text(file), &text(author), start.into(), end.into());
    event["agent"] = serde_json::json!(text(agent));
    let lines = |ptr, size| {
        if size == 0 {
            Vec::<String>::new()
        } else {
            String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, size) })
                .split_terminator('\n')
                .map(str::to_owned)
                .collect()
        }
    };
    event["old_lines"] = serde_json::json!(lines(before, before_size));
    event["new_lines"] = serde_json::json!(lines(after, after_size));
    publish(event);
}
#[no_mangle]
pub extern "C" fn activity_lock(
    file: *const c_char,
    agent: *const c_char,
    start: u32,
    end: u32,
    result: *const c_char,
    blocker: *const c_char,
    detail: *const c_char,
) {
    let text = |ptr| unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    let mut event = activity("lock", &text(file), &text(agent), start.into(), end.into());
    event["result"] = serde_json::json!(text(result));
    if !blocker.is_null() {
        event["conflict_agent"] = serde_json::json!(text(blocker));
    }
    if !detail.is_null() { event["detail"] = serde_json::json!(text(detail)); }
    publish(event);
}

#[no_mangle]
pub extern "C" fn activity_release(file: *const c_char, agent: *const c_char, author: *const c_char, start: u32, end: u32) {
    let text = |ptr| unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    let mut event = activity("lock", &text(file), &text(author), start.into(), end.into());
    event["agent"] = serde_json::json!(text(agent));
    event["result"] = serde_json::json!("released");
    publish(event);
}

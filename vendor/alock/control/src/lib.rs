//! Separate-account decision flow. C owns filesystem, lock, nab and codec APIs.
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
mod transport;

type Value = c_void;
type Locks = c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Range {
    start: u64,
    length: u64,
    line_start: u32,
    line_end: u32,
}
extern "C" {
    fn dtob_kvset() -> *mut Value;
    fn account_put(v: *mut Value, key: *const c_char, value: *mut Value);
    fn dtob_uint(value: u64) -> *mut Value;
    fn dtob_raw(data: *const u8, size: usize) -> *mut Value;
    fn dtob_free(v: *mut Value);
    fn dtob_kvset_uint(v: *const Value, key: *const c_char) -> u64;
    fn dtob_kvset_raw(v: *const Value, key: *const c_char, size: *mut usize) -> *const u8;
    fn account_read(
        path: *const c_char,
        size: *mut usize,
        mode: *mut c_uint,
        exists: *mut c_int,
    ) -> *mut u8;
    fn account_publish(
        path: *const c_char,
        data: *const u8,
        size: usize,
        mode: c_uint,
        exists: c_int,
    ) -> c_int;
    fn account_lock(
        lt: *mut Locks,
        agent: *const c_char,
        path: *const c_char,
        range: *const Range,
    ) -> c_int;
    fn account_lock_get(lt: *mut Locks, id: c_int, range: *mut Range) -> c_int;
    fn account_unlock(lt: *mut Locks, id: c_int);
    fn account_adjust(lt: *mut Locks, id: c_int, path: *const c_char, size: usize, lines: i64);
    fn account_random(bytes: *mut u8, size: usize) -> c_int;
    fn alock_content_hash(data: *const u8, size: usize, hash: *mut c_char);
    fn syntax_check(path: *const c_char, data: *const u8, size: usize) -> c_int;
    fn history_author_valid(author: *const c_char) -> c_int;
    fn history_record_account(
        path: *const c_char,
        author: *const c_char,
        operation: *const c_char,
        before: *const u8,
        before_size: usize,
        after: *const u8,
        after_size: usize,
        error: *mut c_char,
        error_size: usize,
    ) -> c_int;
    fn account_notify(
        path: *const c_char,
        start: u32,
        end: u32,
        author: *const c_char,
        before: *const u8,
        before_size: usize,
        after: *const u8,
        after_size: usize,
    );
    fn free(ptr: *mut c_void);
    fn account_safe(path: *const c_char) -> c_int;
}
const LIMIT: usize = 4 * 1024 * 1024;
type Result<T> = std::result::Result<T, (u64, String)>;
fn err<T>(status: u64, message: &str) -> Result<T> {
    Err((status, message.into()))
}
fn c(s: &str) -> CString {
    CString::new(s).expect("validated NUL-free field")
}
struct Message(*mut Value);
impl Drop for Message {
    fn drop(&mut self) {
        unsafe { dtob_free(self.0) }
    }
}
impl Message {
    fn new() -> Self {
        Self(unsafe { dtob_kvset() })
    }
    fn number(&mut self, key: &str, value: u64) {
        unsafe {
            account_put(self.0, c(key).as_ptr(), dtob_uint(value));
        }
    }
    fn bytes(&mut self, key: &str, value: &[u8]) {
        unsafe {
            account_put(
                self.0,
                c(key).as_ptr(),
                dtob_raw(value.as_ptr(), value.len()),
            );
        }
    }
    fn text(&mut self, key: &str, value: &str) {
        self.bytes(key, value.as_bytes());
    }
    fn into_raw(self) -> *mut Value {
        let ptr = self.0;
        std::mem::forget(self);
        ptr
    }
}
fn number(req: *const Value, key: &str) -> u64 {
    unsafe { dtob_kvset_uint(req, c(key).as_ptr()) }
}
fn bytes(req: *const Value, key: &str, limit: usize) -> Result<Vec<u8>> {
    let mut size = 0;
    let ptr = unsafe { dtob_kvset_raw(req, c(key).as_ptr(), &mut size) };
    if size > limit || (size > 0 && ptr.is_null()) {
        return err(400, "Field exceeds limit");
    }
    Ok(if size == 0 {
        vec![]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec()
    })
}
fn text(req: *const Value, key: &str, limit: usize) -> Result<String> {
    let data = bytes(req, key, limit)?;
    if data.contains(&0) {
        return err(400, "NUL in text field");
    }
    String::from_utf8(data).map_err(|_| (400, "Invalid UTF-8 field".into()))
}
fn ok() -> Message {
    let mut m = Message::new();
    m.number("ok", 1);
    m.number("status", 200);
    m
}
fn error(status: u64, message: &str) -> Message {
    let mut m = Message::new();
    m.number("ok", 0);
    m.number("status", status);
    m.text("error", message);
    m
}
struct Contents {
    data: Vec<u8>,
    mode: u32,
    exists: bool,
}
fn read(path: &str) -> Result<Contents> {
    if unsafe { account_safe(c(path).as_ptr()) } == 0 {
        return err(403, "Unsafe target permissions or parent path");
    }
    let (mut size, mut mode, mut exists) = (0, 0, 0);
    let ptr = unsafe { account_read(c(path).as_ptr(), &mut size, &mut mode, &mut exists) };
    if ptr.is_null() {
        return err(400, "Cannot read regular target (maximum 4 MiB)");
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, size).to_vec() };
    unsafe {
        free(ptr.cast());
    }
    Ok(Contents {
        data,
        mode,
        exists: exists != 0,
    })
}
fn hash(data: &[u8]) -> String {
    let mut out = [0 as c_char; 65];
    unsafe {
        alock_content_hash(data.as_ptr(), data.len(), out.as_mut_ptr());
        CStr::from_ptr(out.as_ptr()).to_string_lossy().into_owned()
    }
}
fn plausible(path: &str, data: &[u8]) -> Result<bool> {
    match unsafe { syntax_check(c(path).as_ptr(), data.as_ptr(), data.len()) } {
        1 => Ok(true),
        0 => Ok(false),
        _ => err(500, "Configured syntax checker could not run"),
    }
}
fn token() -> Result<String> {
    let mut data = [0; 24];
    if unsafe { account_random(data.as_mut_ptr(), data.len()) } != 0 {
        return err(500, "Cannot allocate ticket");
    }
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}
fn range(data: &[u8], ls: u64, le: u64) -> Result<Range> {
    if ls == 0 || le < ls || le > u32::MAX as u64 {
        return err(400, "Invalid line range");
    }
    let mut starts = vec![0];
    for (i, b) in data.iter().enumerate() {
        if *b == b'\n' {
            starts.push(i + 1);
        }
    }
    if !data.is_empty() && data.last() != Some(&b'\n') {
        starts.push(data.len());
    }
    let start = *starts
        .get(ls as usize - 1)
        .ok_or((400, "Range starts beyond EOF".into()))?;
    let end = starts.get(le as usize).copied().unwrap_or(data.len());
    Ok(Range {
        start: start as u64,
        length: (end - start) as u64,
        line_start: ls as u32,
        line_end: le as u32,
    })
}
fn live(lt: *mut Locks, id: i32) -> Option<Range> {
    let mut r = Range::default();
    (unsafe { account_lock_get(lt, id, &mut r) } != 0).then_some(r)
}
struct Pending {
    before: Vec<u8>,
    author: String,
}
#[derive(Default)]
struct FileState {
    members: HashSet<String>,
    pending: Option<Pending>,
}
struct Proposal {
    session: String,
    path: String,
    lock: i32,
    base: Vec<u8>,
    range: Range,
    exists: bool,
    persistent_until: Option<Instant>,
}
#[derive(Default)]
struct Controller {
    sessions: HashMap<String, Instant>,
    files: HashMap<String, FileState>,
    proposals: HashMap<String, Proposal>,
}
impl Controller {
    fn checkpoint(&mut self, path: &str, current: &[u8]) -> Result<()> {
        let Some(pending) = self.files.get(path).and_then(|f| f.pending.as_ref()) else {
            return Ok(());
        };
        let before = if plausible(path, &pending.before)? {
            &pending.before[..]
        } else {
            current
        };
        let mut error = [0 as c_char; 512];
        let failed = unsafe {
            history_record_account(
                c(path).as_ptr(),
                c(&pending.author).as_ptr(),
                c("edit").as_ptr(),
                before.as_ptr(),
                before.len(),
                current.as_ptr(),
                current.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if failed != 0 {
            return Err((
                500,
                unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
        self.files.get_mut(path).unwrap().pending = None;
        Ok(())
    }
    fn conclude(&mut self, session: &str, lt: *mut Locks) -> Result<()> {
        let paths: Vec<_> = self
            .files
            .iter()
            .filter(|(_, f)| f.members.contains(session))
            .map(|(p, _)| p.clone())
            .collect();
        let mut failure = None;
        for path in paths {
            let checked = match read(&path) {
                Ok(current) => plausible(&path, &current.data).and_then(|valid| {
                    if valid {
                        self.checkpoint(&path, &current.data)
                    } else {
                        Ok(())
                    }
                }),
                Err(_) => Ok(()), // Missing/unreadable master cannot pass syntax; release ordinary locks.
            };
            if let Err(e) = checked {
                failure = Some(e);
            } else {
                self.files.get_mut(&path).unwrap().members.remove(session);
            }
        }
        for p in self
            .proposals
            .values()
            .filter(|p| p.session == session && p.persistent_until.is_none())
        {
            unsafe {
                account_unlock(lt, p.lock);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    fn expire(&mut self, lt: *mut Locks) {
        let now = Instant::now();
        for p in self.proposals.values() {
            if p.persistent_until.is_some_and(|until| now >= until) {
                unsafe {
                    account_unlock(lt, p.lock);
                }
            }
        }
        let expired: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, last)| now.duration_since(**last) >= Duration::from_secs(30))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if self.conclude(&id, lt).is_err() {
                continue;
            }
            self.proposals
                .retain(|_, p| p.session != id || live(lt, p.lock).is_some());
            if !self.proposals.values().any(|p| p.session == id) {
                self.sessions.remove(&id);
            }
        }
        self.files.retain(|path, f| {
            f.pending.is_some()
                || !f.members.is_empty()
                || self.proposals.values().any(|p| &p.path == path)
        });
    }
    fn acquire(
        &mut self,
        session: &str,
        path: &str,
        baseline_hash: &str,
        ls: u64,
        le: u64,
        ttl: u64,
        lt: *mut Locks,
    ) -> Result<String> {
        if ttl > 600 {
            return err(400, "Persistent lease cannot exceed 600 seconds");
        }
        if self.proposals.len() >= 256 || self.files.len() >= 256 && !self.files.contains_key(path)
        {
            return err(503, "Account coordination capacity reached");
        }
        let current = read(path)?;
        if !baseline_hash.is_empty() && baseline_hash != hash(&current.data) {
            return err(409, "Content SHA-256 differs from authoritative master");
        }
        let range = range(&current.data, ls, le)?;
        let ticket = token()?;
        let lock = unsafe { account_lock(lt, c(session).as_ptr(), c(path).as_ptr(), &range) };
        if lock < 0 {
            return err(409, "Another agent holds a lock on this range");
        }
        let concurrent = self
            .files
            .get(path)
            .is_some_and(|f| f.members.iter().any(|other| other != session));
        let checkpoint = if concurrent {
            plausible(path, &current.data).and_then(|valid| {
                if valid {
                    self.checkpoint(path, &current.data)
                } else {
                    Ok(())
                }
            })
        } else {
            Ok(())
        };
        if let Err(e) = checkpoint {
            unsafe {
                account_unlock(lt, lock);
            }
            return Err(e);
        }
        self.files
            .entry(path.into())
            .or_default()
            .members
            .insert(session.into());
        self.proposals.insert(
            ticket.clone(),
            Proposal {
                session: session.into(),
                path: path.into(),
                lock,
                base: current.data,
                range,
                exists: current.exists,
                persistent_until: (ttl > 0).then(|| Instant::now() + Duration::from_secs(ttl)),
            },
        );
        Ok(ticket)
    }
    fn proposal_response(&self, ticket: &str) -> Message {
        let p = &self.proposals[ticket];
        let mut result = ok();
        result.text("ticket", ticket);
        result.text("sha256", &hash(&p.base));
        result.bytes("content", &p.base);
        result.number("start", p.range.start);
        result.number("length", p.range.length);
        result
    }
    fn request(&mut self, req: *const Value, lt: *mut Locks) -> Result<Message> {
        let operation = text(req, "operation", 32)?;
        let session = text(req, "session", 95)?;
        if session.is_empty()
            || !session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        {
            return err(400, "Invalid session");
        }
        if self.sessions.len() >= 128 && !self.sessions.contains_key(&session) {
            return err(503, "Session capacity reached");
        }
        self.sessions.insert(session.clone(), Instant::now());
        match operation.as_str() {
            "heartbeat" => return Ok(ok()),
            "conclude" => {
                self.conclude(&session, lt)?;
                return Ok(ok());
            }
            _ => {}
        }
        let author = text(req, "author", 32)?;
        if operation != "release" && unsafe { history_author_valid(c(&author).as_ptr()) } == 0 {
            return err(
                400,
                "Author is required (1-32 bytes, no control characters)",
            );
        }
        if operation == "lock" {
            let path = text(req, "file", 4095)?;
            if !path.starts_with('/') {
                return err(400, "Expected canonical absolute path");
            }
            let sha = text(req, "sha256", 64)?;
            if number(req, "remote") != 0 && sha.is_empty() {
                return err(400, "Remote locks require content SHA-256");
            }
            let ticket = self.acquire(
                &session,
                &path,
                &sha,
                number(req, "line_start"),
                number(req, "line_end"),
                number(req, "persistent_seconds"),
                lt,
            )?;
            return Ok(self.proposal_response(&ticket));
        }
        let ticket = text(req, "ticket", 48)?;
        let p = self
            .proposals
            .get(&ticket)
            .filter(|p| p.session == session)
            .ok_or((409, "Unknown ticket".into()))?;
        if operation == "release" {
            unsafe {
                account_unlock(lt, p.lock);
            }
            self.proposals.remove(&ticket);
            return Ok(ok());
        }
        if operation != "commit" {
            return err(400, "Unknown operation");
        }
        let replacement = bytes(req, "replacement", LIMIT)?;
        let path = p.path.clone();
        let current = read(&path)?;
        if current.exists != p.exists {
            return err(409, "Master existence changed");
        }
        if live(lt, p.lock).is_none() {
            if hash(&current.data) != hash(&p.base) {
                return err(409, "Lock expired or unclaimed and head changed");
            }
            let r = p.range;
            // Renewal follows request-lock logic; a newly held range still wins.
            let renewed = self.acquire(
                &session,
                &path,
                &hash(&current.data),
                r.line_start.into(),
                r.line_end.into(),
                0,
                lt,
            )?;
            let new = self.proposals.remove(&renewed).unwrap();
            let p = self.proposals.get_mut(&ticket).unwrap();
            p.lock = new.lock;
            p.persistent_until = None;
        }
        let p = &self.proposals[&ticket];
        let live_range = live(lt, p.lock).ok_or((409, "Lock renewal failed".into()))?;
        let start = live_range.start as usize;
        let length = p.range.length as usize;
        if live_range.length != p.range.length
            || current.data.get(start..start.saturating_add(length))
                != p.base
                    .get(p.range.start as usize..(p.range.start + p.range.length) as usize)
        {
            return err(409, "Locked range changed since staging");
        }
        let updated_size = current.data.len() - length + replacement.len();
        if updated_size > LIMIT {
            return err(413, "Result exceeds 4 MiB");
        }
        let mut updated = Vec::with_capacity(updated_size);
        updated.extend_from_slice(&current.data[..start]);
        updated.extend_from_slice(&replacement);
        updated.extend_from_slice(&current.data[start + length..]);
        if !plausible(&path, &updated)? {
            return err(422, "Candidate failed configured syntax check");
        }
        if unsafe {
            account_publish(
                c(&path).as_ptr(),
                updated.as_ptr(),
                updated.len(),
                current.mode,
                current.exists as c_int,
            )
        } != 0
        {
            return err(500, "Cannot publish master");
        }
        let line_delta = replacement.iter().filter(|b| **b == b'\n').count() as i64
            - current.data[start..start + length]
                .iter()
                .filter(|b| **b == b'\n')
                .count() as i64;
        let lock = p.lock;
        unsafe {
            account_adjust(lt, lock, c(&path).as_ptr(), replacement.len(), line_delta);
        }
        let new_range = live(lt, lock).unwrap();
        unsafe {
            account_notify(
                c(&path).as_ptr(),
                new_range.line_start,
                new_range.line_end,
                c(&author).as_ptr(),
                current.data[start..start + length].as_ptr(),
                length,
                replacement.as_ptr(),
                replacement.len(),
            );
        }
        let file = self.files.entry(path.clone()).or_default();
        file.members.insert(session.clone());
        if file.pending.is_none() {
            file.pending = Some(Pending {
                before: current.data,
                author: author.clone(),
            });
        }
        file.pending.as_mut().unwrap().author = author;
        let concurrent = file.members.iter().any(|other| other != &session);
        let recorded = if concurrent {
            self.checkpoint(&path, &updated)
        } else {
            Ok(())
        };
        let p = self.proposals.get_mut(&ticket).unwrap();
        p.base = updated;
        p.range = new_range;
        p.exists = true;
        let mut result = self.proposal_response(&ticket);
        if let Err((_, message)) = recorded {
            result.text("historyError", &message);
            result.number("committed", 1);
        }
        Ok(result)
    }
}
static CONTROLLER: OnceLock<Mutex<Controller>> = OnceLock::new();
fn controller() -> &'static Mutex<Controller> {
    CONTROLLER.get_or_init(|| Mutex::new(Controller::default()))
}
#[no_mangle]
pub extern "C" fn account_request(req: *const Value, lt: *mut Locks) -> *mut Value {
    let mut controller = controller().lock().unwrap();
    controller.expire(lt);
    match controller.request(req, lt) {
        Ok(m) => m,
        Err((status, message)) => {
            let mut result = error(status, &message);
            if number(req, "remote") != 0
                && text(req, "operation", 32).ok().as_deref() == Some("commit")
            {
                if let (Ok(ticket), Ok(session), Ok(replacement)) = (
                    text(req, "ticket", 48),
                    text(req, "session", 95),
                    bytes(req, "replacement", LIMIT),
                ) {
                    if let Some(p) = controller
                        .proposals
                        .get(&ticket)
                        .filter(|p| p.session == session)
                    {
                        let mut content = p.base[..p.range.start as usize].to_vec();
                        content.extend_from_slice(&replacement);
                        content.extend_from_slice(
                            &p.base[(p.range.start + p.range.length) as usize..],
                        );
                        if let Ok(suffix) = token() {
                            let pending = format!("{}.pending-{}", p.path, suffix);
                            if unsafe {
                                account_publish(
                                    c(&pending).as_ptr(),
                                    content.as_ptr(),
                                    content.len(),
                                    0o600,
                                    0,
                                )
                            } == 0
                            {
                                result.text("pending", &pending);
                            } else {
                                result
                                    .text("pendingError", "Could not save remote pending proposal");
                            }
                        }
                    }
                }
            }
            result
        }
    }
    .into_raw()
}
#[no_mangle]
pub extern "C" fn account_expire(lt: *mut Locks) {
    controller().lock().unwrap().expire(lt);
}
#[no_mangle]
pub extern "C" fn account_active() -> c_int {
    (!controller().lock().unwrap().sessions.is_empty()) as c_int
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn line_ranges_include_newlines_and_allow_eof_insertions() {
        let r = range(b"one\ntwo\n", 2, 2).unwrap();
        assert_eq!((r.start, r.length), (4, 4));
        let r = range(b"one\ntwo", 3, 3).unwrap();
        assert_eq!((r.start, r.length), (7, 0));
        assert!(range(b"one\n", 3, 3).is_err());
        assert_eq!(range(b"", 1, 1).unwrap().length, 0);
    }
}

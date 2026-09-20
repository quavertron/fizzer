use super::*;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};

extern "C" {
    fn dtob_encode(value: *const Value, size: *mut usize) -> *mut u8;
    fn dtob_decode(data: *const u8, size: usize) -> *mut Value;
    fn account_daemon(value: *mut Value) -> *mut Value;
    fn account_target(root: *const c_char, relative: *const c_char, out: *mut c_char) -> c_int;
    fn account_peer(fd: c_int, uid: c_uint) -> c_int;
    fn account_user(name: *const c_char) -> c_int;
    fn account_root(path: *const c_char, out: *mut c_char) -> c_int;
    fn account_temp(data: *const u8, size: usize, out: *mut c_char) -> c_int;
    fn account_load(path: *const c_char, size: *mut usize) -> *mut u8;
    fn account_signals();
    fn account_stopped() -> c_int;
    fn account_control() -> c_int;
    fn account_envelope_valid(value: *const Value) -> c_int;
    fn unlink(path: *const c_char) -> c_int;
    fn chmod(path: *const c_char, mode: c_uint) -> c_int;
}
fn io<T>(value: std::io::Result<T>) -> Result<T> {
    value.map_err(|e| (502, e.to_string()))
}
fn encode(m: &Message) -> Result<Vec<u8>> {
    let mut size = 0;
    let ptr = unsafe { dtob_encode(m.0, &mut size) };
    if ptr.is_null() {
        return err(500, "Cannot encode DTOB");
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, size).to_vec() };
    unsafe {
        free(ptr.cast());
    }
    Ok(data)
}
fn decode(data: &[u8]) -> Result<Message> {
    if data.len() > 16 * 1024 * 1024 {
        return err(413, "DTOB envelope exceeds limit");
    }
    let ptr = unsafe { dtob_decode(data.as_ptr(), data.len()) };
    if unsafe { account_envelope_valid(ptr) } == 0 {
        if !ptr.is_null() {
            unsafe {
                dtob_free(ptr);
            }
        }
        return err(400, "Malformed or duplicate-key DTOB envelope");
    }
    Ok(Message(ptr))
}
fn load(path: &str) -> Result<Vec<u8>> {
    let mut size = 0;
    let ptr = unsafe { account_load(c(path).as_ptr(), &mut size) };
    if ptr.is_null() {
        return err(400, "Cannot read bounded regular input");
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, size).to_vec() };
    unsafe {
        free(ptr.cast());
    }
    Ok(data)
}
fn temporary(data: &[u8]) -> Result<String> {
    let mut path = [0 as c_char; 4096];
    if unsafe { account_temp(data.as_ptr(), data.len(), path.as_mut_ptr()) } != 0 {
        return err(500, "Cannot write temporary proposal");
    }
    Ok(unsafe { CStr::from_ptr(path.as_ptr()) }
        .to_string_lossy()
        .into_owned())
}
fn save(path: &str, data: &[u8], exists: bool) -> Result<()> {
    if unsafe {
        account_publish(
            c(path).as_ptr(),
            data.as_ptr(),
            data.len(),
            0o600,
            exists as c_int,
        )
    } != 0
    {
        return err(500, "Cannot write proposal metadata");
    }
    Ok(())
}
fn send(stream: &mut UnixStream, m: &Message) -> Result<()> {
    let data = encode(m)?;
    io(stream.write_all(&(data.len() as u32).to_le_bytes()))?;
    io(stream.write_all(&data))
}
fn receive(stream: &mut UnixStream) -> Result<Message> {
    let mut header = [0; 4];
    io(stream.read_exact(&mut header))?;
    let size = u32::from_le_bytes(header) as usize;
    if size > 16 * 1024 * 1024 {
        return err(413, "DTOB frame exceeds limit");
    }
    let mut data = vec![0; size];
    io(stream.read_exact(&mut data))?;
    decode(&data)
}
fn exchange(socket: &str, message: &Message) -> Result<Message> {
    let mut stream = io(UnixStream::connect(socket))?;
    io(stream.set_read_timeout(Some(Duration::from_secs(25))))?;
    io(stream.set_write_timeout(Some(Duration::from_secs(25))))?;
    send(&mut stream, message)?;
    receive(&mut stream)
}
fn daemon(req: &mut Message) -> Result<Message> {
    req.text("cmd", "account");
    let ptr = unsafe { account_daemon(req.0) };
    if ptr.is_null() {
        return err(502, "Daemon unavailable; verify outcome before retrying");
    }
    Ok(Message(ptr))
}
fn checked(m: Message) -> Result<Message> {
    if number(m.0, "ok") == 1 {
        Ok(m)
    } else {
        Err((
            number(m.0, "status"),
            text(m.0, "error", 4096).unwrap_or_default(),
        ))
    }
}
fn scoped(req: &mut Message, root: &str, session: &str, remote: bool) -> Result<()> {
    req.text("session", session);
    req.number("remote", remote as u64);
    let operation = text(req.0, "operation", 32)?;
    if !["lock", "commit", "conclude", "heartbeat", "release"].contains(&operation.as_str()) {
        return err(400, "Unknown account operation");
    }
    if operation == "lock" {
        let relative = text(req.0, "file", 4095)?;
        let mut path = [0 as c_char; 4096];
        if unsafe { account_target(c(root).as_ptr(), c(&relative).as_ptr(), path.as_mut_ptr()) }
            == 0
        {
            return err(403, "Unsafe path or target permissions");
        }
        req.text(
            "file",
            &unsafe { CStr::from_ptr(path.as_ptr()) }.to_string_lossy(),
        );
    }
    Ok(())
}
fn remote(
    req: &Message,
    url: &str,
    authorization: &str,
    client: &reqwest::blocking::Client,
) -> Result<Message> {
    let operation = text(req.0, "operation", 32)?;
    if !["lock", "commit", "conclude", "heartbeat", "release"].contains(&operation.as_str()) {
        return err(400, "Unknown remote operation");
    }
    let response = client
        .post(format!("{}/{operation}", url.trim_end_matches('/')))
        .header("content-type", "application/vnd.dtob")
        .header("authorization", authorization)
        .body(encode(req)?)
        .send()
        .map_err(|_| {
            (
                502,
                "Remote transport failed; outcome may be unknown".into(),
            )
        })?;
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/vnd.dtob"))
    {
        return Ok(error(
            response.status().as_u16().into(),
            "Remote endpoint did not return DTOB",
        ));
    }
    let mut data = Vec::new();
    io(response.take(16 * 1024 * 1024 + 1).read_to_end(&mut data))?;
    decode(&data)
}
fn option(args: &[String], key: &str) -> Result<String> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].clone())
        .ok_or((400, format!("Missing {key}")))
}
fn optional(args: &[String], key: &str) -> Option<String> {
    option(args, key).ok()
}
fn root(args: &[String]) -> Result<String> {
    let mut out = [0 as c_char; 4096];
    if unsafe { account_root(c(&option(args, "--root")?).as_ptr(), out.as_mut_ptr()) } != 0 {
        return err(403, "Unsafe root");
    }
    Ok(unsafe { CStr::from_ptr(out.as_ptr()) }
        .to_string_lossy()
        .into_owned())
}
struct SocketPath(String);
impl Drop for SocketPath {
    fn drop(&mut self) {
        unsafe {
            unlink(c(&self.0).as_ptr());
        }
    }
}
fn serve(args: &[String]) -> Result<()> {
    let root = root(args)?;
    let socket = option(args, "--socket")?;
    let uid = unsafe { account_user(c(&option(args, "--user")?).as_ptr()) };
    if uid < 0 {
        return err(
            403,
            "Run as human non-root user and select a different non-root account",
        );
    }
    let url = optional(args, "--remote-url");
    let header = optional(args, "--header-file");
    if url.is_some() && header.is_none() {
        return err(400, "Remote bridge requires human-owned --header-file");
    }
    let authorization = match header {
        Some(path) => String::from_utf8(load(&path)?)
            .map_err(|_| (400, "Invalid authorization file".into()))?
            .trim()
            .strip_prefix("Authorization: ")
            .ok_or((400, "Expected Authorization header".into()))?
            .to_owned(),
        None => String::new(),
    };
    // Start the C daemon before Rust's HTTP runtime creates threads.
    if url.is_none() {
        let mut warmup = Message::new();
        warmup.text("operation", "heartbeat");
        warmup.text("session", &token()?);
        checked(daemon(&mut warmup)?)?;
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| (500, e.to_string()))?;
    if unsafe { account_safe(c(&socket).as_ptr()) } == 0 {
        return err(403, "Unsafe or already occupied socket path");
    }
    let listener = io(UnixListener::bind(&socket))?;
    let _socket_path = SocketPath(socket.clone());
    if unsafe { chmod(c(&socket).as_ptr(), 0o666) } != 0 {
        return err(500, "Cannot set bridge socket permissions");
    }
    io(listener.set_nonblocking(true))?;
    unsafe {
        account_signals();
    }
    let session = token()?;
    let forward = |req: &mut Message| -> Result<Message> {
        if let Some(url) = &url {
            req.text("session", &session);
            remote(req, url, &authorization, &client)
        } else {
            scoped(req, &root, &session, false)?;
            daemon(req)
        }
    };
    let mut initial = Message::new();
    initial.text("operation", "heartbeat");
    checked(forward(&mut initial)?)?;
    let mut heartbeat = Instant::now();
    println!("{{\"ready\":true}}");
    while unsafe { account_stopped() } == 0 {
        let control = unsafe { account_control() };
        if control == 2 && args.iter().any(|arg| arg == "--control-stdin") {
            break;
        }
        if control == 1 {
            let mut req = Message::new();
            req.text("operation", "conclude");
            checked(forward(&mut req)?)?;
            println!("{{\"concluded\":true}}");
        }
        if heartbeat.elapsed() >= Duration::from_secs(5) {
            let mut req = Message::new();
            req.text("operation", "heartbeat");
            if let Err((_, message)) = forward(&mut req).and_then(checked) {
                eprintln!("alock: {message}");
            }
            heartbeat = Instant::now();
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                io(stream.set_read_timeout(Some(Duration::from_secs(10))))?;
                io(stream.set_write_timeout(Some(Duration::from_secs(10))))?;
                let result = if unsafe { account_peer(stream.as_raw_fd(), uid as u32) } == 0 {
                    err(403, "Unix peer UID is not authorized")
                } else {
                    receive(&mut stream).and_then(|mut req| forward(&mut req))
                };
                let response = result.unwrap_or_else(|(status, message)| error(status, &message));
                let _ = send(&mut stream, &response);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(e) => return Err((500, e.to_string())),
        }
    }
    let mut done = Message::new();
    done.text("operation", "conclude");
    let result = forward(&mut done).and_then(checked);
    result.map(|_| ())
}
fn quote(s: &str) -> String {
    let mut result = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            ch if ch < ' ' => result.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => result.push(ch),
        }
    }
    result.push('"');
    result
}
fn http_serve(args: &[String]) -> Result<()> {
    let root = root(args)?;
    let authorization = String::from_utf8(load(&option(args, "--header-file")?)?)
        .map_err(|_| (400, "Invalid authorization file".into()))?;
    let authorization = authorization
        .trim()
        .strip_prefix("Authorization: ")
        .ok_or((400, "Expected Authorization header".into()))?
        .to_owned();
    if authorization.len() < 32 {
        return err(400, "HTTP daemon requires a private bearer credential");
    }
    let mut warmup = Message::new();
    warmup.text("operation", "heartbeat");
    warmup.text("session", &token()?);
    checked(daemon(&mut warmup)?)?;
    let server =
        tiny_http::Server::http(option(args, "--listen")?).map_err(|e| (500, e.to_string()))?;
    unsafe {
        account_signals();
    }
    println!(
        "{{\"ready\":true,\"address\":{}}}",
        quote(&server.server_addr().to_string())
    );
    while unsafe { account_stopped() } == 0 {
        if args.iter().any(|arg| arg == "--control-stdin") && unsafe { account_control() } == 2 {
            break;
        }
        let Some(mut request) = io(server.recv_timeout(Duration::from_millis(100)))? else {
            continue;
        };
        let received_auth = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str())
            .unwrap_or("");
        let authorized = received_auth.len() == authorization.len()
            && received_auth
                .bytes()
                .zip(authorization.bytes())
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0;
        let result = (|| -> Result<Message> {
            if !authorized {
                return err(401, "Unauthorized");
            }
            if request.method() != &tiny_http::Method::Post {
                return err(405, "POST required");
            }
            if !request.headers().iter().any(|h| {
                h.field.equiv("Content-Type") && h.value.as_str() == "application/vnd.dtob"
            }) {
                return err(415, "DTOB content type required");
            }
            let operation = request.url().trim_start_matches('/').to_owned();
            let namespace = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-Alock-Namespace"))
                .map(|h| h.value.as_str().to_owned())
                .unwrap_or_else(|| "direct".into());
            let mut data = Vec::new();
            io(request
                .as_reader()
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut data))?;
            let mut req = decode(&data)?;
            if text(req.0, "operation", 32)? != operation {
                return err(400, "Operation does not match endpoint");
            }
            let session = text(req.0, "session", 95)?;
            let scoped_session = hash(format!("{namespace}\0{session}").as_bytes());
            scoped(&mut req, &root, &scoped_session, true)?;
            daemon(&mut req)
        })();
        let response = result.unwrap_or_else(|(status, message)| error(status, &message));
        let body = encode(&response)?;
        let header = tiny_http::Header::from_bytes("Content-Type", "application/vnd.dtob").unwrap();
        let _ = request.respond(
            tiny_http::Response::from_data(body)
                .with_status_code(number(response.0, "status") as u16)
                .with_header(header),
        );
    }
    Ok(())
}
fn cli(args: &[String]) -> Result<()> {
    let operation = args.get(2).map(String::as_str).unwrap_or("");
    if operation == "--help" || operation.is_empty() {
        println!("alock account serve --root DIR --user USER --socket SOCKET [--remote-url URL --header-file FILE]\nalock account http-serve --root DIR --listen ADDRESS --header-file FILE\nalock account stage --socket SOCKET --path FILE --author NAME [--lines START-END] [--persistent SECONDS] [--base FILE | --sha256 HASH]\nalock account commit --socket SOCKET --ticket TICKET --file PROPOSAL --author NAME\nalock account conclude --socket SOCKET\nalock account release --socket SOCKET --ticket TICKET");
        return Ok(());
    }
    if operation == "serve" {
        return serve(args);
    }
    if operation == "http-serve" {
        return http_serve(args);
    }
    let socket = option(args, "--socket")?;
    let mut req = Message::new();
    req.text(
        "operation",
        match operation {
            "stage" => "lock",
            "abort" => "release",
            other => other,
        },
    );
    if operation == "stage" {
        let path = option(args, "--path")?;
        req.text("file", &path);
        req.text("author", &option(args, "--author")?);
        let lines = optional(args, "--lines").unwrap_or("1-2147483647".into());
        let (start, end) = lines
            .split_once('-')
            .ok_or((400, "Expected --lines START-END".into()))?;
        req.number(
            "line_start",
            start.parse().map_err(|_| (400, "Invalid range".into()))?,
        );
        req.number(
            "line_end",
            end.parse().map_err(|_| (400, "Invalid range".into()))?,
        );
        if let Some(ttl) = optional(args, "--persistent") {
            req.number(
                "persistent_seconds",
                ttl.parse()
                    .map_err(|_| (400, "Invalid persistent lease".into()))?,
            );
        }
        if let Some(base) = optional(args, "--base") {
            req.text("sha256", &hash(&load(&base)?));
        } else if let Some(sha) = optional(args, "--sha256") {
            req.text("sha256", &sha);
        }
        let response = checked(exchange(&socket, &req)?)?;
        let data = bytes(response.0, "content", LIMIT)?;
        let proposal = temporary(&data)?;
        let state = format!("{proposal}.alock");
        if let Err(e) = save(&state, &encode(&response)?, false) {
            unsafe {
                unlink(c(&proposal).as_ptr());
            }
            return Err(e);
        }
        println!(
            "{{\"ticket\":{},\"file\":{},\"sha256\":{}}}",
            quote(&text(response.0, "ticket", 48)?),
            quote(&proposal),
            quote(&text(response.0, "sha256", 64)?)
        );
        return Ok(());
    }
    if operation == "commit" {
        let proposal = option(args, "--file")?;
        let state = format!("{proposal}.alock");
        let meta = decode(&load(&state)?)?;
        let ticket = option(args, "--ticket")?;
        if text(meta.0, "ticket", 48)? != ticket {
            return err(400, "Ticket does not match proposal metadata");
        }
        let base = bytes(meta.0, "content", LIMIT)?;
        let edited = load(&proposal)?;
        let start = number(meta.0, "start") as usize;
        let length = number(meta.0, "length") as usize;
        if start > base.len() || length > base.len() - start {
            return err(400, "Invalid proposal metadata");
        }
        let suffix = base.len() - start - length;
        if edited.len() < start + suffix
            || edited[..start] != base[..start]
            || edited[edited.len() - suffix..] != base[start + length..]
        {
            return err(409, "Changes extend outside requested range");
        }
        req.text("ticket", &ticket);
        req.text("author", &option(args, "--author")?);
        req.bytes("replacement", &edited[start..edited.len() - suffix]);
        let response = checked(exchange(&socket, &req)?)?;
        save(&proposal, &bytes(response.0, "content", LIMIT)?, true)?;
        save(&state, &encode(&response)?, true)?;
        if let Ok(message) = text(response.0, "historyError", 4096) {
            if !message.is_empty() {
                return Err((500, message));
            }
        }
        println!("{{\"ok\":true}}");
        return Ok(());
    }
    if operation == "abort" || operation == "release" {
        req.text("ticket", &option(args, "--ticket")?);
    }
    checked(exchange(&socket, &req)?)?;
    println!("{{\"ok\":true}}");
    Ok(())
}
#[no_mangle]
pub extern "C" fn account_cli(argc: c_int, argv: *const *const c_char) -> c_int {
    let args: Vec<String> = (0..argc)
        .map(|i| {
            unsafe { CStr::from_ptr(*argv.add(i as usize)) }
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    match cli(&args) {
        Ok(()) => 0,
        Err((status, message)) => {
            if !message.is_empty() {
                eprintln!("alock: {message}");
            }
            match status {
                409 => 3,
                422 => 4,
                403 => 5,
                400 => 2,
                _ => 1,
            }
        }
    }
}

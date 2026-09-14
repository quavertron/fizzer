use super::*;
use crossterm::event::KeyEvent;
use ratatui::backend::TestBackend;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::{JoinHandle, JoinSet};

type Requests = Arc<Mutex<Vec<(String, Value)>>>;

struct MockServer {
    client: CascadeClient,
    requests: Requests,
    task: JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    async fn new(handler: impl Fn(&str, &Value) -> (u16, Value, Duration) + Send + Sync + 'static) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = CascadeClient::new(format!("http://{}", listener.local_addr().unwrap()), None);
        let requests: Requests = Arc::default();
        let received = requests.clone();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    connection = listener.accept() => {
                        let (mut socket, _) = connection.unwrap();
                        let received = received.clone();
                        let handler = handler.clone();
                        connections.spawn(async move {
                            let mut bytes = Vec::new();
                            let header_end = loop {
                                let mut buf = [0; 4096];
                                let n = socket.read(&mut buf).await.unwrap();
                                if n == 0 { return; }
                                bytes.extend_from_slice(&buf[..n]);
                                if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                                    break end + 4;
                                }
                            };
                            let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                            let length = headers.lines().find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                            }).unwrap_or(0);
                            while bytes.len() < header_end + length {
                                let mut buf = [0; 4096];
                                let n = socket.read(&mut buf).await.unwrap();
                                if n == 0 { return; }
                                bytes.extend_from_slice(&buf[..n]);
                            }
                            let request = headers.lines().next().unwrap().to_string();
                            let body = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap_or(Value::Null);
                            received.lock().unwrap().push((request.clone(), body.clone()));
                            let (status, body, delay) = handler(&request, &body);
                            tokio::time::sleep(delay).await;
                            let body = body.to_string();
                            let response = format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = socket.write_all(response.as_bytes()).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Self { client, requests, task }
    }

    fn app(&self) -> App {
        let mut app = App::new(self.client.clone());
        app.vault_id = Some("v".into());
        app.active_channel_id = Some("real-channel".into());
        app
    }
}

fn quit() -> io::Result<Event> {
    Ok(Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)))
}

fn render(app: &App, width: u16, height: u16) -> Terminal<TestBackend> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|f| ui::render(f, app)).unwrap();
    terminal
}

fn screen(terminal: &Terminal<TestBackend>) -> String {
    terminal.backend().buffer().content.iter().map(|cell| cell.symbol()).collect()
}

#[tokio::test]
async fn failed_send_preserves_draft_for_retry() {
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let server = MockServer::new(move |_, body| {
        if attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            (503, json!({"error": "simulated outage"}), Duration::ZERO)
        } else {
            (201, json!({"message": {"id": "sent", "author": "me", "body": body["body"]}}), Duration::ZERO)
        }
    }).await;
    let mut app = server.app();
    app.input = "  keep this\ndraft 界  ".into();
    app.cursor_pos = 5;
    app.input_scroll_offset = 1;
    let draft = app.input.clone();
    send_draft(&mut app).await;
    assert_eq!(app.input, draft);
    assert_eq!(app.cursor_pos, 5);
    assert_eq!(app.input_scroll_offset, 1);
    assert!(app.status_message.starts_with("Send error:"));
    send_draft(&mut app).await;
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_pos, 0);
    assert_eq!(app.input_scroll_offset, 0);
    assert_eq!(app.messages.len(), 1);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].1["body"], requests[1].1["body"]);
}

#[tokio::test]
async fn sending_without_a_channel_preserves_draft() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.input = "keep me".into();
    send_draft(&mut app).await;
    assert_eq!(app.input, "keep me");
    assert!(app.messages.is_empty());
}

#[tokio::test]
async fn multiline_paste_stays_in_composer() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.set_demo_data();
    let before = app.messages.len();
    let events = futures_util::stream::iter([Ok(Event::Paste("first\r\nsecond\rthird".into())), quit()]);
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    run_app(&mut terminal, &mut app, events).await.unwrap();
    assert_eq!(app.input, "first\nsecond\nthird");
    assert_eq!(app.messages.len(), before);
    assert_eq!(app.cursor_line_col(), (2, 5));
}

#[tokio::test]
async fn keyboard_and_quit_remain_responsive_during_slow_poll() {
    let started = Arc::new(tokio::sync::Notify::new());
    let notify = started.clone();
    let server = MockServer::new(move |_, _| {
        notify.notify_one();
        (200, json!({"messages": [], "agents": []}), Duration::from_secs(30))
    }).await;
    let mut app = server.app();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let events = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    let typing = async move {
        started.notified().await;
        tx.send(Ok(Event::Key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)))).unwrap();
        tx.send(quit()).unwrap();
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        let (result, ()) = tokio::join!(run_app(&mut terminal, &mut app, events), typing);
        result.unwrap();
    }).await.expect("Keyboard blocked behind network polling");
    assert_eq!(app.input, "x");
    assert!(app.should_quit);
}

#[tokio::test]
async fn refresh_replaces_demo_channel_and_handles_empty_vault() {
    let empty = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server_empty = empty.clone();
    let server = MockServer::new(move |request, _| {
        let body = if request.contains("/notes ") {
            if server_empty.load(std::sync::atomic::Ordering::SeqCst) { json!({"notes": []}) }
            else { json!({"notes": [{"id": "real-channel", "title": "real", "content_preview": "cascade://chat-channel"}]}) }
        } else if request.contains("/real-channel/messages?") {
            json!({"messages": [{"id": "real-message", "body": "live"}]})
        } else if request.contains("/real-channel/agents ") {
            json!({"agents": []})
        } else if request.contains("/api/vaults ") {
            json!({"vaults": [{"id": "v", "name": "Recovered vault"}]})
        } else { return (404, json!({}), Duration::ZERO); };
        (200, body, Duration::ZERO)
    }).await;
    let mut app = server.app();
    app.set_demo_data();
    refresh_channels_and_messages(&mut app).await;
    assert_eq!(app.active_channel_id.as_deref(), Some("real-channel"));
    assert!(!app.offline_mode);
    assert_ne!(app.vault_name, "Local Demo Vault");
    assert_eq!(app.messages[0].id, "real-message");
    assert!(app.agents.is_empty());
    assert!(!server.requests.lock().unwrap().iter().any(|(req, _)| req.contains("chan-general")));

    // Discovery can recover even if the initial vault listing was unavailable.
    app.set_demo_data();
    app.vault_id = None;
    refresh_channels_and_messages(&mut app).await;
    assert_eq!(app.vault_name, "Recovered vault");
    assert_eq!(app.active_channel_id.as_deref(), Some("real-channel"));

    empty.store(true, std::sync::atomic::Ordering::SeqCst);
    refresh_channels_and_messages(&mut app).await;
    assert!(app.active_channel_id.is_none());
    assert!(app.channels.is_empty());
    assert!(app.messages.is_empty());
    assert!(app.agents.is_empty());
}

#[test]
fn stale_channel_snapshot_is_ignored_and_empty_results_clear_lists() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.set_demo_data();
    app.offline_mode = false;
    app.vault_id = Some("v".into());
    ChannelSnapshot { vault_id: "v".into(), channel_id: "old-channel".into(), messages: Ok(vec![]), agents: Ok(vec![]) }.apply(&mut app);
    assert!(!app.messages.is_empty());
    ChannelSnapshot { vault_id: "v".into(), channel_id: "chan-general".into(), messages: Ok(vec![]), agents: Ok(vec![]) }.apply(&mut app);
    assert!(app.messages.is_empty());
    assert!(app.agents.is_empty());
}

#[test]
fn header_displays_status_and_error_text() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.status_message = "Send error: UNIQUE_FAILURE".into();
    assert!(screen(&render(&app, 120, 40)).contains("Send error: UNIQUE_FAILURE"));
}

#[test]
fn long_draft_and_cursor_stay_visible_after_resize_and_navigation() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    for text in [format!("{}DRAFT_END", "x".repeat(100)), format!("{}DRAFT_END", "界".repeat(100))] {
        app.input = text;
        app.move_cursor_end();
        for width in [120, 80] {
            let mut terminal = render(&app, width, 40);
            assert!(screen(&terminal).contains("DRAFT_END"));
            let cursor = terminal.backend_mut().get_cursor_position().unwrap();
            assert_eq!(cursor.x, if width >= ui::MIN_WIDTH_FOR_AGENTS { width - 30 } else { width - 2 });
        }
        app.move_cursor_home();
        let mut terminal = render(&app, 120, 40);
        assert_eq!(terminal.backend_mut().get_cursor_position().unwrap().x, 29);
    }
}

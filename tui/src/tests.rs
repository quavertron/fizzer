use super::*;
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

async fn finish_send(app: &mut App) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    send_draft(app, &tx);
    let result = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    apply_backend_event(app, result, &tx);
}

#[tokio::test]
async fn failed_send_preserves_draft_and_images_for_retry() {
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
    app.pending_images = vec!["data:image/png;base64,test".into()];
    app.cursor_pos = 5;
    app.input_scroll_offset = 1;
    let draft = app.input.clone();
    finish_send(&mut app).await;
    assert_eq!(app.input, draft);
    assert_eq!(app.pending_images.len(), 1);
    assert_eq!(app.cursor_pos, 5);
    assert_eq!(app.input_scroll_offset, 1);
    assert!(app.status_message.starts_with("Send error:"));
    finish_send(&mut app).await;
    assert!(app.input.is_empty());
    assert!(app.pending_images.is_empty());
    assert_eq!(app.cursor_pos, 0);
    assert_eq!(app.messages.len(), 1);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].1["body"], requests[1].1["body"]);
    assert_eq!(requests[0].1["images"], requests[1].1["images"]);
}

#[tokio::test]
async fn sending_without_a_channel_preserves_draft() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.input = "keep me".into();
    let (tx, _) = mpsc::unbounded_channel();
    send_draft(&mut app, &tx);
    assert_eq!(app.input, "keep me");
    assert!(!app.send_in_flight);
}

#[tokio::test]
async fn sending_is_nonblocking_and_does_not_erase_new_edits() {
    let server = MockServer::new(|_, _| (201, json!({"message": {"id": "sent"}}), Duration::from_millis(50))).await;
    let mut app = server.app();
    app.input = "sent text".into();
    let (tx, mut rx) = mpsc::unbounded_channel();
    send_draft(&mut app, &tx);
    send_draft(&mut app, &tx);
    assert!(app.send_in_flight);
    app.input.push_str(" plus new typing");
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    apply_backend_event(&mut app, event, &tx);
    assert_eq!(app.input, "sent text plus new typing");
    assert!(!app.send_in_flight);
    assert_eq!(server.requests.lock().unwrap().iter().filter(|(r, _)| r.starts_with("POST")).count(), 1);
}

#[test]
fn stale_channel_results_are_ignored_and_empty_results_clear_lists() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.active_channel_id = Some("current".into());
    app.messages = vec![serde_json::from_value(json!({"id":"m"})).unwrap()];
    let (tx, _) = mpsc::unbounded_channel();
    apply_backend_event(&mut app, BackendEvent::Messages { channel_id: "old".into(), messages: vec![] }, &tx);
    assert_eq!(app.messages.len(), 1);
    apply_backend_event(&mut app, BackendEvent::Messages { channel_id: "current".into(), messages: vec![] }, &tx);
    assert!(app.messages.is_empty());
}

#[test]
fn render_handles_small_terminals_and_unicode_drafts() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.input = "界🙂test".repeat(50);
    app.move_cursor_end();
    for (width, height) in [(1, 1), (20, 5), (80, 24), (120, 40)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| ui::render(f, &app)).unwrap();
    }
}

#[test]
fn channel_refresh_reselects_removed_channel_and_clears_empty_vault() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.active_channel_id = Some("removed".into());
    app.messages = vec![serde_json::from_value(json!({"id":"m"})).unwrap()];
    apply_channels(&mut app, vec![ChannelItem { id: "new".into(), title: "New".into() }]);
    assert_eq!(app.active_channel_id.as_deref(), Some("new"));
    assert!(app.messages.is_empty());
    apply_channels(&mut app, vec![]);
    assert!(app.active_channel_id.is_none());
    assert!(app.channels.is_empty());
}

#[test]
fn old_vault_results_cannot_replace_current_lists() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.vault_id = Some("current".into());
    app.channels = vec![ChannelItem { id: "channel".into(), title: "Current".into() }];
    app.notes = vec![serde_json::from_value(json!({"id":"note", "title":"Keep"})).unwrap()];
    let (tx, _) = mpsc::unbounded_channel();
    apply_backend_event(&mut app, BackendEvent::Channels { vault_id: "old".into(), result: Ok(vec![]) }, &tx);
    apply_backend_event(&mut app, BackendEvent::Notes { vault_id: "old".into(), result: Ok(vec![]) }, &tx);
    apply_backend_event(&mut app, BackendEvent::ChannelCreated { vault_id: "old".into(), result: Ok(ChannelItem { id: "wrong".into(), title: "Wrong".into() }) }, &tx);
    assert_eq!(app.channels.len(), 1);
    assert_eq!(app.channels[0].id, "channel");
    assert_eq!(app.notes.len(), 1);
}

#[test]
fn rename_updates_channel_by_id_after_reordering() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.channels = vec![ChannelItem { id: "b".into(), title: "B".into() }, ChannelItem { id: "a".into(), title: "A".into() }];
    let (tx, _) = mpsc::unbounded_channel();
    apply_backend_event(&mut app, BackendEvent::ChannelRenamed { result: Ok(ChannelItem { id: "a".into(), title: "Renamed".into() }) }, &tx);
    assert_eq!(app.channels[0].title, "B");
    assert_eq!(app.channels[1].title, "Renamed");
}

#[test]
fn saved_agent_updates_by_id_without_closing_another_modal() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
    app.active_channel_id = Some("c".into());
    let agent_a: AgentItem = serde_json::from_value(json!({"id":"a","displayName":"A"})).unwrap();
    let agent_b: AgentItem = serde_json::from_value(json!({"id":"b","displayName":"B"})).unwrap();
    app.agents = vec![agent_b, agent_a.clone()];
    app.open_agent_settings();
    let mut saved = agent_a;
    saved.display_name = "Updated A".into();
    let (tx, _) = mpsc::unbounded_channel();
    apply_backend_event(&mut app, BackendEvent::AgentSaved { channel_id: "c".into(), agent_id: "a".into(), display_name: "Updated A".into(), mention: "a".into(), is_new: false, result: Ok(saved) }, &tx);
    assert_eq!(app.agents[0].display_name, "B");
    assert_eq!(app.agents[1].display_name, "Updated A");
    assert_eq!(app.agent_settings_modal.as_ref().unwrap().agent.id, "b");
}

use super::*;
use ratatui::backend::TestBackend;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::{JoinHandle, JoinSet};

type Requests = Arc<Mutex<Vec<(String, Value)>>>;

#[test]
fn remote_origins_default_to_https_and_reject_public_plaintext() {
    assert_eq!(normalize_remote_origin("example.com:8443").unwrap(), "https://example.com:8443");
    assert_eq!(normalize_remote_origin("127.0.0.1:3000").unwrap(), "http://127.0.0.1:3000");
    assert_eq!(normalize_remote_origin("192.168.1.20:4000").unwrap(), "http://192.168.1.20:4000");
    assert!(normalize_remote_origin("http://example.com").is_err());
    assert!(normalize_remote_origin("https://user:pass@example.com").is_err());
}

#[test]
fn selecting_a_cloned_vault_on_another_server_clears_previous_workspace() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:3000".into(), None));
    app.vault_id = Some("clone".into());
    app.active_channel_id = Some("old-channel".into());
    app.vaults = vec![serde_json::from_value(json!({"id":"clone", "name":"Remote clone", "origin":"http://127.0.0.1:4000"})).unwrap()];
    assert!(app.activate_selected_vault());
    assert_eq!(app.client.base_url, "http://127.0.0.1:4000");
    assert_eq!(app.active_channel_id, None);
}

#[test]
fn identity_follows_selected_server_and_rejects_late_previous_session() {
    let mut app = App::new(CascadeClient::new("http://127.0.0.1:3000".into(), None));
    app.client = CascadeClient::new("https://remote.example".into(), None);
    let (tx, _) = tokio::sync::mpsc::unbounded_channel();
    apply_backend_event(&mut app, BackendEvent::Session { origin: "https://remote.example".into(), result: Ok(Some(("remote-user".into(), "ABCDEF".into()))) }, &tx);
    apply_backend_event(&mut app, BackendEvent::Session { origin: "http://127.0.0.1:3000".into(), result: Ok(Some(("local-user".into(), "123456".into()))) }, &tx);
    assert_eq!(app.author, "remote-user");
    apply_backend_event(&mut app, BackendEvent::Session { origin: "https://remote.example".into(), result: Ok(None) }, &tx);
    assert!(app.author.is_empty());
    assert!(app.show_vaults);
    assert_eq!(app.active_pane, ActivePane::Vaults);
}

#[tokio::test]
async fn local_backend_discovery_requires_a_healthy_loopback_service() {
    let server = MockServer::new(|request, _| {
        assert!(request.starts_with("GET /api/health "));
        (200, json!({"status":"ok"}), Duration::ZERO)
    }).await;
    let path = std::env::temp_dir().join(format!("fizzer-discovery-{}.json", std::process::id()));
    fs::write(&path, json!({"origin": server.client.base_url}).to_string()).unwrap();
    assert_eq!(discover_local_backend(&path).await, Some(server.client.base_url.clone()));
    for origin in ["https://cscd.online", "http://127.0.0.1:1", "http://127.0.0.1:3000/other"] {
        fs::write(&path, json!({"origin":origin}).to_string()).unwrap();
        assert_eq!(discover_local_backend(&path).await, None);
    }
    fs::write(&path, "broken metadata").unwrap();
    assert_eq!(discover_local_backend(&path).await, None);
    fs::remove_file(&path).unwrap();
    assert_eq!(discover_local_backend(&path).await, None);
}

fn empty_history(channel_id: &str) -> BackendEvent {
    BackendEvent::HistoryPage { channel_id: channel_id.into(), before: None,
        result: Ok(api::MessagesResponse { messages: vec![], before_seq: None, has_more: false }) }
}

#[tokio::test]
async fn history_pages_load_on_demand_and_survive_refresh() {
    let server = MockServer::new(|request, _| {
        let body = if request.contains("beforeSeq=30") {
            assert!(request.contains("limit=20"));
            json!({"messages":[{"id":"old"},{"id":"recent"}],"beforeSeq":10,"hasMore":false})
        } else if request.contains("/messages?") {
            assert!(request.contains("limit=8"));
            json!({"messages":[{"id":"recent"}],"beforeSeq":30,"hasMore":true})
        } else { json!([]) };
        (200, body, Duration::from_millis(10))
    }).await;
    let mut app = server.app();
    let (tx, mut rx) = mpsc::unbounded_channel();
    spawn_channel_sync(&mut app, &tx);
    while app.receiving_messages.is_some() {
        apply_backend_event(&mut app, rx.recv().await.unwrap(), &tx);
    }
    assert_eq!(app.messages.len(), 1);
    assert!(app.history_has_more);
    assert!(!server.requests.lock().unwrap().iter().any(|(r, _)| r.contains("beforeSeq")));
    spawn_older_messages(&mut app, &tx);
    spawn_older_messages(&mut app, &tx); // Do not duplicate an in-flight request.
    while app.history_loading {
        apply_backend_event(&mut app, rx.recv().await.unwrap(), &tx);
    }
    assert_eq!(app.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["old", "recent"]);
    assert!(!app.history_has_more);
    assert_eq!(server.requests.lock().unwrap().iter().filter(|(r, _)| r.contains("beforeSeq")).count(), 1);
    spawn_channel_sync(&mut app, &tx);
    while app.receiving_messages.is_some() {
        apply_backend_event(&mut app, rx.recv().await.unwrap(), &tx);
    }
    assert_eq!(app.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["old", "recent"]);
    assert_eq!(app.history_before, Some(10));
    apply_backend_event(&mut app, BackendEvent::HistoryPage {
        channel_id: "previous-channel".into(), before: None,
        result: Ok(api::MessagesResponse { messages: vec![], before_seq: None, has_more: false }),
    }, &tx);
    assert_eq!(app.messages.len(), 2);
}

#[test]
fn vault_dialog_paste_targets_selected_field() {
    let mut action = VaultActionState::ConnectRemote {
        origin: String::new(), username: String::new(), password: String::new(),
        field: VaultActionField::NameOrOrigin,
    };
    action.paste("https://cscd.online/vault-invite/example?x=1&y=2\r\n");
    if let VaultActionState::ConnectRemote { field, .. } = &mut action {
        *field = VaultActionField::Username;
    }
    action.paste("diégo");
    if let VaultActionState::ConnectRemote { field, .. } = &mut action {
        *field = VaultActionField::Password;
    }
    action.paste("p@ss word");
    if let VaultActionState::ConnectRemote { origin, username, password, .. } = action {
        assert_eq!(origin, "https://cscd.online/vault-invite/example?x=1&y=2");
        assert_eq!(username, "diégo");
        assert_eq!(password, "p@ss word");
    }
    let mut local = VaultActionState::CreateLocal { name: "My ".into() };
    local.paste("Vault\n");
    assert_eq!(local.active_input(), "My Vault");
}

#[tokio::test]
#[ignore = "requires the configured running backend"]
async fn startup_timing() {
    let saved = load_tui_state();
    let client = CascadeClient::new(configured_instance_url(&saved), resolve_token());
    let vault = saved.vault_id.unwrap();
    let start = std::time::Instant::now();
    let channels = client.fetch_channels(&vault).await.unwrap();
    eprintln!("channels: {:?}", start.elapsed());
    let mut app = App::new(client);
    apply_channels(&mut app, channels);
    let start = std::time::Instant::now();
    app.messages = app.client.fetch_messages(&vault, app.active_channel_id.as_ref().unwrap()).await.unwrap();
    eprintln!("messages: {:?}", start.elapsed());
    let start = std::time::Instant::now();
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    terminal.draw(|frame| ui::render(frame, &app)).unwrap();
    eprintln!("first render: {:?}", start.elapsed());
}

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
async fn vault_history_load_keeps_terminal_responsive() {
    let server = MockServer::new(|request, _| {
        if request.contains("/messages?") {
            (200, json!({"messages":[{"id":"history"}]}), Duration::from_millis(200))
        } else if request.contains("/notes ") {
            (200, json!({"notes":[{"id":"real-channel","title":"Chat","content_preview":"cascade://chat-channel"}]}), Duration::ZERO)
        } else {
            (200, json!([]), Duration::ZERO)
        }
    }).await;
    let mut app = server.app();
    let (tx, mut rx) = mpsc::unbounded_channel();
    spawn_refresh_channels(&mut app, &tx);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !server.requests.lock().unwrap().iter().any(|(r, _)| r.contains("/messages?")) {
            tokio::select! {
                Some(event) = rx.recv() => apply_backend_event(&mut app, event, &tx),
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }
    }).await.unwrap();
    // History is still pending, but editing and drawing can run immediately.
    assert!(app.messages.is_empty());
    app.input = "typing while loading".into();
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal.draw(|frame| ui::render(frame, &app)).unwrap();
    assert!(app.chat_cache.read().unwrap().chat_text.contains("Receiving messages…"));
    assert!(!app.chat_cache.read().unwrap().chat_text.contains("No messages"));
    tokio::time::timeout(Duration::from_secs(2), async {
        while app.messages.is_empty() {
            apply_backend_event(&mut app, rx.recv().await.unwrap(), &tx);
        }
    }).await.unwrap();
    assert_eq!(app.messages[0].id, "history");
    assert_eq!(app.input, "typing while loading");
    apply_backend_event(&mut app, empty_history("real-channel"), &tx);
    terminal.draw(|frame| ui::render(frame, &app)).unwrap();
    assert!(app.chat_cache.read().unwrap().chat_text.contains("No messages"));
    apply_backend_event(&mut app, BackendEvent::HistoryPage { channel_id: "real-channel".into(), before: None, result: Err("offline".into()) }, &tx);
    terminal.draw(|frame| ui::render(frame, &app)).unwrap();
    assert!(app.chat_cache.read().unwrap().chat_text.contains("Could not receive messages: offline"));
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
    apply_backend_event(&mut app, empty_history("old"), &tx);
    assert_eq!(app.messages.len(), 1);
    apply_backend_event(&mut app, empty_history("current"), &tx);
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

//! Local history discovery is shared with Electron; only selected history goes to the server.
use crossterm::event::KeyCode;
use ratatui::{layout::{Constraint, Layout}, style::{Color, Style}, widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap}, Frame};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use crate::{api::{CascadeClient, ChannelItem}, app::App, storage_bin, BackendEvent};

#[derive(Deserialize)]
pub struct LocalSession { pub id: String, pub title: String, pub cwd: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList { pub sessions: Vec<LocalSession>, pub next_offset: Option<usize> }

#[derive(Default)]
pub struct Picker {
    pub sessions: Vec<LocalSession>,
    pub selected: usize,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub busy: bool,
    pub error: String,
}

async fn local(method: &str, options: Value) -> Result<Value, String> {
    let sub = match method {
        "listCodexSessions" => "list",
        "readCodexSession" => "read",
        _ => return Err(format!("Unknown Codex session method: {method}")),
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(15),
        tokio::process::Command::new(storage_bin::binary()).arg("codex-sessions").arg(sub).arg(options.to_string())
            .kill_on_drop(true).output()).await.map_err(|_| "Local Codex history read timed out".to_string())?
        .map_err(|e| format!("Cannot read local Codex sessions: {e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

fn load(app: &mut App, tx: &mpsc::UnboundedSender<BackendEvent>, offset: usize) {
    let picker = app.codex_import.get_or_insert_with(Picker::default);
    picker.busy = true;
    picker.offset = offset;
    picker.error.clear();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = match local("listCodexSessions", json!({"offset": offset})).await {
            Ok(value) => serde_json::from_value(value).map_err(|e| e.to_string()),
            Err(error) => Err(error),
        };
        let _ = tx.send(BackendEvent::CodexList(result));
    });
}

async fn import(client: CascadeClient, vault_id: &str, id: &str) -> Result<ChannelItem, String> {
    let mut offset = 0;
    let mut snapshot_end = None;
    loop {
        let mut options = json!({"id": id, "offset": offset});
        if let Some(end) = snapshot_end { options["snapshotEnd"] = json!(end); }
        let page = local("readCodexSession", options).await?;
        snapshot_end = page["snapshotEnd"].as_u64();
        let response = client.import_codex_page(vault_id, &page).await?;
        let imported = &response["imported"];
        if imported["paused"] == true { return Err("A run is already queued in Fizzer. Wait for it to finish before importing again.".into()); }
        if imported["following"] == false || page["hasMore"] != true {
            return Ok(ChannelItem {
                id: imported["channelId"].as_str().ok_or("Missing imported channel")?.into(),
                title: imported["title"].as_str().unwrap_or("Codex session").into(),
            });
        }
        let next = page["nextOffset"].as_u64().ok_or("Missing history cursor")?;
        if next <= offset { return Err("Codex history cursor did not advance".into()); }
        offset = next;
    }
}

pub fn open(app: &mut App, tx: &mpsc::UnboundedSender<BackendEvent>) {
    if app.vault_id.is_none() || app.show_vaults {
        app.status_message = "Open a vault before importing a local Codex session.".into();
    } else { load(app, tx, 0); }
}

pub fn key(app: &mut App, code: KeyCode, tx: &mpsc::UnboundedSender<BackendEvent>) -> bool {
    if app.codex_import.is_none() { return false; }
    let picker = app.codex_import.as_mut().unwrap();
    if picker.busy { return true; }
    match code {
        KeyCode::Esc => app.codex_import = None,
        KeyCode::Up => picker.selected = picker.selected.saturating_sub(1),
        KeyCode::Down => picker.selected = (picker.selected + 1).min(picker.sessions.len().saturating_sub(1)),
        KeyCode::Char('n') => { if let Some(offset) = picker.next_offset { load(app, tx, offset); } }
        KeyCode::Char('p') => { let offset = picker.offset.saturating_sub(50); load(app, tx, offset); }
        KeyCode::Enter => {
            if let (Some(session), Some(vault_id)) = (picker.sessions.get(picker.selected), app.vault_id.clone()) {
                let id = session.id.clone();
                picker.busy = true;
                picker.error.clear();
                let client = app.client.clone();
                let origin = client.base_url.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let result = import(client, &vault_id, &id).await;
                    let _ = tx.send(BackendEvent::CodexImported { origin, vault_id, result });
                });
            }
        }
        _ => {}
    }
    true
}

pub fn render(frame: &mut Frame, app: &App, picker: &Picker, area: ratatui::layout::Rect) {
    frame.render_widget(Clear, area);
    let block = Block::default().title(" Import local Codex session ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let chunks = Layout::vertical([Constraint::Length(5), Constraint::Min(1), Constraint::Length(3)]).split(inner);
    frame.render_widget(Paragraph::new(format!("Copy history into {} ({}). Other vault members can read it.\nContinue in Fizzer after any turn still running elsewhere finishes.\n↑↓ select · Enter import and open · n/p pages · Esc close", app.vault_name, app.client.base_url)).wrap(Wrap { trim: true }), chunks[0]);
    let items: Vec<_> = picker.sessions.iter().map(|s| ListItem::new(format!("{}\n  {}", s.title, s.cwd))).collect();
    let mut state = ListState::default().with_selected(Some(picker.selected));
    frame.render_stateful_widget(List::new(items).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("> "), chunks[1], &mut state);
    let status = if picker.busy { "Loading / importing history…" } else if !picker.error.is_empty() { &picker.error } else if picker.sessions.is_empty() { "No local Codex sessions found." } else { "" };
    frame.render_widget(Paragraph::new(status).wrap(Wrap { trim: true }), chunks[2]);
}

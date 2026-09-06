mod api;
mod app;
mod ui;

use std::io::{self, stdout};
use std::time::Duration;

use color_eyre::Result;
use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEventKind,
        KeyModifiers, KeyboardEnhancementFlags, MouseButton, MouseEventKind,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::Terminal;

use tokio::sync::mpsc;

use crate::api::{AgentItem, CascadeClient, ChannelItem, ChatMessage};
use crate::app::{ActivePane, AgentSettingsField, App};

/// Results from background network tasks, folded back into `App` on the event loop.
enum BackendEvent {
    Messages { channel_id: String, messages: Vec<ChatMessage> },
    Agents { channel_id: String, agents: Vec<AgentItem> },
    Channels(Result<Vec<ChannelItem>, String>),
    /// Whether the backend responded to a lightweight health ping.
    Connectivity(bool),
    /// Whether the desktop runner daemon is running locally.
    RunnerStatus(bool),
    ChannelCreated(Result<ChannelItem, String>),
    SendResult { channel_id: String, result: Result<ChatMessage, String> },
    AgentSaved {
        agent_idx: usize,
        agent_id: String,
        display_name: String,
        mention: String,
        result: Result<AgentItem, String>,
    },
}

/// Spawn a fetch of the active channel's messages + agents. Never blocks the loop.
fn spawn_channel_sync(app: &App, tx: &mpsc::UnboundedSender<BackendEvent>) {
    let (Some(vault_id), Some(channel_id)) = (app.vault_id.clone(), app.active_channel_id.clone())
    else {
        return;
    };
    let client = app.client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        if let Ok(messages) = client.fetch_messages(&vault_id, &channel_id).await {
            let _ = tx.send(BackendEvent::Messages { channel_id: channel_id.clone(), messages });
        }
        if let Ok(agents) = client.fetch_agents(&vault_id, &channel_id).await {
            let _ = tx.send(BackendEvent::Agents { channel_id, agents });
        }
    });
}

/// Spawn a message send; the result comes back as a `BackendEvent`.
fn spawn_send_message(app: &App, text: String, images: Vec<String>, tx: &mpsc::UnboundedSender<BackendEvent>) {
    let (Some(vault_id), Some(channel_id)) = (app.vault_id.clone(), app.active_channel_id.clone())
    else {
        return;
    };
    let client = app.client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = client.send_message(&vault_id, &channel_id, &text, &images).await;
        let _ = tx.send(BackendEvent::SendResult { channel_id, result });
    });
}

/// Read an image from the system clipboard and return it as a PNG base64 data URL.
/// Returns `Err` with a short reason when the clipboard holds no image.
fn clipboard_image_data_url() -> Result<String, String> {
    use base64::Engine;
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = clipboard.get_image().map_err(|_| "no image in clipboard".to_string())?;
    let width = img.width as u32;
    let height = img.height as u32;
    let mut png: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Spawn a lightweight backend health ping (GET /api/session). Drives the
/// connectivity badge without depending on an active channel.
fn spawn_health_check(app: &App, tx: &mpsc::UnboundedSender<BackendEvent>) {
    let client = app.client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let reachable = client.check_session().await.is_ok();
        let _ = tx.send(BackendEvent::Connectivity(reachable));
    });
}

/// Best-effort local check: is the desktop runner daemon (the process that
/// answers @mentions) alive on this machine? Only meaningful when the runner is
/// co-located with the TUI; a remote runner will always read as "no runner".
fn spawn_runner_check(tx: &mpsc::UnboundedSender<BackendEvent>) {
    let tx = tx.clone();
    tokio::spawn(async move {
        let running = tokio::process::Command::new("pgrep")
            .args(["-f", "desktop-runner-daemon"])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);
        let _ = tx.send(BackendEvent::RunnerStatus(running));
    });
}

/// Spawn creation of a new chat channel; the result comes back as a `BackendEvent`.
fn spawn_create_channel(app: &App, title: String, tx: &mpsc::UnboundedSender<BackendEvent>) {
    let Some(vault_id) = app.vault_id.clone() else {
        return;
    };
    let client = app.client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = client.create_channel(&vault_id, &title).await;
        let _ = tx.send(BackendEvent::ChannelCreated(result));
    });
}

/// Spawn a channel-list refresh (used while the UI is live; startup uses the blocking path).
fn spawn_refresh_channels(app: &mut App, tx: &mpsc::UnboundedSender<BackendEvent>) {
    let Some(vault_id) = app.vault_id.clone() else {
        return;
    };
    app.is_loading = true;
    app.status_message = "Refreshing channels...".to_string();
    let client = app.client.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = client.fetch_channels(&vault_id).await;
        let _ = tx.send(BackendEvent::Channels(result));
    });
}

/// Fold a completed background result into `App`. Stale results (channel switched
/// while in flight) are ignored via the `channel_id` guard.
fn apply_backend_event(app: &mut App, event: BackendEvent, tx: &mpsc::UnboundedSender<BackendEvent>) {
    match event {
        BackendEvent::Messages { channel_id, messages } => {
            if app.active_channel_id.as_deref() == Some(channel_id.as_str())
                && (!messages.is_empty() || app.messages.is_empty())
            {
                app.messages = messages;
            }
        }
        BackendEvent::Agents { channel_id, agents } => {
            if app.active_channel_id.as_deref() == Some(channel_id.as_str())
                && (!agents.is_empty() || app.agents.is_empty())
            {
                app.agents = agents;
            }
        }
        BackendEvent::Connectivity(reachable) => {
            app.backend_online = reachable;
        }
        BackendEvent::RunnerStatus(running) => {
            app.runner_online = running;
        }
        BackendEvent::ChannelCreated(result) => match result {
            Ok(channel) => {
                app.backend_online = true;
                app.channels.push(channel.clone());
                app.selected_channel_idx = app.channels.len().saturating_sub(1);
                app.active_channel_id = Some(channel.id.clone());
                app.scroll_offset = 0;
                app.messages.clear();
                app.agents.clear();
                app.status_message = format!("Created #{}", channel.title);
                spawn_channel_sync(app, tx);
            }
            Err(err) => {
                app.status_message = format!("Create channel error: {}", err);
            }
        },
        BackendEvent::Channels(result) => {
            app.is_loading = false;
            match result {
                Ok(channels) if !channels.is_empty() => {
                    app.backend_online = true;
                    app.channels = channels;
                    if app.active_channel_id.is_none() {
                        app.active_channel_id = Some(app.channels[0].id.clone());
                    }
                    app.status_message =
                        format!("Connected ({} channels loaded)", app.channels.len());
                    spawn_channel_sync(app, tx);
                }
                Ok(_) => {
                    app.status_message = "Vault has no chat channels yet.".to_string();
                }
                Err(err) => {
                    app.mark_offline(format!("Backend unreachable: {}", err));
                }
            }
        }
        BackendEvent::SendResult { channel_id, result } => match result {
            Ok(new_msg) => {
                if app.active_channel_id.as_deref() == Some(channel_id.as_str()) {
                    app.messages.push(new_msg);
                }
                app.status_message = "Message sent".to_string();
                spawn_channel_sync(app, tx);
            }
            Err(err) => {
                app.status_message = format!("Send error: {}", err);
            }
        },
        BackendEvent::AgentSaved { agent_idx, agent_id, display_name, mention, result } => {
            match result {
                Ok(saved_agent) => {
                    if let Some(agent) = app.agents.get_mut(agent_idx) {
                        *agent = saved_agent;
                    } else if let Some(agent) = app.agents.iter_mut().find(|a| a.id == agent_id) {
                        *agent = saved_agent;
                    }
                    app.status_message =
                        format!("Updated settings for {} (@{})", display_name, mention);
                    app.close_agent_settings();
                }
                Err(err) => {
                    if let Some(ref mut modal) = app.agent_settings_modal {
                        modal.error_message = Some(format!("Failed to save: {}", err));
                    }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;

    let base_url = std::env::var("CASCADE_URL")
        .or_else(|_| std::env::var("CASCADE_NOTE_URL"))
        .unwrap_or_else(|_| "http://localhost:3000".to_string());

    let token = resolve_token();
    let explicit_vault = std::env::var("CASCADE_NOTE_VAULT").ok();

    let client = CascadeClient::new(base_url.clone(), token);
    let mut app = App::new(client);

    // Initial backend discovery
    app.status_message = format!("Connecting to {}...", base_url);

    // Verify session identity with Elixir backend
    if let Ok(Some(username)) = app.client.check_session().await {
        app.author = username;
    }

    if let Some(vault_id) = explicit_vault {
        app.vault_id = Some(vault_id.clone());
        refresh_channels_and_messages(&mut app).await;
    } else {
        match app.client.fetch_vaults().await {
            Ok(vaults) if !vaults.is_empty() => {
                let first = &vaults[0];
                app.vault_id = Some(first.id.clone());
                app.vault_name = if first.name.is_empty() {
                    first.id.clone()
                } else {
                    first.name.clone()
                };
                refresh_channels_and_messages(&mut app).await;
            }
            Ok(_) => {
                app.status_message = "No vaults found on server.".to_string();
            }
            Err(err) => {
                app.mark_offline(format!("Backend unreachable: {}", err));
            }
        }
    }


    // Terminal initialization
    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    )?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let app_result = run_app(&mut terminal, &mut app).await;

    // Terminal restoration
    disable_raw_mode()?;
    let _ = execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags);
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;

    if let Err(err) = app_result {
        eprintln!("Application error: {:#}", err);
    }

    Ok(())
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> Result<()> {
    let mut event_stream = EventStream::new();
    let mut poll_interval = tokio::time::interval(Duration::from_secs(3));
    let (tx, mut rx) = mpsc::unbounded_channel::<BackendEvent>();

    loop {
        terminal.draw(|frame| ui::render(frame, app))?;

        if app.should_quit {
            break;
        }

        tokio::select! {
            // Background task results, folded in without ever blocking the loop.
            Some(event) = rx.recv() => {
                apply_backend_event(app, event, &tx);
            }

            // Periodic background sync (fire-and-forget so the UI stays responsive)
            _ = poll_interval.tick() => {
                spawn_health_check(app, &tx);
                spawn_runner_check(&tx);
                spawn_channel_sync(app, &tx);
            }

            // Keyboard and terminal events
            Some(Ok(event)) = event_stream.next() => {
                let term_height = terminal.size().map(|s| s.height).unwrap_or(24);
                let is_input_tall = app.is_input_tall(term_height);

                match event {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        // Global quit bindings
                        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                            app.should_quit = true;
                            continue;
                        }

                        // Modal key handling (if Agent Settings Modal is open)
                        if app.agent_settings_modal.is_some() {
                            if key.code == KeyCode::Esc {
                                if let Some(ref mut modal) = app.agent_settings_modal {
                                    if modal.editing_custom_model {
                                        modal.editing_custom_model = false;
                                        modal.sync_model_from_choice();
                                    } else {
                                        app.close_agent_settings();
                                    }
                                }
                                continue;
                            }

                            if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL) {
                                save_agent_settings(app, &tx);
                                continue;
                            }

                            // If user is editing custom model text input
                            let is_editing_custom = app.agent_settings_modal.as_ref().map(|m| m.editing_custom_model).unwrap_or(false);
                            if is_editing_custom {
                                if let Some(ref mut modal) = app.agent_settings_modal {
                                    match key.code {
                                        KeyCode::Enter => {
                                            modal.editing_custom_model = false;
                                            modal.sync_model_from_choice();
                                        }
                                        KeyCode::Backspace => {
                                            modal.custom_model_input.pop();
                                            modal.sync_model_from_choice();
                                        }
                                        KeyCode::Char(c) => {
                                            modal.custom_model_input.push(c);
                                            modal.sync_model_from_choice();
                                        }
                                        _ => {}
                                    }
                                }
                                continue;
                            }

                            let mut should_save = false;
                            let mut should_close = false;

                            if let Some(ref mut modal) = app.agent_settings_modal {
                                match key.code {
                                    KeyCode::Up | KeyCode::Char('k') => modal.prev_field(),
                                    KeyCode::Down | KeyCode::Char('j') => modal.next_field(),
                                    KeyCode::Left | KeyCode::Char('h') => {
                                        if modal.selected_field == AgentSettingsField::Model {
                                            modal.cycle_model(false);
                                        } else if modal.selected_field == AgentSettingsField::ReasoningEffort {
                                            modal.cycle_reasoning(false);
                                        } else if modal.selected_field == AgentSettingsField::Cancel {
                                            modal.selected_field = AgentSettingsField::Save;
                                        }
                                    }
                                    KeyCode::Right | KeyCode::Char('l') => {
                                        if modal.selected_field == AgentSettingsField::Model {
                                            modal.cycle_model(true);
                                        } else if modal.selected_field == AgentSettingsField::ReasoningEffort {
                                            modal.cycle_reasoning(true);
                                        } else if modal.selected_field == AgentSettingsField::Save {
                                            modal.selected_field = AgentSettingsField::Cancel;
                                        }
                                    }
                                    KeyCode::Char(' ') => {
                                        if modal.selected_field == AgentSettingsField::Model {
                                            modal.cycle_model(true);
                                        } else {
                                            match modal.toggle_or_action() {
                                                Some(true) => should_save = true,
                                                Some(false) => should_close = true,
                                                None => {}
                                            }
                                        }
                                    }
                                    KeyCode::Enter => {
                                        if modal.selected_field == AgentSettingsField::Model {
                                            if modal.is_custom_selected() {
                                                modal.editing_custom_model = true;
                                            } else {
                                                modal.cycle_model(true);
                                            }
                                        } else {
                                            match modal.toggle_or_action() {
                                                Some(true) => should_save = true,
                                                Some(false) => should_close = true,
                                                None => {}
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }

                            if should_save {
                                save_agent_settings(app, &tx);
                            } else if should_close {
                                app.close_agent_settings();
                            }
                            continue;
                        }

                        // New-channel name entry captures typing before pane logic.
                        if app.new_channel_name.is_some() {
                            match key.code {
                                KeyCode::Esc => {
                                    app.new_channel_name = None;
                                    app.status_message = "Cancelled new channel".into();
                                }
                                KeyCode::Enter => {
                                    let title = app
                                        .new_channel_name
                                        .take()
                                        .unwrap_or_default()
                                        .trim()
                                        .to_string();
                                    if title.is_empty() {
                                        app.status_message = "Channel name empty; cancelled".into();
                                    } else if app.vault_id.is_some() {
                                        app.status_message = format!("Creating #{}...", title);
                                        spawn_create_channel(app, title, &tx);
                                    } else {
                                        app.status_message = "No vault; cannot create channel".into();
                                    }
                                }
                                KeyCode::Backspace => {
                                    if let Some(name) = app.new_channel_name.as_mut() {
                                        name.pop();
                                    }
                                }
                                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                                    if let Some(name) = app.new_channel_name.as_mut() {
                                        name.push(c);
                                    }
                                }
                                _ => {}
                            }
                            if let Some(name) = &app.new_channel_name {
                                app.status_message =
                                    format!("New channel (Enter to create, Esc to cancel): {}", name);
                            }
                            continue;
                        }

                        if key.code == KeyCode::Esc {
                            app.should_quit = true;
                            continue;
                        }

                        // Panel toggle shortcuts: F1 or Ctrl+B for Channels (when not typing), F2 or Ctrl+G for Agents
                        if key.code == KeyCode::F(1) || (key.code == KeyCode::Char('b') && key.modifiers.contains(KeyModifiers::CONTROL) && app.active_pane != ActivePane::ChatInput) {
                            app.toggle_channels();
                            continue;
                        }
                        if key.code == KeyCode::F(2) || (key.code == KeyCode::Char('g') && key.modifiers.contains(KeyModifiers::CONTROL)) {
                            app.toggle_agents();
                            continue;
                        }

                        // Input composer height toggle (F3, Alt+E, or Ctrl+E when not typing) and adjustment (Ctrl/Alt+Up/Down)
                        if key.code == KeyCode::F(3)
                            || (key.code == KeyCode::Char('e') && key.modifiers.contains(KeyModifiers::ALT))
                            || (key.code == KeyCode::Char('e') && key.modifiers.contains(KeyModifiers::CONTROL) && app.active_pane != ActivePane::ChatInput)
                        {
                            app.toggle_input_expand(term_height);
                            continue;
                        }
                        if (key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT)) && key.code == KeyCode::Up {
                            app.grow_input_height(term_height);
                            continue;
                        }
                        if (key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT)) && key.code == KeyCode::Down {
                            app.shrink_input_height();
                            continue;
                        }

                        // Pane switching
                        if key.code == KeyCode::Tab {
                            let is_wide = terminal.size().map(|s| s.width >= ui::MIN_WIDTH_FOR_AGENTS).unwrap_or(true);
                            app.switch_pane(is_wide);
                            continue;
                        }

                        // Typing redirection for ChatMessages:
                        // Scrolling/refresh stays in ChatMessages.
                        // Any typing or text navigation key seamlessly switches to ChatInput
                        // and immediately falls through to execute in the message bar!
                        if app.active_pane == ActivePane::ChatMessages {
                            match key.code {
                                KeyCode::Up => {
                                    app.scroll_up();
                                    continue;
                                }
                                KeyCode::Down => {
                                    app.scroll_down();
                                    continue;
                                }
                                KeyCode::PageUp => {
                                    app.scroll_offset = app.scroll_offset.saturating_add(5);
                                    continue;
                                }
                                KeyCode::PageDown => {
                                    app.scroll_offset = app.scroll_offset.saturating_sub(5);
                                    continue;
                                }
                                KeyCode::F(5) | KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                    spawn_refresh_channels(app, &tx);
                                    continue;
                                }
                                _ => {
                                    app.active_pane = ActivePane::ChatInput;
                                }
                            }
                        }

                        match app.active_pane {
                            ActivePane::ChatSelector => {
                                match key.code {
                                    KeyCode::Up | KeyCode::Char('k') => app.prev_channel(),
                                    KeyCode::Down | KeyCode::Char('j') => app.next_channel(),
                                    KeyCode::Enter => {
                                        app.activate_selected_channel();
                                        app.messages.clear();
                                        app.agents.clear();
                                        spawn_channel_sync(app, &tx);
                                    }
                                    KeyCode::Char('r') => {
                                        spawn_refresh_channels(app, &tx);
                                    }
                                    KeyCode::Char('n') => {
                                        app.new_channel_name = Some(String::new());
                                        app.status_message =
                                            "New channel (Enter to create, Esc to cancel): ".into();
                                    }
                                    _ => {}
                                }
                            }
                            ActivePane::ChatMessages => {}
                            ActivePane::Agents => {
                                match key.code {
                                    KeyCode::Up | KeyCode::Char('k') => app.prev_agent(),
                                    KeyCode::Down | KeyCode::Char('j') => app.next_agent(),
                                    KeyCode::Enter => {
                                        app.insert_agent_mention();
                                    }
                                    KeyCode::Char('s') => {
                                        app.open_agent_settings();
                                    }
                                    _ => {}
                                }
                            }
                            ActivePane::ChatInput => {
                                match key.code {
                                    KeyCode::Up => {
                                        if is_input_tall {
                                            app.move_cursor_up_line();
                                        } else {
                                            app.scroll_up();
                                        }
                                    }
                                    KeyCode::Down => {
                                        if is_input_tall {
                                            app.move_cursor_down_line();
                                        } else {
                                            app.scroll_down();
                                        }
                                    }
                                    KeyCode::PageUp => {
                                        if is_input_tall {
                                            app.input_scroll_up();
                                        } else {
                                            app.scroll_offset = app.scroll_offset.saturating_add(5);
                                        }
                                    }
                                    KeyCode::PageDown => {
                                        if is_input_tall {
                                            app.input_scroll_down();
                                        } else {
                                            app.scroll_offset = app.scroll_offset.saturating_sub(5);
                                        }
                                    }
                                    KeyCode::Enter => {
                                        if key.modifiers.contains(KeyModifiers::SHIFT)
                                            || key.modifiers.contains(KeyModifiers::ALT)
                                            || key.modifiers.contains(KeyModifiers::CONTROL)
                                        {
                                            app.insert_char('\n');
                                        } else if app.input.ends_with('\\') {
                                            app.backspace();
                                            app.insert_char('\n');
                                        } else {
                                            let text = app.input.trim().to_string();
                                            if !text.is_empty() || !app.pending_images.is_empty() {
                                                if app.vault_id.is_some() && app.active_channel_id.is_some() {
                                                    let images = std::mem::take(&mut app.pending_images);
                                                    app.status_message = "Sending message...".into();
                                                    spawn_send_message(app, text, images, &tx);
                                                } else {
                                                    app.status_message = "No channel selected.".into();
                                                }
                                                app.input.clear();
                                                app.cursor_pos = 0;
                                                app.input_scroll_offset = 0;
                                                app.scroll_offset = 0;
                                            }
                                        }
                                    }
                                    KeyCode::Char('\n') | KeyCode::Char('\r') => {
                                        app.insert_char('\n');
                                    }
                                    KeyCode::Char('j') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.insert_char('\n');
                                    }
                                    KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.move_cursor_home();
                                    }
                                    KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.move_cursor_end();
                                    }
                                    KeyCode::Char('f') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.move_cursor_right();
                                    }
                                    KeyCode::Char('b') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.move_cursor_left();
                                    }
                                    KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        if is_input_tall {
                                            app.move_cursor_up_line();
                                        } else {
                                            app.scroll_up();
                                        }
                                    }
                                    KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        if is_input_tall {
                                            app.move_cursor_down_line();
                                        } else {
                                            app.scroll_down();
                                        }
                                    }
                                    KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.delete();
                                    }
                                    KeyCode::Char('h') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.backspace();
                                    }
                                    KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.clear_line();
                                    }
                                    KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.delete_word();
                                    }
                                    KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        app.clear_to_end_of_line();
                                    }
                                    KeyCode::Char('v') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                        match clipboard_image_data_url() {
                                            Ok(data_url) => {
                                                app.pending_images.push(data_url);
                                                app.status_message = format!(
                                                    "Attached image ({} pending)",
                                                    app.pending_images.len()
                                                );
                                            }
                                            Err(reason) => {
                                                app.status_message = format!("Paste: {}", reason);
                                            }
                                        }
                                    }
                                    KeyCode::Char(c) => app.insert_char(c),
                                    KeyCode::Backspace => {
                                        if key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT) {
                                            app.delete_word();
                                        } else if key.modifiers.contains(KeyModifiers::SUPER) {
                                            app.clear_line();
                                        } else {
                                            app.backspace();
                                        }
                                    }
                                    KeyCode::Delete => app.delete(),
                                    KeyCode::Left => app.move_cursor_left(),
                                    KeyCode::Right => app.move_cursor_right(),
                                    KeyCode::Home => app.move_cursor_home(),
                                    KeyCode::End => app.move_cursor_end(),
                                    _ => {}
                                }
                                let inner_h = app.input_box_height(term_height).saturating_sub(2) as usize;
                                app.ensure_cursor_visible(inner_h);
                            }
                        }
                    }
                    Event::Paste(ref text) => {
                        if let Some(ref mut modal) = app.agent_settings_modal {
                            if modal.editing_custom_model {
                                for c in text.chars() {
                                    if c != '\r' && c != '\n' {
                                        modal.custom_model_input.push(c);
                                    }
                                }
                                modal.sync_model_from_choice();
                                continue;
                            }
                        }
                        if app.active_pane == ActivePane::ChatInput || app.active_pane == ActivePane::ChatMessages {
                            app.active_pane = ActivePane::ChatInput;
                            for c in text.chars() {
                                if c != '\r' {
                                    app.insert_char(c);
                                }
                            }
                            let inner_h = app.input_box_height(term_height).saturating_sub(2) as usize;
                            app.ensure_cursor_visible(inner_h);
                        }
                    }
                    Event::Mouse(mouse) => {
                        let term_width = terminal.size().map(|s| s.width).unwrap_or(80);
                        if let Some(ref mut modal) = app.agent_settings_modal {
                            if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
                                let modal_area = ui::agent_modal_rect(Rect::new(0, 0, term_width, term_height));
                                if mouse.column >= modal_area.x
                                    && mouse.column < modal_area.x + modal_area.width
                                    && mouse.row >= modal_area.y
                                    && mouse.row < modal_area.y + modal_area.height
                                {
                                    let rel_row = (mouse.row - modal_area.y) as usize;
                                    let rel_col = mouse.column - modal_area.x;
                                    match modal.click_row(rel_row, rel_col) {
                                        Some(true) => {
                                            save_agent_settings(app, &tx);
                                        }
                                        Some(false) => {
                                            app.close_agent_settings();
                                        }
                                        None => {}
                                    }
                                } else {
                                    app.close_agent_settings();
                                }
                            }
                            continue;
                        }

                        let input_h = app.input_box_height(term_height);
                        let input_top_y = term_height.saturating_sub(input_h + 1);

                        let show_channels = app.show_channels;
                        let show_agents = app.show_agents && term_width >= ui::MIN_WIDTH_FOR_AGENTS;

                        let channels_width: u16 = match (show_channels, show_agents) {
                            (true, true) => 26,
                            (true, false) => 28,
                            _ => 0,
                        };

                        let agents_width: u16 = if show_agents { 28 } else { 0 };
                        let center_end_x = term_width.saturating_sub(agents_width);
                        let is_in_main_area = mouse.row < term_height.saturating_sub(1);

                        match mouse.kind {
                            MouseEventKind::Down(MouseButton::Left) => {
                                if is_in_main_area {
                                    if mouse.column < channels_width {
                                        app.active_pane = ActivePane::ChatSelector;
                                        if mouse.row >= 4 {
                                            let row_idx = (mouse.row - 4) as usize;
                                            if row_idx < app.channels.len() {
                                                app.selected_channel_idx = row_idx;
                                                if let Some(ch) = app.channels.get(row_idx) {
                                                    let ch_id = ch.id.clone();
                                                    let ch_title = ch.title.clone();
                                                    if app.active_channel_id.as_deref() != Some(&ch_id) {
                                                        app.active_channel_id = Some(ch_id.clone());
                                                        app.scroll_offset = 0;
                                                        app.status_message = format!("Switched to #{}", ch_title);
                                                        app.messages.clear();
                                                        app.agents.clear();
                                                        spawn_channel_sync(app, &tx);
                                                    }
                                                }
                                            }
                                        }
                                    } else if mouse.column >= center_end_x {
                                        app.active_pane = ActivePane::Agents;
                                        if mouse.row >= 4 {
                                            let agent_idx = ((mouse.row - 4) / 2) as usize;
                                            if agent_idx < app.agents.len() {
                                                app.selected_agent_idx = agent_idx;
                                            }
                                        }
                                    } else {
                                        // Center column: Chat Messages (History) or Message Input
                                        if mouse.row >= input_top_y {
                                            app.active_pane = ActivePane::ChatInput;
                                        } else {
                                            app.active_pane = ActivePane::ChatMessages;
                                        }
                                    }
                                }
                            }
                            MouseEventKind::ScrollUp => {
                                if mouse.column < channels_width {
                                    app.prev_channel();
                                } else if mouse.column >= center_end_x {
                                    app.prev_agent();
                                } else if mouse.row >= input_top_y {
                                    if is_input_tall {
                                        app.input_scroll_up();
                                    } else {
                                        app.scroll_up();
                                    }
                                } else {
                                    app.scroll_up();
                                }
                            }
                            MouseEventKind::ScrollDown => {
                                if mouse.column < channels_width {
                                    app.next_channel();
                                } else if mouse.column >= center_end_x {
                                    app.next_agent();
                                } else if mouse.row >= input_top_y {
                                    if is_input_tall {
                                        app.input_scroll_down();
                                    } else {
                                        app.scroll_down();
                                    }
                                } else {
                                    app.scroll_down();
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

async fn refresh_channels_and_messages(app: &mut App) {
    if let Some(vault_id) = &app.vault_id {
        app.is_loading = true;
        app.status_message = "Refreshing channels...".to_string();
        match app.client.fetch_channels(vault_id).await {
            Ok(channels) => {
                if !channels.is_empty() {
                    app.channels = channels;
                    if app.active_channel_id.is_none() {
                        app.active_channel_id = Some(app.channels[0].id.clone());
                    }
                    if let Some(channel_id) = &app.active_channel_id {
                        if let Ok(msgs) = app.client.fetch_messages(vault_id, channel_id).await {
                            app.messages = msgs;
                        }
                        if let Ok(agents) = app.client.fetch_agents(vault_id, channel_id).await {
                            app.agents = agents;
                        }
                    }
                    app.backend_online = true;
                    app.status_message = format!("Connected ({} channels loaded)", app.channels.len());
                } else {
                    app.status_message = "Vault has no chat channels yet.".to_string();
                }
            }
            Err(err) => {
                app.mark_offline(format!("Backend unreachable: {}", err));
            }
        }
        app.is_loading = false;
    }
}

fn save_agent_settings(app: &mut App, tx: &mpsc::UnboundedSender<BackendEvent>) {
    // Pull the data we need out of the modal, then drop the borrow so we can call
    // whole-`App` methods (close_agent_settings) below.
    let (agent_idx, agent_to_save) = {
        let Some(modal) = app.agent_settings_modal.as_mut() else {
            return;
        };
        if modal.editing_custom_model {
            modal.editing_custom_model = false;
            modal.sync_model_from_choice();
        }
        modal.error_message = None;
        (modal.agent_idx, modal.agent.clone())
    };
    let display_name = agent_to_save.display_name.clone();
    let mention = agent_to_save.mention.clone();

    let (Some(vault_id), Some(channel_id)) = (app.vault_id.clone(), app.active_channel_id.clone())
    else {
        if let Some(agent) = app.agents.get_mut(agent_idx) {
            *agent = agent_to_save;
        } else if let Some(agent) = app.agents.iter_mut().find(|a| a.id == agent_to_save.id) {
            *agent = agent_to_save;
        }
        app.status_message = format!("Settings saved for @{}", mention);
        app.close_agent_settings();
        return;
    };

    app.status_message = format!("Saving settings for @{}...", mention);
    let client = app.client.clone();
    let tx = tx.clone();
    let agent_id = agent_to_save.id.clone();
    tokio::spawn(async move {
        let result = client.update_agent(&vault_id, &channel_id, &agent_to_save).await;
        let _ = tx.send(BackendEvent::AgentSaved {
            agent_idx,
            agent_id,
            display_name,
            mention,
            result,
        });
    });
}

fn resolve_token() -> Option<String> {
    if let Ok(token) = std::env::var("CASCADE_NOTE_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(token) = std::env::var("CASCADE_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let token_path = std::path::Path::new(&home).join(".cascade").join("token");
        if let Ok(content) = std::fs::read_to_string(token_path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }

        let ctx_path = std::path::Path::new(&home).join(".cascade").join("agent-helper-context.json");
        if let Ok(content) = std::fs::read_to_string(ctx_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(t) = val.get("token").and_then(|t| t.as_str()) {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }

    None
}


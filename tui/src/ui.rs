use ratatui::layout::{Alignment, Constraint, Direction, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::symbols::{border, line};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthChar;

use crate::app::{
    parse_hex_color, ActivePane, AgentSettingsField, App, ChatRenderCache, HEADER_HEIGHT,
};

pub fn render(frame: &mut Frame, app: &App) {
    let size = frame.area();

    // Top-level vertical layout: Header, Main Area, Footer
    let vertical_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(HEADER_HEIGHT), // Header
            Constraint::Min(10),   // Main Area
            Constraint::Length(1), // Footer
        ])
        .split(size);

    if app.agent_settings_modal.is_some() {
        frame.render_widget(Clear, size);
        render_agent_settings_modal(frame, app);
        return;
    }

    render_header(frame, app, vertical_chunks[0]);
    render_main_area(frame, app, vertical_chunks[1]);
    render_footer(frame, app, vertical_chunks[2]);
}

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let mode_badge = if app.backend_online {
        Span::styled(" [LIVE] ", Style::default().fg(Color::Black).bg(Color::Green).bold())
    } else {
        Span::styled(" [BACKEND DOWN] ", Style::default().fg(Color::White).bg(Color::Red).bold())
    };

    let runner_badge = if app.runner_online {
        Span::styled(" [RUNNER] ", Style::default().fg(Color::Black).bg(Color::Cyan).bold())
    } else {
        Span::styled(" [NO RUNNER] ", Style::default().fg(Color::Black).bg(Color::Yellow).bold())
    };

    let loading_indicator = if app.is_loading {
        Span::styled(" [Syncing...] ", Style::default().fg(Color::Yellow).bold())
    } else {
        Span::raw("")
    };

    let title_line = Line::from(vec![
        Span::styled(" ◈ FIZZER TUI ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        mode_badge,
        Span::raw(" "),
        runner_badge,
        Span::raw(" "),
        Span::styled(format!("Vault: {} ", app.vault_name), Style::default().fg(Color::White)),
        Span::styled(format!("| User: @{}", app.author), Style::default().fg(Color::DarkGray)),
        loading_indicator,
    ]);

    // Borderless: a single line hanging at the top, saving the two border rows.
    let header_para = Paragraph::new(vec![title_line]);
    frame.render_widget(header_para, area);
}

pub const MIN_WIDTH_FOR_AGENTS: u16 = 100;

fn render_main_area(frame: &mut Frame, app: &App, area: Rect) {
    let show_channels = app.show_channels;
    let show_agents = app.show_agents && area.width >= MIN_WIDTH_FOR_AGENTS;
    let show_notes = app.show_notes;
    let show_vaults = app.show_vaults;
    let show_left_sidebar = show_channels || show_notes || show_vaults;

    if show_left_sidebar && show_agents {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(26), // Left: Chats / Notes
                Constraint::Min(35),    // Center: Chat Messages + Input
                Constraint::Length(28), // Right: Agents
            ])
            .split(area);

        render_left_sidebar(frame, app, chunks[0], show_channels, show_notes, show_vaults);
        render_chat_modality(frame, app, chunks[1]);
        render_agents_panel(frame, app, chunks[2]);
    } else if show_left_sidebar {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(28), // Left: Chats / Notes
                Constraint::Min(30),    // Center: Chat Messages + Input
            ])
            .split(area);

        render_left_sidebar(frame, app, chunks[0], show_channels, show_notes, show_vaults);
        render_chat_modality(frame, app, chunks[1]);
    } else if show_agents {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Min(30),    // Center: Chat Messages + Input
                Constraint::Length(28), // Right: Agents
            ])
            .split(area);

        render_chat_modality(frame, app, chunks[0]);
        render_agents_panel(frame, app, chunks[1]);
    } else {
        render_chat_modality(frame, app, area);
    }
}

fn render_left_sidebar(frame: &mut Frame, app: &App, area: Rect, show_channels: bool, show_notes: bool, show_vaults: bool) {
    let visible = [show_vaults, show_channels, show_notes].into_iter().filter(|visible| *visible).count();
    if visible > 1 {
        let constraints = match visible {
            2 => vec![Constraint::Percentage(50), Constraint::Percentage(50)],
            _ => vec![Constraint::Percentage(34), Constraint::Percentage(33), Constraint::Percentage(33)],
        };
        let chunks = Layout::default().direction(Direction::Vertical).constraints(constraints).split(area);
        let mut index = 0;
        if show_vaults {
            render_vaults_panel(frame, app, chunks[index]);
            index += 1;
        }
        if show_channels {
            render_chat_selector(frame, app, chunks[index]);
            index += 1;
        }
        if show_notes {
            render_notes_panel(frame, app, chunks[index]);
        }
    } else if show_vaults {
        render_vaults_panel(frame, app, area);
    } else if show_channels && show_notes {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(area);
        render_chat_selector(frame, app, chunks[0]);
        render_notes_panel(frame, app, chunks[1]);
    } else if show_notes {
        render_notes_panel(frame, app, area);
    } else {
        render_chat_selector(frame, app, area);
    }
}

fn render_vaults_panel(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::Vaults;
    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };
    let items: Vec<ListItem> = if app.vaults.is_empty() {
        vec![ListItem::new(Span::styled("  No vaults", Style::default().fg(Color::DarkGray)))]
    } else {
        app.vaults.iter().enumerate().map(|(idx, vault)| {
            let name = if vault.name.is_empty() { &vault.id } else { &vault.name };
            let selected = idx == app.selected_vault_idx;
            let active = app.vault_id.as_deref() == Some(vault.id.as_str());
            let marker = if active { "● " } else { "◇ " };
            let style = if selected && is_focused {
                Style::default().fg(Color::Black).bg(Color::Cyan).bold()
            } else if selected {
                Style::default().fg(Color::Cyan).bold()
            } else if active {
                Style::default().fg(Color::White).bold()
            } else {
                Style::default().fg(Color::Gray)
            };
            ListItem::new(format!("{}{}{}", if selected { "> " } else { "  " }, marker, name)).style(style)
        }).collect()
    };
    let title = Span::styled(" Vaults [F4] ", Style::default().fg(if is_focused { Color::Cyan } else { Color::White }).bold());
    let block = Block::default().borders(Borders::ALL).title(title).border_style(Style::default().fg(border_color));
    let mut state = ListState::default().with_selected((!app.vaults.is_empty()).then_some(app.selected_vault_idx));
    frame.render_stateful_widget(List::new(items).block(block), area, &mut state);
}

#[derive(Debug, Clone, serde::Deserialize)]
struct TermimationEntry {
    #[allow(dead_code)]
    name: String,
    animation: String,
    #[allow(dead_code)]
    #[serde(default)]
    classes: Vec<String>,
    /// Optional per-pattern frame length; falls back to `DEFAULT_FRAME_MS`.
    #[serde(default)]
    frame_milliseconds: Option<u64>,
}

/// A parsed spinner: its frames plus how long each frame is shown.
struct Termimation {
    frames: Vec<char>,
    frame_ms: u64,
}

/// Redraw cadence for the agents panel. Frame lengths are honored down to this
/// granularity; keep it a divisor of `DEFAULT_FRAME_MS`.
pub const ANIMATION_TICK_MS: u64 = 40;
/// Frame length used when a termimation has no `frame_milliseconds`.
const DEFAULT_FRAME_MS: u64 = 120;

#[cfg(debug_assertions)]
fn termimation_json() -> String {
    std::fs::read_to_string("tui/src/termimations.json")
        .or_else(|_| std::fs::read_to_string("src/termimations.json"))
        .unwrap_or_default()
}

#[cfg(not(debug_assertions))]
fn termimation_json() -> String {
    include_str!("termimations.json").to_string()
}

fn termimation_patterns() -> &'static [Termimation] {
    static PATTERNS: std::sync::OnceLock<Vec<Termimation>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        let parsed: Vec<TermimationEntry> = serde_json::from_str(&termimation_json())
            .unwrap_or_default();
        let list: Vec<Termimation> = parsed
            .into_iter()
            .map(|t| Termimation {
                frames: t.animation.chars().collect(),
                frame_ms: t.frame_milliseconds.unwrap_or(DEFAULT_FRAME_MS).max(1),
            })
            .filter(|t| !t.frames.is_empty())
            .collect();
        if list.is_empty() {
            vec![Termimation { frames: vec!['●'], frame_ms: DEFAULT_FRAME_MS }]
        } else {
            list
        }
    })
}

fn agent_termimation_ball(ag: &crate::api::AgentItem, tick: u64, run_seed: u64) -> String {
    let patterns = termimation_patterns();
    if patterns.is_empty() {
        return "● ".to_string();
    }
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    ag.id.hash(&mut hasher);
    let agent_hash = hasher.finish();

    // Stagger phase per agent so multiple active agents do not pulse synchronously
    let phase_offset = (agent_hash >> 16) as u64;
    let local_tick = tick.wrapping_add(phase_offset);

    // Pick one pattern per run (fixed by the run seed) and hold it for the whole
    // turn; only the frame within the pattern advances with the tick.
    let mut pattern_hasher = std::collections::hash_map::DefaultHasher::new();
    agent_hash.hash(&mut pattern_hasher);
    run_seed.hash(&mut pattern_hasher);
    let pattern_idx = (pattern_hasher.finish() as usize) % patterns.len();

    let pattern = &patterns[pattern_idx];
    // Advance the frame by elapsed real time divided by this pattern's frame
    // length, so `frame_milliseconds` sets how long each frame is shown.
    let elapsed_ms = local_tick.wrapping_mul(ANIMATION_TICK_MS);
    let frame = (elapsed_ms / pattern.frame_ms) as usize % pattern.frames.len();
    let ch = pattern.frames[frame];

    if ch.width().unwrap_or(1) <= 1 {
        format!("{ch} ")
    } else {
        format!("{ch}")
    }
}

fn render_agents_panel(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::Agents;
    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };

    let items: Vec<ListItem> = if app.agents.is_empty() {
        vec![ListItem::new(Span::styled("  No agents registered", Style::default().fg(Color::DarkGray)))]
    } else {
        app.agents
            .iter()
            .enumerate()
            .map(|(idx, ag)| {
                let is_selected = idx == app.selected_agent_idx;
                let prefix = if is_selected { "> " } else { "  " };

                let default_badge = match ag.agent_id.as_str() {
                    "claude-code" => Color::Magenta,
                    "codex" => Color::Cyan,
                    "pi" => Color::Blue,
                    _ => Color::Yellow,
                };
                let badge_color = resolve_color(ag.color.as_deref(), default_badge);

                let name_style = if is_selected && is_focused {
                    Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)
                } else if is_selected {
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
                };

                let is_active = app.is_agent_active(ag);
                let (ball_str, ball_style) = if is_active {
                    let ball = agent_termimation_ball(ag, app.animation_tick, app.agent_run_seed(ag));
                    (ball, Style::default().fg(badge_color).add_modifier(Modifier::BOLD))
                } else {
                    ("● ".to_string(), Style::default().fg(badge_color))
                };

                let top_line = Line::from(vec![
                    Span::raw(prefix),
                    Span::styled(ball_str, ball_style),
                    Span::styled(&ag.display_name, name_style),
                    Span::raw(" "),
                    Span::styled(format!("@{}", ag.mention), Style::default().fg(Color::DarkGray)),
                ]);

                let model_info = if !ag.model.is_empty() {
                    &ag.model
                } else {
                    &ag.agent_id
                };

                let sub_line = Line::from(vec![
                    Span::raw("    "),
                    Span::styled(model_info, Style::default().fg(Color::DarkGray)),
                ]);

                ListItem::new(vec![top_line, sub_line])
            })
            .collect()
    };

    let title_style = if is_focused {
        Style::default().fg(Color::Cyan).bold()
    } else {
        Style::default().fg(Color::White).bold()
    };

    let title = Span::styled(format!(" Agents ({}) ", app.agents.len()), title_style);

    let agents_block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(border_color));

    let list = List::new(items).block(agents_block);
    frame.render_widget(list, area);
}

fn render_notes_panel(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::Notes;
    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };
    let items: Vec<ListItem> = if app.notes.is_empty() {
        vec![ListItem::new(Span::styled("  No notes", Style::default().fg(Color::DarkGray)))]
    } else {
        app.notes
            .iter()
            .enumerate()
            .map(|(idx, note)| {
                let title = if note.title.is_empty() { "untitled" } else { &note.title };
                let title_style = if idx == app.selected_note_idx && is_focused {
                    Style::default().fg(Color::Black).bg(Color::Cyan).bold()
                } else if idx == app.selected_note_idx {
                    Style::default().fg(Color::Cyan).bold()
                } else {
                    Style::default().fg(Color::White).bold()
                };
                let preview = note.content_preview.lines().next().unwrap_or("").trim();
                ListItem::new(vec![
                    Line::from(vec![Span::raw(if idx == app.selected_note_idx { "> " } else { "  " }), Span::styled(title, title_style)]),
                    Line::from(vec![Span::raw("   "), Span::styled(preview, Style::default().fg(Color::DarkGray))]),
                ])
            })
            .collect()
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(format!(" Notes ({}) ", app.notes.len()), Style::default().fg(if is_focused { Color::Cyan } else { Color::White }).bold()))
        .border_style(Style::default().fg(border_color));
    // Notes occupy two terminal rows each. Stateful list rendering keeps the
    // selected note inside the viewport as the arrow keys move through it.
    let mut state = ListState::default().with_selected((!app.notes.is_empty()).then_some(app.selected_note_idx));
    frame.render_stateful_widget(List::new(items).block(block), area, &mut state);
}


fn render_chat_selector(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::ChatSelector;
    let editing_name = app.new_channel_name.is_some();
    let renaming = app.renaming_channel_idx.is_some();
    let border_color = if editing_name {
        Color::Green
    } else if is_focused {
        Color::Cyan
    } else {
        Color::DarkGray
    };

    let mut items: Vec<ListItem> = Vec::new();

    // Inline "new channel" input row, rendered right in the sidebar.
    if let Some(name) = &app.new_channel_name {
        let shown = if name.is_empty() {
            "＋ type a name…".to_string()
        } else {
            format!("＋ {}█", name)
        };
        items.push(
            ListItem::new(shown)
                .style(Style::default().fg(Color::Black).bg(Color::Green).add_modifier(Modifier::BOLD)),
        );
    }

    items.extend(app.channels.iter().enumerate().map(|(idx, ch)| {
        let is_selected = idx == app.selected_channel_idx;
        let is_active = app.active_channel_id.as_deref() == Some(&ch.id);

        let marker = if is_active { "● " } else { "# " };
        let prefix = if is_selected { "> " } else { "  " };

        let text = format!("{}{}{}", prefix, marker, ch.title);

        let style = if is_selected && is_focused && !editing_name {
            Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else if is_selected {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else if is_active {
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };

        ListItem::new(text).style(style)
    }));

    let title = if editing_name {
        let label = if renaming { " Rename channel " } else { " New channel " };
        Span::styled(format!("{} [Enter ✓  Esc ✗] ", label), Style::default().fg(Color::Green).bold())
    } else {
        Span::styled(
            " Chats / Channels ",
            Style::default().fg(if is_focused { Color::Cyan } else { Color::White }).bold(),
        )
    };

    let selector_block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(border_color));

    let list = List::new(items).block(selector_block);
    frame.render_widget(list, area);
}

fn render_chat_modality(frame: &mut Frame, app: &App, area: Rect) {
    let input_h = app.input_box_height_for_width(frame.area().height, area.width);

    // Vertical layout inside Chat Modality: Top = Messages, Bottom = Input Composer
    let vertical_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(5),          // Messages Stream
            Constraint::Length(input_h), // Input Composer
        ])
        .split(area);

    render_messages_stream(frame, app, vertical_chunks[0]);
    render_input_composer(frame, app, vertical_chunks[1]);
}

pub fn ensure_chat_cache(app: &App, body_wrap_width: usize) {
    let is_valid = {
        let cache = app.chat_cache.read().unwrap();
        cache.channel_id == app.active_channel_id
            && cache.message_count == app.messages.len()
            && cache.wrap_width == body_wrap_width
            && cache.author == app.author
            && cache.agent_count == app.agents.len()
            && cache.last_message_id == app.messages.last().map(|m| m.id.clone())
            && cache.last_message_body_len == app.messages.last().map(|m| m.body.len())
    };

    if is_valid {
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut line_offsets: Vec<(usize, usize)> = Vec::new();
    let mut chat_text = String::new();
    let mut current_char_offset = 0;

    let mut push_line = |line: Line<'static>, text_line: &str| {
        let char_count = text_line.chars().count();
        line_offsets.push((current_char_offset, char_count));
        if !lines.is_empty() {
            chat_text.push('\n');
        }
        chat_text.push_str(text_line);
        current_char_offset += char_count + 1;
        lines.push(line);
    };

    if app.messages.is_empty() {
        let msg = " No messages in this channel yet.";
        push_line(
            Line::from(Span::styled(
                msg.to_string(),
                Style::default().fg(Color::DarkGray).italic(),
            )),
            msg,
        );
    } else {
        let msg_count = app.messages.len();
        for (m_idx, msg) in app.messages.iter().enumerate() {
            // Consecutive messages from the same author/agent within the grouping
            // window fold together, just like the Electron frontend's chat batching.
            let continues_group = m_idx > 0
                && crate::api::continues_chat_group(&app.messages[m_idx - 1], msg);

            // Author formatting
            let is_agent = msg.agent_id.is_some()
                || msg.author.to_lowercase().contains("bot")
                || msg.author.to_lowercase().contains("agent")
                || msg.author == "Codex"
                || msg.author == "Pi";
            let is_self = msg.author == app.author;

            let author_color = if is_self {
                Color::Green
            } else if is_agent {
                let maybe_agent = app.agents.iter().find(|a| {
                    msg.agent_id.as_deref() == Some(&a.id)
                        || msg.agent_id.as_deref() == Some(&a.agent_id)
                        || a.mention.eq_ignore_ascii_case(&msg.author)
                        || a.display_name.eq_ignore_ascii_case(&msg.author)
                });
                if let Some(ag) = maybe_agent {
                    resolve_color(ag.color.as_deref(), Color::Cyan)
                } else {
                    Color::Cyan
                }
            } else if msg.author == "System" {
                Color::Magenta
            } else {
                Color::Yellow
            };

            if !continues_group {
                let ts = crate::api::format_timestamp(&msg.created_at);
                let author_line = Line::from(vec![
                    Span::styled("● ", Style::default().fg(author_color)),
                    Span::styled(msg.author.clone(), Style::default().fg(author_color).bold()),
                    Span::raw("  "),
                    Span::styled(ts.clone(), Style::default().fg(Color::DarkGray)),
                ]);
                let text_line = format!("● {}  {}", msg.author, ts);
                push_line(author_line, &text_line);
            }

            // A grouped continuation has no author line to mark its start, so its
            // first content row gets a colored `>` in the margin instead.
            let mut marker_pending = continues_group;

            // Message Body: word-wrapped so each Line is exactly 1 visual terminal row
            for body_line in msg.body.lines() {
                if body_line.trim().is_empty() {
                    push_line(Line::from(""), "");
                } else {
                    for wrapped_chunk in wrap_text(body_line, body_wrap_width) {
                        let (margin_str, margin_span) = if marker_pending {
                            marker_pending = false;
                            ("> ", Span::styled("> ", Style::default().fg(author_color)))
                        } else {
                            ("  ", Span::raw("  "))
                        };
                        let line = Line::from(vec![
                            margin_span,
                            Span::styled(wrapped_chunk.clone(), Style::default().fg(Color::White)),
                        ]);
                        let text_line = format!("{}{}", margin_str, wrapped_chunk);
                        push_line(line, &text_line);
                    }
                }
            }

            // Attached-image indicator (the list API strips heavy data-URLs but flags them)
            if msg.has_image() {
                let label = match msg.images.len() {
                    0 | 1 => " ▤ image ".to_string(),
                    n => format!(" ▤ {} images ", n),
                };
                let (margin_str, margin_span) = if marker_pending {
                    marker_pending = false;
                    ("> ", Span::styled("> ", Style::default().fg(author_color)))
                } else {
                    ("  ", Span::raw("  "))
                };
                let line = Line::from(vec![
                    margin_span,
                    Span::styled(label.clone(), Style::default().fg(Color::Black).bg(Color::Magenta).bold()),
                ]);
                let text_line = format!("{}{}", margin_str, label);
                push_line(line, &text_line);
            }
            let _ = marker_pending;

            // Grouped continuations sit flush against each other; only a fresh
            // group (or the stream's end) gets a blank line after it.
            let next_continues = m_idx + 1 < msg_count
                && crate::api::continues_chat_group(msg, &app.messages[m_idx + 1]);
            if m_idx + 1 < msg_count && !next_continues {
                push_line(Line::from(""), "");
            }
        }
    }

    let char_count = chat_text.chars().count();
    *app.chat_cache.write().unwrap() = ChatRenderCache {
        channel_id: app.active_channel_id.clone(),
        message_count: app.messages.len(),
        last_message_id: app.messages.last().map(|m| m.id.clone()),
        last_message_body_len: app.messages.last().map(|m| m.body.len()),
        wrap_width: body_wrap_width,
        author: app.author.clone(),
        agent_count: app.agents.len(),
        lines,
        line_offsets,
        chat_text,
        char_count,
    };
}

fn render_messages_stream(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::ChatMessages;
    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };

    let active_title = format!(" #{} ", app.active_channel_title());

    let inner_width = area.width.saturating_sub(2) as usize;
    let body_wrap_width = inner_width.saturating_sub(2).max(10);

    ensure_chat_cache(app, body_wrap_width);
    let cache = app.chat_cache.read().unwrap();

    let messages_block = Block::default()
        .borders(Borders::TOP | Borders::LEFT | Borders::RIGHT)
        .title(Span::styled(active_title, Style::default().fg(Color::Cyan).bold()))
        .border_style(Style::default().fg(border_color));

    let visible_lines = area.height.saturating_sub(1) as usize;
    let total_lines = cache.lines.len();

    // Auto-scroll to bottom if scroll_offset is 0, else apply offset
    let max_scroll = total_lines.saturating_sub(visible_lines);
    let mut scroll_y = max_scroll.saturating_sub(app.scroll_offset);

    // Keep the text cursor visible while moving through the flattened log.
    if is_focused && app.scroll_offset == 0 {
        if let Some(cursor) = app.chat_cursor {
            let (cursor_line, _) = chat_line_column_from_offsets(&cache.line_offsets, cursor);
            if cursor_line < scroll_y {
                scroll_y = cursor_line;
            } else if cursor_line >= scroll_y.saturating_add(visible_lines) {
                scroll_y = cursor_line.saturating_sub(visible_lines.saturating_sub(1));
            }
            scroll_y = scroll_y.min(max_scroll);
        }
    }

    let selection_bounds = app.chat_selection_bounds(&cache.chat_text);

    // Slice only the lines visible in the current viewport to avoid iterating,
    // formatting, and cloning thousands of offscreen lines every frame.
    let slice_end = (scroll_y + visible_lines).min(total_lines);
    let visible_slice: Vec<Line> = if scroll_y < total_lines {
        (scroll_y..slice_end)
            .map(|idx| {
                let mut line = cache.lines[idx].clone();
                if let Some((sel_start, sel_end)) = selection_bounds {
                    let (line_start, line_len) = cache.line_offsets[idx];
                    let line_end = line_start + line_len;
                    if sel_start < line_end && sel_end > line_start {
                        let start = sel_start.saturating_sub(line_start).min(line_len);
                        let end = sel_end.saturating_sub(line_start).min(line_len);
                        if start < end {
                            highlight_line_range(&mut line, start, end);
                        }
                    }
                }
                line
            })
            .collect()
    } else {
        Vec::new()
    };

    let paragraph = Paragraph::new(Text::from(visible_slice))
        .block(messages_block);

    frame.render_widget(paragraph, area);

    if is_focused {
        if let Some(cursor) = app.chat_cursor {
            let (cursor_line, cursor_column) = chat_line_column_from_offsets(&cache.line_offsets, cursor);
            if cursor_line >= scroll_y && cursor_line < scroll_y + visible_lines {
                let max_x = area.width.saturating_sub(2);
                let col_u16 = (cursor_column as u16).min(max_x.saturating_sub(1));
                frame.set_cursor_position(Position {
                    x: area.x + 1 + col_u16,
                    y: area.y + 1 + (cursor_line - scroll_y) as u16,
                });
            }
        }
    }
}

fn highlight_line_range(line: &mut Line, start: usize, end: usize) {
    let spans = std::mem::take(&mut line.spans);
    let mut next = Vec::new();
    let mut offset = 0;
    for span in spans {
        let chars: Vec<char> = span.content.chars().collect();
        let mut chunk = String::new();
        let mut selected = false;
        for (index, c) in chars.iter().enumerate() {
            let is_selected = start <= offset + index && offset + index < end;
            if is_selected != selected && !chunk.is_empty() {
                let style = if selected {
                    span.style
                        .bg(Color::Rgb(50, 50, 50))
                } else { span.style };
                next.push(Span::styled(std::mem::take(&mut chunk), style));
            }
            selected = is_selected;
            chunk.push(*c);
        }
        if !chunk.is_empty() {
            let style = if selected {
                span.style
                    .bg(Color::Rgb(50, 50, 50))
            } else { span.style };
            next.push(Span::styled(chunk, style));
        }
        offset += chars.len();
    }
    line.spans = next;
}

pub fn chat_line_column_from_offsets(line_offsets: &[(usize, usize)], offset: usize) -> (usize, usize) {
    if line_offsets.is_empty() {
        return (0, 0);
    }
    let idx = match line_offsets.binary_search_by(|&(start, len)| {
        if offset < start {
            std::cmp::Ordering::Greater
        } else if offset <= start + len {
            std::cmp::Ordering::Equal
        } else {
            std::cmp::Ordering::Less
        }
    }) {
        Ok(i) => i,
        Err(i) => i.saturating_sub(1).min(line_offsets.len() - 1),
    };
    let (start, len) = line_offsets[idx];
    (idx, offset.saturating_sub(start).min(len))
}

#[allow(dead_code)]
fn chat_line_column(text: &str, offset: usize) -> (usize, usize) {
    let mut line = 0;
    let mut column = 0;
    for (index, c) in text.chars().enumerate() {
        if index >= offset {
            break;
        }
        if c == '\n' {
            line += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    (line, column)
}

pub fn chat_log_text(app: &App, body_wrap_width: usize) -> String {
    ensure_chat_cache(app, body_wrap_width);
    app.chat_cache.read().unwrap().chat_text.clone()
}

fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let max_width = max_width.max(1);
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;

    for word in text.split_whitespace() {
        let w_len = word.chars().count();
        if cur.is_empty() {
            if w_len > max_width {
                let mut chunk = String::new();
                for c in word.chars() {
                    chunk.push(c);
                    if chunk.chars().count() >= max_width {
                        lines.push(chunk);
                        chunk = String::new();
                    }
                }
                if !chunk.is_empty() {
                    cur = chunk;
                    cur_len = cur.chars().count();
                }
            } else {
                cur.push_str(word);
                cur_len = w_len;
            }
        } else if cur_len + 1 + w_len <= max_width {
            cur.push(' ');
            cur.push_str(word);
            cur_len += 1 + w_len;
        } else {
            lines.push(cur);
            if w_len > max_width {
                let mut chunk = String::new();
                for c in word.chars() {
                    chunk.push(c);
                    if chunk.chars().count() >= max_width {
                        lines.push(chunk);
                        chunk = String::new();
                    }
                }
                cur = chunk;
                cur_len = cur.chars().count();
            } else {
                cur = word.to_string();
                cur_len = w_len;
            }
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.is_empty() {
        lines.push(text.to_string());
    }
    lines
}

fn render_input_composer(frame: &mut Frame, app: &App, area: Rect) {
    let is_focused = app.active_pane == ActivePane::ChatInput;
    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };

    let title = if app.pending_images.is_empty() {
        Span::styled(" Message ", Style::default().fg(if is_focused { Color::Cyan } else { Color::DarkGray }))
    } else {
        Span::styled(
            format!(" Message  [{} image{} attached] ", app.pending_images.len(), if app.pending_images.len() == 1 { "" } else { "s" }),
            Style::default().fg(Color::Yellow).bold(),
        )
    };

    // Top corners are T-junctions (├ ┤) so the divider connects into the message
    // pane's side walls, conjoining the two boxes.
    let joined = border::Set {
        top_left: line::NORMAL.vertical_right,
        top_right: line::NORMAL.vertical_left,
        ..border::PLAIN
    };

    let input_block = Block::default()
        .borders(Borders::ALL)
        .border_set(joined)
        .title(title)
        .border_style(Style::default().fg(border_color));

    let inner_height = area.height.saturating_sub(2) as usize;
    let text_width = area.width.saturating_sub(4).max(1) as usize;
    let (cursor_visual_line, cursor_column) = wrapped_cursor_position(&app.input, app.cursor_pos, text_width);
    let visual_line_count = app.visual_input_line_count(text_width);
    let max_input_scroll = visual_line_count.saturating_sub(inner_height);
    let mut input_scroll = app.input_scroll_offset.min(max_input_scroll);
    if cursor_visual_line < input_scroll {
        input_scroll = cursor_visual_line;
    } else if cursor_visual_line >= input_scroll.saturating_add(inner_height) {
        input_scroll = cursor_visual_line.saturating_sub(inner_height.saturating_sub(1));
    }

    let raw_lines: Vec<&str> = if app.input.is_empty() {
        vec![""]
    } else {
        app.input.split('\n').collect()
    };

    let mut rendered_lines: Vec<Line> = Vec::new();
    for line_text in &raw_lines {
        rendered_lines.push(Line::from(vec![
            Span::styled(*line_text, Style::default().fg(Color::White)),
        ]));
    }

    frame.render_widget(input_block, area);
    let inner = Rect::new(area.x + 1, area.y + 1, area.width.saturating_sub(2), area.height.saturating_sub(2));
    if inner.width >= 2 {
        let prefix = if app.input_scroll_offset == 0 { "> " } else { "  " };
        frame.render_widget(Paragraph::new(prefix).style(Style::default().fg(Color::Cyan).bold()), inner);
        let text_area = Rect::new(inner.x + 2, inner.y, inner.width - 2, inner.height);
        frame.render_widget(Paragraph::new(rendered_lines)
            .wrap(Wrap { trim: false })
            .scroll((input_scroll.min(u16::MAX as usize) as u16, 0)), text_area);
    }

    // Render blinking cursor if input is focused
    if is_focused && inner_height > 0 {
        if cursor_visual_line >= input_scroll && cursor_visual_line < input_scroll + inner_height {
            let row_in_box = (cursor_visual_line - input_scroll) as u16;
            let cursor_x = area.x + 3 + cursor_column as u16;
            let cursor_y = area.y + 1 + row_in_box;
            if cursor_x < area.x + area.width - 1 && cursor_y < area.y + area.height - 1 {
                frame.set_cursor_position(Position { x: cursor_x, y: cursor_y });
            }
        }
    }
}

fn wrapped_cursor_position(input: &str, cursor_pos: usize, width: usize) -> (usize, usize) {
    let width = width.max(1);
    let chars: Vec<char> = input.chars().collect();
    let cursor_pos = cursor_pos.min(chars.len());
    let mut line_start = 0;
    let mut visual_line = 0;

    for (idx, c) in chars.iter().enumerate() {
        if *c != '\n' {
            continue;
        }
        if cursor_pos <= idx {
            return (visual_line + wrapped_cursor_line(&chars[line_start..idx], cursor_pos - line_start, width).0,
                wrapped_cursor_line(&chars[line_start..idx], cursor_pos - line_start, width).1);
        }
        visual_line += wrapped_input_line_count(&chars[line_start..idx], width);
        line_start = idx + 1;
    }

    let (line, column) = wrapped_cursor_line(&chars[line_start..], cursor_pos.saturating_sub(line_start), width);
    (visual_line + line, column)
}

/// Match Paragraph::wrap(Wrap { trim: false }): complete words move to the
/// next row when they do not fit, while oversized words split at cell width.
fn wrapped_cursor_line(line: &[char], cursor_pos: usize, width: usize) -> (usize, usize) {
    let cursor_pos = cursor_pos.min(line.len());
    let mut visual_line = 0;
    let mut column = 0;
    let mut index = 0;

    while index < line.len() {
        if line[index].is_whitespace() {
            let char_width = line[index].width().unwrap_or(0);
            if char_width > 0 && column + char_width > width {
                visual_line += 1;
                column = 0;
            }
            if index >= cursor_pos {
                return (visual_line, column);
            }
            column += char_width;
            index += 1;
            continue;
        }

        let word_start = index;
        while index < line.len() && !line[index].is_whitespace() {
            index += 1;
        }
        let word_width: usize = line[word_start..index]
            .iter()
            .map(|c| c.width().unwrap_or(0))
            .sum();
        if column > 0 && column + word_width > width {
            visual_line += 1;
            column = 0;
        }

        for (offset, c) in line[word_start..index].iter().enumerate() {
            let char_width = c.width().unwrap_or(0);
            if char_width > 0 && column + char_width > width {
                visual_line += 1;
                column = 0;
            }
            if word_start + offset >= cursor_pos {
                return (visual_line, column);
            }
            column += char_width;
        }
    }

    if cursor_pos >= line.len() && column >= width {
        (visual_line + 1, 0)
    } else {
        (visual_line, column)
    }
}

fn wrapped_input_line_count(line: &[char], width: usize) -> usize {
    let end = wrapped_cursor_line(line, line.len(), width).0;
    end + 1
}

/// Expand `(key, label)` hint pairs into alternating badge/text spans.
fn hint_spans<'a>(pairs: &[(&'a str, &'a str)], badge: Style, text: Style) -> Vec<Span<'a>> {
    pairs
        .iter()
        .flat_map(|(key, label)| [Span::styled(*key, badge), Span::styled(*label, text)])
        .collect()
}

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let global_badge_style = Style::default().fg(Color::Black).bg(Color::Cyan).bold();
    let global_text_style = Style::default().fg(Color::White);
    let box_badge_style = Style::default().fg(Color::Black).bg(Color::Yellow).bold();
    let box_text_style = Style::default().fg(Color::Yellow);

    // Left side: Global controls (Cyan)
    let global_spans = hint_spans(
        &[
            ("[Tab]", " Pane "),
            ("[F1]", " Chats "),
            ("[F2]", " Agents "),
            ("[F3]", " Notes "),
            ("[F4]", " Vaults "),
            ("[Esc]", " Quit "),
        ],
        global_badge_style,
        global_text_style,
    );

    // Right side: Box-specific controls (Yellow)
    let box_hints: &[(&str, &str)] = match app.active_pane {
        ActivePane::ChatInput => &[
            ("[Alt+e]", " Expand "),
            ("[Enter]", " Send "),
            ("[Shift+Enter]", " Newline "),
        ],
        ActivePane::ChatSelector => &[
            ("[↑/↓]", " Select "),
            ("[Enter]", " Open "),
            ("[n]", " New "),
            ("[Shift+r]", " Rename "),
            ("[r]", " Refresh "),
        ],
        ActivePane::ChatMessages => &[
            ("[↑/↓]", " Scroll "),
            ("[Type]", " Message "),
        ],
        ActivePane::Agents => &[
            ("[↑/↓]", " Select "),
            ("[Enter]", " Mention "),
            ("[n]", " New "),
            ("[s]", " Settings "),
        ],
        ActivePane::Notes => &[
            ("[↑/↓]", " Select "),
        ],
        ActivePane::Vaults => &[
            ("[↑/↓]", " Select "),
            ("[Enter]", " Open "),
            ("[r]", " Refresh "),
        ],
    };
    let box_spans = hint_spans(box_hints, box_badge_style, box_text_style);

    let right_width: u16 = box_spans.iter().map(|s| s.content.chars().count() as u16).sum();

    let footer_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Min(10),
            Constraint::Length(right_width),
        ])
        .split(area);

    frame.render_widget(Paragraph::new(Line::from(global_spans)), footer_chunks[0]);
    frame.render_widget(
        Paragraph::new(Line::from(box_spans)).alignment(Alignment::Right),
        footer_chunks[1],
    );
}

pub fn supports_truecolor() -> bool {
    if let Ok(force) = std::env::var("FORCE_ANSI") {
        if force == "1" || force.eq_ignore_ascii_case("true") {
            return false;
        }
    }
    if let Ok(val) = std::env::var("COLORTERM") {
        let val = val.to_ascii_lowercase();
        if val == "truecolor" || val == "24bit" {
            return true;
        }
    }
    if let Ok(term) = std::env::var("TERM") {
        let term = term.to_ascii_lowercase();
        if term.contains("24bit") || term.contains("truecolor") || term.contains("direct") {
            return true;
        }
    }
    false
}

const ANSI_COLORS: &[(Color, u8, u8, u8)] = &[
    (Color::Black, 0, 0, 0),
    (Color::Red, 178, 34, 34),
    (Color::Green, 34, 139, 34),
    (Color::Yellow, 204, 153, 0),
    (Color::Blue, 30, 144, 255),
    (Color::Magenta, 186, 85, 211),
    (Color::Cyan, 0, 191, 255),
    (Color::Gray, 192, 192, 192),
    (Color::DarkGray, 105, 105, 105),
    (Color::LightRed, 255, 99, 71),
    (Color::LightGreen, 50, 205, 50),
    (Color::LightYellow, 255, 255, 0),
    (Color::LightBlue, 100, 149, 237),
    (Color::LightMagenta, 238, 130, 238),
    (Color::LightCyan, 127, 255, 212),
    (Color::White, 255, 255, 255),
];

pub fn closest_ansi_color(r: u8, g: u8, b: u8) -> Color {
    let mut best_color = Color::White;
    let mut min_dist = i64::MAX;

    for &(color, ar, ag, ab) in ANSI_COLORS {
        let dr = (r as i64) - (ar as i64);
        let dg = (g as i64) - (ag as i64);
        let db = (b as i64) - (ab as i64);
        let dist = dr * dr + dg * dg + db * db;
        if dist < min_dist {
            min_dist = dist;
            best_color = color;
        }
    }

    best_color
}

pub fn rgb_to_display_color(r: u8, g: u8, b: u8) -> Color {
    if supports_truecolor() {
        Color::Rgb(r, g, b)
    } else {
        closest_ansi_color(r, g, b)
    }
}

pub fn resolve_color(hex_str: Option<&str>, default_color: Color) -> Color {
    let Some(hex) = hex_str else {
        return default_color;
    };
    let Some((r, g, b)) = parse_hex_color(hex) else {
        return default_color;
    };
    rgb_to_display_color(r, g, b)
}

/// Renders a full-width slider whose track is a gradient across the channel's
/// entire range (other channels held at their current value) — the way
/// native color-picker RGB sliders preview each axis, not a flat single tint.
pub fn render_slider_line<'a>(
    label: &'static str,
    val: u16,
    max: u16,
    unit: &'static str,
    is_selected: bool,
    label_color: Color,
    total_width: usize,
    color_at: impl Fn(f64) -> (u8, u8, u8),
) -> Line<'a> {
    let prefix = format!("  {}: ", label);
    let suffix = format!(" {:>3}{} ", val, unit);
    let used = prefix.len() + suffix.len();
    let track_width = total_width.saturating_sub(used).max(10);

    let ratio = (val as f64 / max as f64).clamp(0.0, 1.0);
    let knob_pos = (ratio * (track_width.saturating_sub(1) as f64)).round() as usize;

    let label_style = if is_selected {
        Style::default().fg(Color::Black).bg(label_color).bold()
    } else {
        Style::default().fg(label_color).bold()
    };

    let suffix_style = if is_selected {
        Style::default().fg(Color::White).bold()
    } else {
        Style::default().fg(Color::Gray)
    };

    let mut spans: Vec<Span<'a>> = Vec::with_capacity(track_width + 2);
    spans.push(Span::styled(prefix, label_style));

    for i in 0..track_width {
        let t = if track_width <= 1 { 0.0 } else { i as f64 / (track_width - 1) as f64 };
        let (r, g, b) = color_at(t);
        let track_color = rgb_to_display_color(r, g, b);
        if i == knob_pos {
            spans.push(Span::styled("●", Style::default().fg(Color::White).bold()));
        } else {
            spans.push(Span::styled("▆", Style::default().fg(track_color)));
        }
    }

    spans.push(Span::styled(suffix, suffix_style));
    Line::from(spans)
}

pub fn agent_modal_rect(area: Rect) -> Rect {
    let width = 86.min(area.width.saturating_sub(4)).max(34);
    let height = 34.min(area.height.saturating_sub(2)).max(18);
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    Rect::new(x, y, width, height)
}

fn format_reasoning_effort(val: &str) -> &'static str {
    match val {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        _ => "Default (CLI)",
    }
}

fn render_agent_settings_modal(frame: &mut Frame, app: &App) {
    let Some(ref modal) = app.agent_settings_modal else {
        return;
    };

    let area = agent_modal_rect(frame.area());
    frame.render_widget(Clear, area);

    let title = format!(" Customize Agent: {} (@{}) ", modal.agent.display_name, modal.agent.mention);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(title, Style::default().fg(Color::Cyan).bold()))
        .border_style(Style::default().fg(Color::Cyan));

    let is_codex = modal.agent.agent_id == "codex";
    let is_claude = modal.agent.agent_id == "claude-code";

    let mut lines: Vec<Line> = Vec::new();

    // Summary line
    lines.push(Line::from(vec![
        Span::styled(" Agent Type: ", Style::default().fg(Color::DarkGray)),
        Span::styled(&modal.agent.agent_id, Style::default().fg(Color::White).bold()),
        Span::styled("   Vault: ", Style::default().fg(Color::DarkGray)),
        Span::styled(app.vault_name.as_str(), Style::default().fg(Color::White)),
    ]));
    lines.push(Line::from(""));

    // 1. Model field
    let model_sel = modal.selected_field == AgentSettingsField::Model;
    let model_style = if model_sel {
        Style::default().fg(Color::Black).bg(Color::Cyan).bold()
    } else {
        Style::default().fg(Color::White)
    };
    let (model_display, _) = modal.current_model_display();
    let model_text = format!(" < {} > ", model_display);
    let model_hint = if modal.editing_custom_model {
        "  (typing... Enter to confirm, Esc to cancel)"
    } else if modal.is_custom_selected() {
        "  (Space/Arrows to cycle, Enter to edit ID)"
    } else if model_sel {
        "  (Space/Arrows to cycle)"
    } else {
        ""
    };
    lines.push(Line::from(vec![
        Span::styled("  Model:             ", if model_sel { Style::default().fg(Color::Cyan).bold() } else { Style::default().fg(Color::Gray) }),
        Span::styled(model_text, model_style),
        Span::styled(model_hint, Style::default().fg(Color::Yellow)),
    ]));

    // 2. Reasoning effort (Codex & Claude Code)
    if is_codex || is_claude {
        let r_sel = modal.selected_field == AgentSettingsField::ReasoningEffort;
        let r_style = if r_sel {
            Style::default().fg(Color::Black).bg(Color::Cyan).bold()
        } else {
            Style::default().fg(Color::White)
        };
        let r_text = format!(" < {} > ", format_reasoning_effort(&modal.agent.reasoning_effort));
        lines.push(Line::from(vec![
            Span::styled("  Reasoning Effort:  ", if r_sel { Style::default().fg(Color::Cyan).bold() } else { Style::default().fg(Color::Gray) }),
            Span::styled(r_text, r_style),
            if r_sel {
                Span::styled("  (Space/Arrows to cycle)", Style::default().fg(Color::DarkGray))
            } else {
                Span::raw("")
            },
        ]));
    }

    // 3. Fast mode (Codex only)
    if is_codex {
        let f_sel = modal.selected_field == AgentSettingsField::PriorityServiceTier;
        let f_mark = if modal.agent.priority_service_tier { "[x]" } else { "[ ]" };
        lines.push(Line::from(vec![
            Span::styled(format!("  {} Fast mode ", f_mark), if f_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
            Span::styled(" (Codex priority processing tier)", Style::default().fg(Color::DarkGray)),
        ]));
    }

    // Color (RGB / HSV) Section
    lines.push(Line::from(Span::styled("  ── Color (RGB & HSV) ───────────────────────────────────", Style::default().fg(Color::DarkGray))));

    let hex_display = modal.agent.color.as_deref().unwrap_or("#FFFFFF");
    let swatch_color = resolve_color(Some(hex_display), Color::White);
    lines.push(Line::from(vec![
        Span::styled("  Preview: [", Style::default().fg(Color::DarkGray)),
        Span::styled("██████████", Style::default().fg(swatch_color)),
        Span::styled("] ", Style::default().fg(Color::DarkGray)),
        Span::styled(hex_display, Style::default().fg(Color::White).bold()),
        Span::styled(format!("  (R: {}, G: {}, B: {} | H: {}°, S: {}%, V: {}%)", modal.color_r, modal.color_g, modal.color_b, modal.color_h, modal.color_s, modal.color_v), Style::default().fg(Color::DarkGray)),
    ]));

    let inner_width = area.width.saturating_sub(2) as usize;
    let slider_width = inner_width.saturating_sub(1);

    // 6 Full-Width Sliders — each track is a gradient sweeping its own channel
    // end-to-end while the other channels stay pinned at their live value,
    // matching the native RGB color-picker style the sliders were modeled on.
    let (fixed_g, fixed_b) = (modal.color_g, modal.color_b);
    let r_sel = modal.selected_field == AgentSettingsField::ColorR;
    lines.push(render_slider_line("R", modal.color_r as u16, 255, "", r_sel, Color::LightRed, slider_width,
        move |t| (((t * 255.0).round() as i32).clamp(0, 255) as u8, fixed_g, fixed_b)));

    let (fixed_r, fixed_b) = (modal.color_r, modal.color_b);
    let g_sel = modal.selected_field == AgentSettingsField::ColorG;
    lines.push(render_slider_line("G", modal.color_g as u16, 255, "", g_sel, Color::LightGreen, slider_width,
        move |t| (fixed_r, ((t * 255.0).round() as i32).clamp(0, 255) as u8, fixed_b)));

    let (fixed_r, fixed_g) = (modal.color_r, modal.color_g);
    let b_sel = modal.selected_field == AgentSettingsField::ColorB;
    lines.push(render_slider_line("B", modal.color_b as u16, 255, "", b_sel, Color::LightBlue, slider_width,
        move |t| (fixed_r, fixed_g, ((t * 255.0).round() as i32).clamp(0, 255) as u8)));

    let (fixed_s, fixed_v) = (modal.color_s, modal.color_v);
    let h_sel = modal.selected_field == AgentSettingsField::ColorH;
    let h_label_color = {
        let (hr, hg, hb) = crate::app::hsv_to_rgb(modal.color_h, 100, 100);
        rgb_to_display_color(hr, hg, hb)
    };
    lines.push(render_slider_line("H", modal.color_h, 360, "°", h_sel, h_label_color, slider_width,
        move |t| crate::app::hsv_to_rgb(((t * 360.0).round() as i32).clamp(0, 360) as u16, fixed_s, fixed_v)));

    let (fixed_h, fixed_v2) = (modal.color_h, modal.color_v);
    let s_sel = modal.selected_field == AgentSettingsField::ColorS;
    lines.push(render_slider_line("S", modal.color_s as u16, 100, "%", s_sel, Color::LightCyan, slider_width,
        move |t| crate::app::hsv_to_rgb(fixed_h, ((t * 100.0).round() as i32).clamp(0, 100) as u8, fixed_v2)));

    let (fixed_h2, fixed_s2) = (modal.color_h, modal.color_s);
    let v_sel = modal.selected_field == AgentSettingsField::ColorV;
    lines.push(render_slider_line("V", modal.color_v as u16, 100, "%", v_sel, Color::White, slider_width,
        move |t| crate::app::hsv_to_rgb(fixed_h2, fixed_s2, ((t * 100.0).round() as i32).clamp(0, 100) as u8)));

    // Replies Section
    lines.push(Line::from(Span::styled("  ── Replies ─────────────────────────────────────────", Style::default().fg(Color::DarkGray))));

    // Orchestrator
    let o_sel = modal.selected_field == AgentSettingsField::Orchestrator;
    let o_mark = if modal.agent.orchestrator { "[x]" } else { "[ ]" };
    lines.push(Line::from(vec![
        Span::styled(format!("  {} Coordinate this channel ", o_mark), if o_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
        Span::styled(" (supervisor reads all messages)", Style::default().fg(Color::DarkGray)),
    ]));

    // Reply to every human message
    let rep_sel = modal.selected_field == AgentSettingsField::ReplyToEveryMessage;
    let rep_mark = if modal.agent.reply_to_every_message { "[x]" } else { "[ ]" };
    let rep_hint = if modal.agent.orchestrator {
        " (locked on while coordinating)"
    } else {
        " (otherwise only when @mentioned)"
    };
    lines.push(Line::from(vec![
        Span::styled(format!("  {} Reply to every human message ", rep_mark), if rep_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
        Span::styled(rep_hint, Style::default().fg(Color::DarkGray)),
    ]));

    // Mentions Section
    lines.push(Line::from(Span::styled("  ── Mentions ────────────────────────────────────────", Style::default().fg(Color::DarkGray))));

    // Other agents
    let tag_sel = modal.selected_field == AgentSettingsField::TaggableByAgents;
    let tag_mark = if modal.agent.taggable_by_agents { "[x]" } else { "[ ]" };
    lines.push(Line::from(vec![
        Span::styled(format!("  {} Other agents can @mention ", tag_mark), if tag_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
    ]));

    // Other people
    let ping_sel = modal.selected_field == AgentSettingsField::PingableByOthers;
    let ping_mark = if modal.agent.pingable_by_others { "[x]" } else { "[ ]" };
    lines.push(Line::from(vec![
        Span::styled(format!("  {} Other people in vault can @mention ", ping_mark), if ping_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
    ]));

    // Execution Section
    lines.push(Line::from(Span::styled("  ── Execution ───────────────────────────────────────", Style::default().fg(Color::DarkGray))));

    // Yolo
    let yolo_sel = modal.selected_field == AgentSettingsField::Yolo;
    let yolo_mark = if modal.agent.yolo { "[x]" } else { "[ ]" };
    lines.push(Line::from(vec![
        Span::styled(format!("  {} Full host access (yolo mode) ", yolo_mark), if yolo_sel { Style::default().fg(Color::Black).bg(Color::Cyan).bold() } else { Style::default().fg(Color::White) }),
        Span::styled(" (bypasses sandbox boundaries)", Style::default().fg(Color::DarkGray)),
    ]));

    lines.push(Line::from(""));

    // Buttons
    let save_sel = modal.selected_field == AgentSettingsField::Save;
    let cancel_sel = modal.selected_field == AgentSettingsField::Cancel;
    lines.push(Line::from(vec![
        Span::raw("    "),
        Span::styled(" [ Save Settings (Enter / Ctrl+S) ] ", if save_sel { Style::default().fg(Color::Black).bg(Color::Green).bold() } else { Style::default().fg(Color::Green) }),
        Span::raw("   "),
        Span::styled(" [ Cancel (Esc) ] ", if cancel_sel { Style::default().fg(Color::Black).bg(Color::Red).bold() } else { Style::default().fg(Color::Gray) }),
    ]));

    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("  Controls: ", Style::default().fg(Color::DarkGray)),
        Span::styled("[↑/↓] Navigate  [←/→] Adjust Slider  [Shift+←/→] ±10  [[ / ]] ±5  [Enter] Select  [Ctrl+S] Save  [Esc] Cancel", Style::default().fg(Color::DarkGray)),
    ]));

    if let Some(ref err) = modal.error_message {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  Error: ", Style::default().fg(Color::Red).bold()),
            Span::styled(err.as_str(), Style::default().fg(Color::Red)),
        ]));
    }

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::AgentItem;

    #[test]
    fn test_termimations_loaded() {
        let patterns = termimation_patterns();
        assert!(!patterns.is_empty());
        assert!(patterns.len() >= 2);
    }

    #[test]
    fn test_agent_termimation_ball_animation() {
        let agent = AgentItem {
            id: "agent-1".into(),
            display_name: "Bot".into(),
            mention: "bot".into(),
            agent_id: "codex".into(),
            model: "".into(),
            orchestrator: false,
            vault_agent_id: None,
            owner_user_id: None,
            reasoning_effort: "".into(),
            priority_service_tier: false,
            reply_to_every_message: false,
            taggable_by_agents: false,
            pingable_by_others: false,
            yolo: false,
            conversation_id: None,
            color: None,
        };

        let ball_0 = agent_termimation_ball(&agent, 0, 0);
        let ball_1 = agent_termimation_ball(&agent, 1, 0);
        let ball_2 = agent_termimation_ball(&agent, 2, 0);

        assert!(!ball_0.is_empty());
        assert!(!ball_1.is_empty());
        assert!(!ball_2.is_empty());

        // Ensure animation changes across ticks (frame advances within a fixed pattern)
        let balls: Vec<String> = (0..8).map(|t| agent_termimation_ball(&agent, t, 0)).collect();
        let unique_balls: std::collections::HashSet<&String> = balls.iter().collect();
        assert!(unique_balls.len() > 1);
    }

    #[test]
    fn test_ansi_color_fallback() {
        // Pure red should match Red or LightRed
        let ansi_red = closest_ansi_color(255, 0, 0);
        assert!(ansi_red == Color::Red || ansi_red == Color::LightRed);

        // Pure green should match Green or LightGreen
        let ansi_green = closest_ansi_color(0, 255, 0);
        assert!(ansi_green == Color::Green || ansi_green == Color::LightGreen);

        // Pure blue should match Blue or LightBlue
        let ansi_blue = closest_ansi_color(0, 0, 255);
        assert!(ansi_blue == Color::Blue || ansi_blue == Color::LightBlue);
    }

    #[test]
    fn test_render_slider_line_width() {
        let line = render_slider_line("R", 128, 255, "", true, Color::LightRed, 60, |t| ((t * 255.0).round() as u8, 0, 0));
        // Spans: prefix, one span per track cell, suffix.
        let total_chars: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
        assert_eq!(total_chars, 60);
    }

    #[test]
    fn test_render_slider_line_gradient_sweeps_channel() {
        // The gradient should actually vary the fixed-other-channel color
        // across the track, not repeat a single flat color.
        let line = render_slider_line("R", 0, 255, "", false, Color::LightRed, 60, |t| (((t * 255.0).round()) as u8, 10, 20));
        let colors: std::collections::HashSet<Color> = line.spans.iter().map(|s| s.style.fg.unwrap_or(Color::Reset)).collect();
        assert!(colors.len() > 2, "expected the track to sweep through multiple colors, got {:?}", colors);
    }

    #[test]
    fn test_chat_cache_and_scrolling_performance() {
        use crate::api::{CascadeClient, ChatMessage};
        let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
        app.active_channel_id = Some("chan-long".into());

        for i in 0..500 {
            app.messages.push(ChatMessage {
                id: format!("msg-{i}"),
                author: if i % 2 == 0 { "diego".into() } else { "claude".into() },
                body: format!("Message {i}: Here is some conversational content that will span across multiple wrapped lines in the chat stream!"),
                created_at: "2026-09-08T04:00:00Z".into(),
                agent_id: if i % 2 == 1 { Some("claude-code".into()) } else { None },
                images: vec![],
                has_images: false,
            });
        }

        // First call populates cache
        ensure_chat_cache(&app, 80);
        let total_lines = app.chat_cache.read().unwrap().lines.len();
        assert!(total_lines > 500);

        // Ensure subsequent ensure_chat_cache calls are instant cache hits
        let start = std::time::Instant::now();
        for _ in 0..1000 {
            ensure_chat_cache(&app, 80);
        }
        let elapsed = start.elapsed();
        assert!(elapsed < std::time::Duration::from_millis(50), "1000 cache checks took {:?}", elapsed);

        // Clamping test
        for _ in 0..10000 {
            app.scroll_up();
        }
        assert_eq!(app.scroll_offset, total_lines);
        app.scroll_down();
        assert_eq!(app.scroll_offset, total_lines.saturating_sub(3));
    }

    #[test]
    fn test_chat_line_column_from_offsets() {
        let offsets = vec![(0, 5), (6, 6), (13, 0), (14, 10)];
        assert_eq!(chat_line_column_from_offsets(&offsets, 0), (0, 0));
        assert_eq!(chat_line_column_from_offsets(&offsets, 3), (0, 3));
        assert_eq!(chat_line_column_from_offsets(&offsets, 5), (0, 5));
        assert_eq!(chat_line_column_from_offsets(&offsets, 6), (1, 0));
        assert_eq!(chat_line_column_from_offsets(&offsets, 12), (1, 6));
        assert_eq!(chat_line_column_from_offsets(&offsets, 13), (2, 0));
        assert_eq!(chat_line_column_from_offsets(&offsets, 14), (3, 0));
        assert_eq!(chat_line_column_from_offsets(&offsets, 24), (3, 10));
        assert_eq!(chat_line_column_from_offsets(&offsets, 100), (3, 10));
    }

    #[test]
    fn test_chat_cache_invalidates_on_streaming_update() {
        use crate::api::{CascadeClient, ChatMessage};
        let mut app = App::new(CascadeClient::new("http://127.0.0.1:1".into(), None));
        app.active_channel_id = Some("chan-stream".into());
        app.messages.push(ChatMessage {
            id: "msg-1".into(),
            author: "claude".into(),
            body: "hello".into(),
            created_at: "2026-09-08T04:00:00Z".into(),
            agent_id: Some("claude-code".into()),
            images: vec![],
            has_images: false,
        });

        ensure_chat_cache(&app, 80);
        assert!(app.chat_cache.read().unwrap().chat_text.contains("hello"));
        assert!(!app.chat_cache.read().unwrap().chat_text.contains("world"));

        // Streaming update appends tokens to body
        app.messages[0].body = "hello world".into();
        ensure_chat_cache(&app, 80);
        assert!(app.chat_cache.read().unwrap().chat_text.contains("hello world"));
    }
}

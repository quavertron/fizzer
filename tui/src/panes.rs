//! Windows have independent identity and cursor state; buffers outlive windows.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Direction, Rect};
use ratatui_hypertile::{Hypertile, HypertileAction as Action, PaneId, raw::Node};
use crate::app::{ActivePane, App, HEADER_HEIGHT};
#[cfg(test)]
use ratatui_hypertile::{MoveScope, Towards};

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Default, Clone)]
pub struct WindowState {
    pub scroll: usize, cursor: Option<usize>, anchor: Option<usize>,
    input_cursor: usize, input_scroll: usize,
    message: usize, channel: usize, agent: usize, user: usize, note: usize,
    cache: crate::app::ChatRenderCache,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum SavedNode {
    Pane(u64),
    Split { vertical: bool, ratio: f32, first: Box<SavedNode>, second: Box<SavedNode> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedView { id: u64, view: ActivePane }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPanes {
    tree: SavedNode,
    views: Vec<SavedView>,
    focused: u64,
    automatic: bool,
    channels: Vec<(u64, String)>,
}
impl WindowState {
    pub fn take(app: &mut App) -> Self {
        Self {
            scroll: std::mem::take(&mut app.scroll_offset), cursor: app.chat_cursor.take(),
            anchor: app.chat_selection_anchor.take(), input_cursor: std::mem::take(&mut app.cursor_pos),
            input_scroll: std::mem::take(&mut app.input_scroll_offset),
            message: std::mem::take(&mut app.selected_message_idx), channel: std::mem::take(&mut app.selected_channel_idx),
            agent: std::mem::take(&mut app.selected_agent_idx), user: std::mem::take(&mut app.selected_user_idx),
            note: std::mem::take(&mut app.selected_note_idx),
            cache: std::mem::take(app.chat_cache.get_mut().unwrap()),
        }
    }
    pub fn restore(self, app: &mut App) {
        app.scroll_offset = self.scroll; app.chat_cursor = self.cursor; app.chat_selection_anchor = self.anchor;
        app.cursor_pos = self.input_cursor.min(app.input.chars().count()); app.input_scroll_offset = self.input_scroll;
        app.selected_message_idx = self.message; app.selected_channel_idx = self.channel;
        app.selected_agent_idx = self.agent; app.selected_user_idx = self.user; app.selected_note_idx = self.note;
        *app.chat_cache.get_mut().unwrap() = self.cache;
    }
}

pub struct BufferPicker { pub query: String, pub selected: usize, pub other: bool, pub command: bool }

#[derive(Clone, Copy)]
enum RegisterAction { Prefix, Save, Load }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppCommand { Vaults, ImportCodex, Refresh, TermCharMode }

const COMMANDS: &[&str] = &[
    "switch-to-buffer", "list-buffers", "switch-to-buffer-other-window",
    "other-window", "window-swap-states", "split-window-below", "split-window-right",
    "delete-window", "delete-other-windows", "balance-windows",
    "enlarge-window", "shrink-window", "enlarge-window-horizontally", "shrink-window-horizontally",
    "fizzer-vaults", "fizzer-import-codex-session", "fizzer-awatch", "term-char-mode", "save-window-configuration", "load-window-configuration", "revert-buffer", "save-buffers-kill-terminal",
];

fn command_key(name: &str) -> &'static str {
    match name {
        "switch-to-buffer" | "list-buffers" => "C-x b",
        "switch-to-buffer-other-window" => "C-x 4 b",
        "other-window" => "C-x o",
        "window-swap-states" => "C-x 4 0",
        "split-window-below" => "C-x 2",
        "split-window-right" => "C-x 3",
        "delete-window" => "C-x 0",
        "delete-other-windows" => "C-x 1",
        "balance-windows" => "C-x +",
        "enlarge-window" => "C-x ^",
        "shrink-window" => "C-x -",
        "enlarge-window-horizontally" => "C-x }",
        "shrink-window-horizontally" => "C-x {",
        "fizzer-vaults" | "fizzer-import-codex-session" | "fizzer-awatch" | "term-char-mode" | "save-window-configuration" | "load-window-configuration" | "revert-buffer" => "M-x",
        "save-buffers-kill-terminal" => "C-x C-c",
        _ => "",
    }
}

pub struct Panes {
    engine: Hypertile,
    views: Vec<(PaneId, ActivePane)>,
    automatic: bool,
    area: Rect,
    pub prefix: bool,
    rects: Vec<(ActivePane, Rect)>,
    window_rects: Vec<(PaneId, Rect)>,
    channels: HashMap<PaneId, String>,
    pub picker: Option<BufferPicker>,
    pub pending_command: Option<AppCommand>,
    transient_composer: Option<PaneId>,
    register_action: Option<RegisterAction>,
    other_prefix: bool,
}

fn split(direction: Direction, ratio: f32, first: Node, second: Node) -> Node {
    Node::Split { direction, ratio, first: Box::new(first), second: Box::new(second) }
}

impl Default for Panes {
    fn default() -> Self {
        let leaf = |id| Node::Pane(PaneId::new(id));
        let mut engine = Hypertile::new();
        engine.set_root(split(Direction::Horizontal, 0.26, leaf(0),
            split(Direction::Horizontal, 0.62,
                split(Direction::Vertical, 0.85, leaf(1), leaf(2)),
                split(Direction::Vertical, 0.5, leaf(3), leaf(4))))).unwrap();
        engine.focus_pane(PaneId::new(2)).unwrap();
        Self { engine, views: vec![(PaneId::new(0), ActivePane::ChatSelector), (PaneId::new(1), ActivePane::ChatMessages),
            (PaneId::new(2), ActivePane::ChatInput), (PaneId::new(3), ActivePane::Agents), (PaneId::new(4), ActivePane::Users)],
            automatic: true, area: Rect::default(), prefix: false, rects: Vec::new(),
            window_rects: Vec::new(), channels: HashMap::new(), picker: None, pending_command: None,
            transient_composer: None, register_action: None, other_prefix: false }
    }
}

impl Panes {
    pub fn save_config(&self) -> SavedPanes {
        fn save_node(current: &Node) -> SavedNode {
            match current {
                Node::Pane(id) => SavedNode::Pane(id.get()),
                Node::Split { direction, ratio, first, second } => SavedNode::Split {
                    vertical: *direction == Direction::Vertical, ratio: *ratio,
                    first: Box::new(save_node(first)), second: Box::new(save_node(second)),
                },
            }
        }
        SavedPanes {
            tree: save_node(self.engine.root()),
            views: self.views.iter().map(|(id, view)| SavedView { id: id.get(), view: *view }).collect(),
            focused: self.focused_id().get(), automatic: self.automatic,
            channels: self.channels.iter().map(|(id, channel)| (id.get(), channel.clone())).collect(),
        }
    }

    pub fn restore_config(&mut self, saved: &SavedPanes) -> bool {
        fn node(saved: &SavedNode, ids: &mut Vec<PaneId>) -> Option<Node> {
            match saved {
                SavedNode::Pane(id) => { let pane = PaneId::new(*id); ids.push(pane); Some(Node::Pane(pane)) }
                SavedNode::Split { vertical, ratio, first, second } => Some(Node::Split {
                    direction: if *vertical { Direction::Vertical } else { Direction::Horizontal },
                    ratio: *ratio, first: Box::new(node(first, ids)?), second: Box::new(node(second, ids)?),
                }),
            }
        }
        let mut ids = Vec::new();
        let Some(tree) = node(&saved.tree, &mut ids) else { return false; };
        if ids.is_empty() || ids.windows(2).any(|pair| pair[0] == pair[1])
            || saved.views.len() != ids.len()
            || saved.views.iter().any(|entry| !ids.contains(&PaneId::new(entry.id)))
            || !ids.contains(&PaneId::new(saved.focused)) { return false; }
        if self.engine.set_root(tree).is_err() { return false; }
        self.views = saved.views.iter().map(|entry| (PaneId::new(entry.id), entry.view)).collect();
        self.channels = saved.channels.iter().map(|(id, channel)| (PaneId::new(*id), channel.clone())).collect();
        self.automatic = saved.automatic;
        self.focus_id(PaneId::new(saved.focused));
        self.rects.clear(); self.window_rects.clear(); self.transient_composer = None;
        true
    }

    pub fn contains(&self, view: ActivePane) -> bool { self.views.iter().any(|(_, v)| *v == view) }
    pub fn id(&self, view: ActivePane) -> Option<PaneId> {
        if self.focused() == view { self.engine.focused_pane() }
        else { self.views.iter().find(|(_, v)| *v == view).map(|(id, _)| *id) }
    }
    pub fn focused_id(&self) -> PaneId { self.engine.focused_pane().unwrap() }
    pub fn focus_id(&mut self, id: PaneId) {
        let _ = self.engine.focus_pane(id);
    }
    pub fn view(&self, id: PaneId) -> ActivePane {
        self.views.iter().find(|(key, _)| *key == id).map(|(_, view)| *view).unwrap_or(ActivePane::ChatInput)
    }
    pub fn window_rectangles(&self) -> &[(PaneId, Rect)] { &self.window_rects }
    pub fn window_at(&self, x: u16, y: u16) -> Option<(PaneId, Rect)> {
        self.window_rects.iter().copied().find(|(_, r)| r.contains((x, y).into()))
    }
    pub fn focused(&self) -> ActivePane {
        self.views.iter().find(|(id, _)| Some(*id) == self.engine.focused_pane()).map(|(_, v)| *v).unwrap_or(ActivePane::ChatInput)
    }
    pub fn focus(&mut self, view: ActivePane) {
        if let Some(id) = self.id(view) {
            let _ = self.engine.focus_pane(id);
        }
    }

    fn swap_vertical_neighbor(&mut self) -> Result<(), String> {
        self.engine.compute_layout(self.area);
        let focused = self.focused_id();
        let Some(current) = self.engine.pane_rect(focused) else {
            return Err("Cannot swap the current window".into());
        };
        let current_center = current.y + current.height / 2;
        let target = self.engine.panes().into_iter()
            .filter(|pane| pane.id != focused && pane.rect.x < current.right() && current.x < pane.rect.right())
            .filter_map(|pane| {
                let center = pane.rect.y + pane.rect.height / 2;
                let distance = if center >= current_center {
                    center - current_center
                } else {
                    current_center - center
                };
                Some((distance, pane.id))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, id)| id)
            .ok_or_else(|| "No vertically adjacent window to swap".to_string())?;
        self.engine.swap_panes(focused, target).map_err(|error| error.to_string())
    }
    pub fn ensure(&mut self, view: ActivePane) {
        if view == ActivePane::Vaults { return; }
        if !self.contains(view) {
            if let Ok(id) = self.engine.split_focused(Direction::Vertical) { self.views.push((id, view)); self.automatic = false; }
        }
        self.focus(view);
    }
    pub fn ensure_channel(&mut self, view: ActivePane, channel: Option<&str>) {
        if !channel_view(view) { self.ensure(view); return; }
        let matches = |id: &PaneId, kind: &ActivePane| *kind == view
            // During startup the restored pane may already have a channel
            // binding while App is still waiting to activate that channel.
            // Reuse it instead of creating another split on every frame.
            && (channel.is_none()
                || self.channels.get(id).map(String::as_str).or(channel) == channel);
        let id = self.views.iter().find(|(id, kind)| *id == self.focused_id() && matches(id, kind))
            .or_else(|| self.views.iter().find(|(id, kind)| matches(id, kind))).map(|(id, _)| *id);
        if let Some(id) = id { self.focus_id(id); }
        else {
            if let Ok(id) = self.engine.split_focused(Direction::Vertical) {
                self.views.push((id, view));
                if let Some(channel) = channel { self.channels.insert(id, channel.into()); }
                self.automatic = false;
            }
        }
    }
    pub fn compute(&mut self, area: Rect, input_height: u16) {
        self.area = area;
        if self.automatic {
            let _ = self.engine.set_split_ratio(&[], 26.0 / f32::from(area.width.max(1)));
            let _ = self.engine.set_split_ratio(&[1], 1.0 - 28.0 / f32::from(area.width.saturating_sub(26).max(1)));
            let _ = self.engine.set_split_ratio(&[1, 0], 1.0 - f32::from(input_height) / f32::from(area.height.max(1)));
        }
        self.engine.compute_layout(area);
        // Keep small terminals usable without destroying their full-size layout.
        let mut compact;
        let layout = if area.width < 60 || area.height < 10 {
            compact = self.engine.clone();
            let _ = compact.set_root(Node::Pane(self.engine.focused_pane().unwrap()));
            compact.compute_layout(area);
            &compact
        } else { &self.engine };
        self.window_rects = layout.panes_iter().map(|pane| (pane.id, pane.rect)).collect();
        self.rects = layout.panes_iter().filter_map(|pane| {
            self.views.iter().find(|(id, _)| *id == pane.id).map(|(_, view)| (*view, pane.rect))
        }).collect();
        // Hypertile clamps splits to 10–90%. The default composer is sized in
        // rows, not a percentage: fit that policy here, in the shared geometry
        // used by rendering and mouse targeting (never separately in either).
        // A transient composer is an auto-opened message popup even though
        // creating its channel-specific split disables persistent auto-layout.
        // Keep that popup content-sized until it is submitted or dismissed.
        if (self.automatic || self.transient_composer.is_some()) && self.rects.len() > 1 {
            let messages = self.rect(ActivePane::ChatMessages);
            let input = self.rect(ActivePane::ChatInput);
            let height = input_height.min(input.bottom().saturating_sub(messages.y + 5));
            let top = input.bottom().saturating_sub(height);
            for (view, rect) in &mut self.rects {
                match view {
                    ActivePane::ChatMessages => rect.height = top.saturating_sub(rect.y),
                    ActivePane::ChatInput => { rect.y = top; rect.height = height; }
                    _ => {}
                }
            }
            for ((_, rect), (_, adjusted)) in self.window_rects.iter_mut().zip(&self.rects) { *rect = *adjusted; }
        }
    }
    #[cfg(test)]
    pub fn rectangles(&self) -> &[(ActivePane, Rect)] { &self.rects }
    pub fn rect(&self, view: ActivePane) -> Rect {
        self.id(view).and_then(|id| self.window_rects.iter().find(|(key, _)| *key == id).map(|(_, r)| *r)).unwrap_or_default()
    }
    #[cfg(test)]
    pub fn at(&self, column: u16, row: u16) -> Option<(ActivePane, Rect)> {
        self.rects.iter().copied().find(|(_, rect)| rect.contains((column, row).into()))
    }
    pub fn split(&mut self, direction: Direction) -> Result<(), String> {
        let view = self.focused();
        let original = self.focused_id();
        self.engine.compute_layout(self.area);
        let rect = self.rect(self.focused());
        if (direction == Direction::Horizontal && rect.width < 24) || (direction == Direction::Vertical && rect.height < 8) {
            return Err("Pane is too small to split; resize it or choose a larger view first.".into());
        }
        let id = self.engine.split_focused(direction).map_err(|e| e.to_string())?;
        self.views.push((id, view));
        if let Some(channel) = self.channels.get(&original).cloned() { self.channels.insert(id, channel); }
        // Emacs leaves focus in the original half of a split.
        self.focus_id(original);
        self.automatic = false;
        Ok(())
    }
    pub fn close(&mut self) -> Result<(), String> {
        let id = self.engine.close_focused().map_err(|_| "Cannot close the last view.".to_string())?;
        self.views.retain(|(existing, _)| *existing != id);
        self.channels.remove(&id);
        self.automatic = false;
        Ok(())
    }
    pub fn delete_other_windows(&mut self) {
        let id = self.focused_id();
        let _ = self.engine.set_root(Node::Pane(id));
        self.views.retain(|(key, _)| *key == id);
        self.channels.retain(|key, _| *key == id);
        self.automatic = false;
    }
    pub fn action(&mut self, action: Action) {
        if !matches!(action, Action::FocusNext | Action::FocusPrev | Action::FocusDirection { .. }) {
            self.automatic = false;
        }
        self.engine.compute_layout(self.area);
        self.engine.apply_action(action);
    }

    pub fn resize(&mut self, direction: Direction, cells: f32) -> Result<(), String> {
        fn visit(node: &Node, id: PaneId, direction: Direction, extent: f32, path: &mut Vec<usize>)
            -> (bool, Option<(Vec<usize>, f32)>) {
            match node {
                Node::Pane(key) => (*key == id, None),
                Node::Split { direction: axis, ratio, first, second } => {
                    for (index, child, fraction) in [(0, first, *ratio), (1, second, 1.0 - ratio)] {
                        path.push(index);
                        let (found, inner) = visit(child, id, direction, if *axis == direction { extent * fraction } else { extent }, path);
                        path.pop();
                        if found {
                            return (true, inner.or_else(|| (*axis == direction).then(|| (path.clone(),
                                if index == 0 { extent.max(1.0) } else { -extent.max(1.0) }))));
                        }
                    }
                    (false, None)
                }
            }
        }
        let extent = if direction == Direction::Vertical { self.area.height } else { self.area.width };
        let (_, target) = visit(self.engine.root(), self.focused_id(), direction, f32::from(extent), &mut vec![]);
        let Some((path, extent)) = target else { return Err("No adjacent window to resize in that direction.".into()); };
        let mut node = self.engine.root();
        for index in &path { if let Node::Split { first, second, .. } = node { node = if *index == 0 { first } else { second }; } }
        let Node::Split { ratio, .. } = node else { return Ok(()); };
        let ratio = *ratio + cells / extent;
        self.engine.set_split_ratio(&path, ratio.clamp(0.1, 0.9)).map_err(|e| e.to_string())?;
        self.automatic = false;
        Ok(())
    }

    pub fn balance(&mut self) {
        fn balanced(node: &Node) -> (Node, usize) {
            match node {
                Node::Pane(id) => (Node::Pane(*id), 1),
                Node::Split { direction, first, second, .. } => {
                    let (first, a) = balanced(first);
                    let (second, b) = balanced(second);
                    (split(*direction, a as f32 / (a + b) as f32, first, second), a + b)
                }
            }
        }
        let id = self.focused_id();
        let (root, _) = balanced(self.engine.root());
        let _ = self.engine.set_root(root);
        self.focus_id(id);
        self.automatic = false;
    }
}

pub fn main_area(area: Rect) -> Rect {
    let top = HEADER_HEIGHT.min(area.height);
    Rect::new(
        area.x,
        area.y.saturating_add(top),
        area.width,
        area.height.saturating_sub(top),
    )
}

fn channel_view(view: ActivePane) -> bool {
    matches!(view, ActivePane::ChatMessages | ActivePane::ChatInput | ActivePane::Agents)
}

pub fn save_window(app: &mut App) {
    if let Some(id) = app.loaded_window {
        let state = WindowState::take(app);
        app.window_states.insert(id, state);
    }
}

/// Older history changes flattened character offsets differently at each width.
/// Rebase every saved window on this buffer, including unfocused duplicates.
pub fn rebase_history_windows(app: &mut App, old_messages: Vec<crate::api::ChatMessage>) {
    let targets: Vec<_> = {
        let panes = app.panes.borrow();
        app.window_states.iter().filter(|(id, _)| panes.view(**id) == ActivePane::ChatMessages
            && panes.channels.get(id) == app.active_channel_id.as_ref())
            .map(|(id, state)| (*id, state.cache.wrap_width.max(1))).collect()
    };
    if targets.is_empty() { return; }
    let current_cache = std::mem::take(app.chat_cache.get_mut().unwrap());
    let new_messages = std::mem::replace(&mut app.messages, old_messages);
    let mut lengths = HashMap::new();
    for (_, width) in &targets {
        crate::ui::ensure_chat_cache(app, *width);
        lengths.insert(*width, app.chat_cache.read().unwrap().char_count);
    }
    app.messages = new_messages;
    for (id, width) in targets {
        crate::ui::ensure_chat_cache(app, width);
        let added = app.chat_cache.read().unwrap().char_count.saturating_sub(lengths[&width]);
        if let Some(state) = app.window_states.get_mut(&id) {
            state.cursor = state.cursor.map(|cursor| cursor + added);
            state.anchor = state.anchor.map(|anchor| anchor + added);
        }
    }
    *app.chat_cache.get_mut().unwrap() = current_cache;
}

pub fn activate_window(app: &mut App, id: PaneId) {
    let (view, channel) = {
        let mut panes = app.panes.borrow_mut();
        let view = panes.view(id);
        if channel_view(view) && !panes.channels.contains_key(&id) {
            if let Some(channel) = &app.active_channel_id { panes.channels.insert(id, channel.clone()); }
        }
        (view, panes.channels.get(&id).cloned())
    };
    if app.loaded_window != Some(id) {
        let had_window = app.loaded_window.is_some();
        save_window(app);
        if channel_view(view) { app.load_channel_buffer(channel); }
        if had_window {
            app.window_states.remove(&id).unwrap_or_default().restore(app);
        }
        app.loaded_window = Some(id);
    } else if channel_view(view) {
        app.load_channel_buffer(channel);
    }
    app.active_pane = view;
    // The agents view is a companion to the active chat, not an independent
    // channel selector. Keep every open agents window pointed at the chat
    // buffer the user is currently working in.
    if matches!(view, ActivePane::ChatMessages | ActivePane::ChatInput)
        && app.panes.borrow().focused_id() == id
    {
        if let Some(channel) = app.active_channel_id.clone() {
            let mut panes = app.panes.borrow_mut();
            let agent_panes: Vec<_> = panes.views.iter()
                .filter_map(|(pane_id, pane_view)| (*pane_view == ActivePane::Agents).then_some(*pane_id))
                .collect();
            for pane_id in agent_panes {
                panes.channels.insert(pane_id, channel.clone());
            }
        }
    }
}

pub fn activate_focused(app: &mut App) {
    let id = app.panes.borrow().focused_id();
    activate_window(app, id);
}

fn set_buffer(app: &mut App, view: ActivePane, channel: Option<String>) {
    save_window(app);
    let id = app.panes.borrow().focused_id();
    {
        let mut panes = app.panes.borrow_mut();
        if let Some((_, current)) = panes.views.iter_mut().find(|(key, _)| *key == id) { *current = view; }
        panes.channels.remove(&id);
        if let Some(channel) = &channel { panes.channels.insert(id, channel.clone()); }
        panes.automatic = false;
    }
    app.window_states.remove(&id);
    if channel_view(view) { app.load_channel_buffer(channel); }
    WindowState::default().restore(app);
    app.loaded_window = Some(id);
    app.active_pane = view;
}

pub fn show_channel(app: &mut App, channel: String) {
    // Opening from the directory uses a chat window, preserving other windows.
    if app.active_pane == ActivePane::ChatSelector {
        app.panes.borrow_mut().ensure(ActivePane::ChatMessages);
        activate_focused(app);
    }
    set_buffer(app, ActivePane::ChatMessages, Some(channel));
}

pub fn focus_composer(app: &mut App) {
    let channel = app.active_channel_id.clone();
    let had_matching = {
        let panes = app.panes.borrow();
        panes.views.iter().any(|(id, view)| *view == ActivePane::ChatInput
            && panes.channels.get(id) == channel.as_ref())
    };
    let mut panes = app.panes.borrow_mut();
    panes.ensure_channel(ActivePane::ChatInput, channel.as_deref());
    // ensure_channel preserves the old focus when it creates a split. The
    // composer command, however, must land in the channel-specific composer
    // it just opened so sizing and transient close apply to that pane.
    if let Some(id) = panes.views.iter().find(|(id, view)| *view == ActivePane::ChatInput
        && panes.channels.get(id).map(String::as_str).or(channel.as_deref()) == channel.as_deref()).map(|(id, _)| *id) {
        panes.focus_id(id);
        if !had_matching { panes.transient_composer = Some(id); }
    }
    drop(panes);
    activate_focused(app);
}

pub fn close_transient_composer(app: &mut App) {
    let Some(id) = app.panes.borrow().transient_composer else { return; };
    if app.panes.borrow().focused_id() == id {
        let mut panes = app.panes.borrow_mut();
        let _ = panes.close();
        panes.transient_composer = None;
        drop(panes);
        activate_focused(app);
    }
}

pub fn buffer_choices(app: &App) -> Vec<(String, ActivePane, Option<String>)> {
    let panes = app.panes.borrow();
    let query = panes.picker.as_ref().map(|p| p.query.to_lowercase()).unwrap_or_default();
    if panes.picker.as_ref().is_some_and(|p| p.command) {
        let command_query = query.split_whitespace().next().unwrap_or("");
        return COMMANDS.iter().filter(|name| name.contains(command_query))
            .map(|name| (format!("{}  [{}]", name, command_key(name)), ActivePane::Vaults, None)).collect();
    }
    drop(panes);
    let mut choices = vec![
        ("Channels".into(), ActivePane::ChatSelector, None),
        ("Notes".into(), ActivePane::Notes, None),
        ("Users".into(), ActivePane::Users, None),
        ("Agents".into(), ActivePane::Agents, app.active_channel_id.clone()),
        ("Awatch".into(), ActivePane::Awatch, None),
    ];
    let mut channels: Vec<_> = app.channels.iter().collect();
    channels.sort_by_key(|ch| app.active_channel_id.as_ref() != Some(&ch.id));
    for channel in channels {
        for (label, view) in [("Chat", ActivePane::ChatMessages), ("Composer", ActivePane::ChatInput)] {
            let name = if app.channels.iter().filter(|ch| ch.title == channel.title).count() > 1 {
                format!("#{} · {} [{}]", channel.title, label, channel.id)
            } else { format!("#{} · {}", channel.title, label) };
            choices.push((name, view, Some(channel.id.clone())));
        }
    }
    choices.retain(|(name, _, _)| name.to_lowercase().contains(&query));
    choices
}

fn picker_key(app: &mut App, key: KeyEvent) -> bool {
    if app.panes.borrow().picker.is_none() { return false; }
    let choices = buffer_choices(app);
    let mut panes = app.panes.borrow_mut();
    let picker_query = panes.picker.as_ref().unwrap().query.clone();
    let picker = panes.picker.as_mut().unwrap();
    match key.code {
        KeyCode::Esc | KeyCode::Char('g') if key.code == KeyCode::Esc || key.modifiers.contains(KeyModifiers::CONTROL) => { panes.picker = None; }
        KeyCode::Enter => {
            let choice = choices.get(picker.selected.min(choices.len().saturating_sub(1))).cloned();
            let other = picker.other;
            let command = picker.command;
            if let Some((name, view, channel)) = choice {
                panes.picker = None;
                if command {
                    drop(panes);
                    let command_name = name.split("  [").next().unwrap_or(&name).to_string();
                    let args = picker_query.strip_prefix(&command_name).unwrap_or("").trim();
                    let command = if args.is_empty() { command_name } else { format!("{command_name} {args}") };
                    execute_command(app, &command);
                    return true;
                }
                if other {
                    if panes.views.len() == 1 {
                        if let Err(error) = panes.split(Direction::Horizontal) { app.status_message = error; return true; }
                    }
                    panes.action(Action::FocusNext);
                }
                drop(panes);
                set_buffer(app, view, channel);
                app.status_message = format!("Buffer: {name}");
                return true;
            }
        }
        KeyCode::Up => picker.selected = (picker.selected + choices.len().saturating_sub(1)) % choices.len().max(1),
        KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => picker.selected = (picker.selected + choices.len().saturating_sub(1)) % choices.len().max(1),
        KeyCode::Down => picker.selected = (picker.selected + 1) % choices.len().max(1),
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => picker.selected = (picker.selected + 1) % choices.len().max(1),
        KeyCode::Tab => {
            if let Some((name, _, _)) = choices.get(picker.selected.min(choices.len().saturating_sub(1))) {
                picker.query = if picker.command {
                    name.split("  [").next().unwrap_or(name).to_string()
                } else {
                    name.clone()
                };
                picker.selected = 0;
            }
        }
        KeyCode::Backspace => { picker.query.pop(); picker.selected = 0; }
        KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => { picker.query.push(c); picker.selected = 0; }
        _ => {}
    }
    true
}

pub fn execute_command(app: &mut App, name: &str) {
    if name == "fizzer-awatch" {
        set_buffer(app, ActivePane::Awatch, None);
        return;
    }
    if let Some(favorite) = name.strip_prefix("load-window-configuration ").map(str::trim).filter(|name| !name.is_empty()) {
        let Some(saved) = app.window_config_favorites.get(favorite).cloned() else {
            app.status_message = format!("No window configuration named '{favorite}'.");
            return;
        };
        let restored = app.panes.borrow_mut().restore_config(&saved);
        if restored {
            app.active_pane = app.panes.borrow().focused();
            activate_focused(app);
            app.status_message = format!("Loaded window configuration '{favorite}'.");
        } else { app.status_message = "Window configuration is invalid.".into(); }
        return;
    }
    if let Some(favorite) = name.strip_prefix("save-window-configuration ").map(str::trim).filter(|name| !name.is_empty()) {
        app.window_config_favorites.insert(favorite.to_string(), app.panes.borrow().save_config());
        app.status_message = format!("Saved window configuration '{favorite}'.");
        return;
    }
    let code = match name {
        "switch-to-buffer" | "list-buffers" => Some(KeyCode::Char('b')),
        "switch-to-buffer-other-window" => {
            app.panes.borrow_mut().other_prefix = true; Some(KeyCode::Char('b'))
        }
        "other-window" => Some(KeyCode::Char('o')),
        "window-swap-states" => {
            let result = app.panes.borrow_mut().swap_vertical_neighbor();
            app.status_message = result.err().unwrap_or_default(); None
        }
        "split-window-below" => Some(KeyCode::Char('2')),
        "split-window-right" => Some(KeyCode::Char('3')),
        "delete-window" => Some(KeyCode::Char('0')),
        "delete-other-windows" => Some(KeyCode::Char('1')),
        "balance-windows" => Some(KeyCode::Char('+')),
        "enlarge-window" => Some(KeyCode::Char('^')),
        "enlarge-window-horizontally" => Some(KeyCode::Char('}')),
        "shrink-window-horizontally" => Some(KeyCode::Char('{')),
        "shrink-window" => {
            let result = app.panes.borrow_mut().resize(Direction::Vertical, -1.0);
            app.status_message = result.err().unwrap_or_default(); None
        }
        "fizzer-vaults" => { app.panes.borrow_mut().pending_command = Some(AppCommand::Vaults); None }
        "fizzer-import-codex-session" => { app.panes.borrow_mut().pending_command = Some(AppCommand::ImportCodex); None }
        "term-char-mode" => { app.panes.borrow_mut().pending_command = Some(AppCommand::TermCharMode); None }
        "revert-buffer" => { app.panes.borrow_mut().pending_command = Some(AppCommand::Refresh); None }
        "save-buffers-kill-terminal" => { app.should_quit = true; None }
        _ => { app.status_message = format!("Unknown command: {name}"); None }
    };
    if let Some(code) = code {
        app.panes.borrow_mut().prefix = true;
        key(app, KeyEvent::new(code, KeyModifiers::NONE));
    }
}

pub fn prepare(app: &App, area: Rect) {
    let mut panes = app.panes.borrow_mut();
    panes.ensure_channel(app.active_pane, app.active_channel_id.as_deref());
    panes.compute(main_area(area), 3);
    let input_width = panes.rect(ActivePane::ChatInput).width.max(1);
    let height = app.input_box_height_for_width(area.height, input_width);
    if height != 3 { panes.compute(main_area(area), height); }
}

/// Called after modal handling, before composer handling. Unknown sequences are
/// consumed deliberately, like Emacs: they never leak a command character into a draft.
pub fn key(app: &mut App, key: KeyEvent) -> bool {
    if app.panes.borrow().picker.is_some() { return picker_key(app, key); }
    let register_action = { app.panes.borrow().register_action };
    if let Some(action) = register_action {
        match action {
            RegisterAction::Prefix => {
                let mut panes = app.panes.borrow_mut();
                panes.register_action = match key.code {
                    KeyCode::Char('w') => Some(RegisterAction::Save),
                    KeyCode::Char('j') => Some(RegisterAction::Load),
                    _ => None,
                };
                if panes.register_action.is_some() { app.status_message = "C-x r: register".into(); return true; }
            }
            RegisterAction::Save | RegisterAction::Load => if let KeyCode::Char(register) = key.code {
                if key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) { return true; }
                app.panes.borrow_mut().register_action = None;
                if matches!(action, RegisterAction::Save) {
                    let config = app.panes.borrow().save_config();
                    app.window_config_registers.insert(register, config);
                    app.status_message = format!("Saved window register '{register}'.");
                } else if let Some(config) = app.window_config_registers.get(&register).cloned() {
                    if app.panes.borrow_mut().restore_config(&config) {
                        app.active_pane = app.panes.borrow().focused();
                        activate_focused(app);
                        app.status_message = format!("Loaded window register '{register}'.");
                    } else { app.status_message = "Window register is invalid.".into(); }
                } else { app.status_message = format!("No window register '{register}'."); }
                return true;
            }
        }
    }
    if matches!(key.code, KeyCode::F(_)) { return true; }
    if matches!(key.code, KeyCode::Char('x' | 'X')) && key.modifiers.contains(KeyModifiers::CONTROL) {
        let mut panes = app.panes.borrow_mut();
        panes.prefix = true;
        panes.other_prefix = false;
        app.status_message = "C-x:".into();
        return true;
    }
    if app.panes.borrow().prefix && !app.panes.borrow().other_prefix && key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.panes.borrow_mut().prefix = false;
        app.should_quit = true;
        return true;
    }
    if key.code == KeyCode::Char('x') && key.modifiers.contains(KeyModifiers::ALT)
        && app.vault_action.is_none() && app.codex_import.is_none() && app.agent_settings_modal.is_none() && app.user_settings_modal.is_none() {
        let mut panes = app.panes.borrow_mut();
        panes.prefix = false;
        panes.other_prefix = false;
        panes.picker = Some(BufferPicker { query: String::new(), selected: 0, other: false, command: true });
        return true;
    }
    if app.show_vaults || app.vault_action.is_some() || app.codex_import.is_some() || app.agent_settings_modal.is_some() || app.user_settings_modal.is_some() || app.new_channel_name.is_some() {
        app.panes.borrow_mut().prefix = false;
        return false;
    }
    app.panes.borrow_mut().ensure_channel(app.active_pane, app.active_channel_id.as_deref());
    activate_focused(app);
    let mut panes = app.panes.borrow_mut();
    panes.focus(app.active_pane);
    if !panes.prefix { return false; }
    panes.prefix = false;
    if key.code == KeyCode::Char('4') {
        panes.prefix = true; panes.other_prefix = true;
        app.status_message = "C-x 4: b buffer in other window".into();
        return true;
    }
    let other = std::mem::take(&mut panes.other_prefix);
    if other && key.code == KeyCode::Char('0') {
        let result = panes.swap_vertical_neighbor();
        panes.prefix = false;
        app.status_message = result.err().unwrap_or_default();
        app.active_pane = panes.focused();
        return true;
    }
    if key.code == KeyCode::Char('b') {
        panes.picker = Some(BufferPicker { query: String::new(), selected: 0, other, command: false });
        return true;
    }
    if key.code == KeyCode::Char('r') {
        panes.register_action = Some(RegisterAction::Prefix);
        app.status_message = "C-x r: save (w) or load (j) register".into();
        return true;
    }
    let original_windows: Vec<_> = panes.views.iter().map(|(id, _)| *id).collect();
    let result = match key.code {
        KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) => Ok(()),
        KeyCode::Esc => Ok(()),
        _ if other => Err("Undefined C-x 4 sequence (use b to select a buffer).".into()),
        KeyCode::Char('2') => panes.split(Direction::Vertical),
        KeyCode::Char('3') => panes.split(Direction::Horizontal),
        KeyCode::Char('0') => panes.close(),
        KeyCode::Char('1') => { panes.delete_other_windows(); Ok(()) }
        KeyCode::Char('o') => { panes.action(Action::FocusNext); Ok(()) }
        KeyCode::Char('+') => { panes.balance(); Ok(()) }
        KeyCode::Char('^') => panes.resize(Direction::Vertical, 1.0),
        KeyCode::Char('-') => panes.resize(Direction::Vertical, -1.0),
        KeyCode::Char('{') => panes.resize(Direction::Horizontal, -1.0),
        KeyCode::Char('}') => panes.resize(Direction::Horizontal, 1.0),
        _ => Err("Undefined C-x sequence (C-g cancels).".into()),
    };
    app.active_pane = panes.focused();
    app.status_message = result.err().unwrap_or_default();
    let new_windows: Vec<_> = panes.views.iter().map(|(id, _)| *id).filter(|id| !original_windows.contains(id)).collect();
    let remaining: Vec<_> = panes.views.iter().map(|(id, _)| *id).collect();
    drop(panes);
    if matches!(key.code, KeyCode::Char('2' | '3')) {
        let state = WindowState::take(app);
        for id in new_windows { app.window_states.insert(id, state.clone()); }
        state.restore(app);
    }
    activate_focused(app);
    app.window_states.retain(|id, _| remaining.contains(id));
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn awatch_is_a_global_buffer_and_supports_emacs_window_switching() {
        let mut app = app();
        let draft = app.input.clone();
        assert!(super::buffer_choices(&app).iter().any(|(name, view, channel)|
            name == "Awatch" && *view == ActivePane::Awatch && channel.is_none()));
        choose_buffer(&mut app, "Awatch");
        assert_eq!(app.active_pane, ActivePane::Awatch);
        assert_eq!(app.input, draft);
        chord(&mut app, KeyCode::Char('o'));
        assert_ne!(app.active_pane, ActivePane::Awatch);
        execute_command(&mut app, "fizzer-awatch");
        assert_eq!(app.active_pane, ActivePane::Awatch);
    }

    #[test]
    fn agents_is_one_buffer_bound_to_the_active_chat_channel() {
        let mut app = app();
        app.active_channel_id = Some("channel-1".into());
        let choices = super::buffer_choices(&app);
        let agents: Vec<_> = choices.iter().filter(|(name, view, _)|
            name == "Agents" && *view == ActivePane::Agents).collect();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].2.as_deref(), Some("channel-1"));
        assert!(!choices.iter().any(|(name, _, _)| name.ends_with("· Agents")));
    }
    use super::*;
    fn app() -> App {
        let mut app = App::new(crate::api::CascadeClient::new("http://127.0.0.1:1".into(), None));
        app.show_vaults = false;
        app.active_pane = ActivePane::ChatMessages;
        prepare(&app, Rect::new(0, 0, 140, 42));
        app
    }
    fn chord(app: &mut App, code: KeyCode) {
        assert!(key(app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert!(key(app, KeyEvent::new(code, KeyModifiers::NONE)));
        prepare(app, Rect::new(0, 0, 140, 42));
    }

    fn choose_buffer(app: &mut App, query: &str) {
        chord(app, KeyCode::Char('b'));
        for c in query.chars() { assert!(key(app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))); }
        assert!(key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
    }

    fn named_command(app: &mut App, name: &str) {
        assert!(key(app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT)));
        for c in name.chars() { assert!(key(app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))); }
        assert!(key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        prepare(app, Rect::new(0, 0, 140, 42));
    }

    #[test]
    fn function_keys_are_unbound_and_named_commands_replace_them() {
        let mut app = app();
        app.input = "keep draft".into();
        let original = app.panes.borrow().focused_id();
        let count = app.panes.borrow().views.len();
        for number in 1..=12 {
            assert!(key(&mut app, KeyEvent::new(KeyCode::F(number), KeyModifiers::NONE)));
            assert_eq!(app.panes.borrow().focused_id(), original);
            assert_eq!(app.panes.borrow().views.len(), count);
            assert!(!app.show_vaults);
            assert!(app.codex_import.is_none());
            assert_eq!(app.input, "keep draft");
        }
        for (name, expected) in [
            ("fizzer-vaults", AppCommand::Vaults),
            ("fizzer-import-codex-session", AppCommand::ImportCodex),
            ("revert-buffer", AppCommand::Refresh),
        ] {
            named_command(&mut app, name);
            assert_eq!(app.panes.borrow_mut().pending_command.take(), Some(expected));
            assert_eq!(app.input, "keep draft");
        }
        named_command(&mut app, "switch-to-buffer");
        assert!(app.panes.borrow().picker.as_ref().is_some_and(|p| !p.command));
        key(&mut app, KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        named_command(&mut app, "delete-other-windows");
        assert_eq!(app.panes.borrow().views.len(), 1);
        named_command(&mut app, "split-window-right");
        assert_eq!(app.panes.borrow().views.len(), 2);
    }

    #[test]
    fn command_minibuffer_completes_and_cancels_without_editing_draft() {
        let mut app = app();
        app.input = "unchanged".into();
        key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT));
        for c in "fizzer-import".chars() { key(&mut app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)); }
        key(&mut app, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.panes.borrow().picker.as_ref().unwrap().query, "fizzer-import-codex-session");
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 42)).unwrap();
        terminal.draw(|frame| crate::ui::render(frame, &mut app)).unwrap();
        let screen: String = terminal.backend().buffer().content.iter().map(|cell| cell.symbol()).collect();
        assert!(screen.contains("M-x fizzer-import-codex-session"));
        for old_label in ["F1", "F2", "F3", "F4", "F5", "F6", "Alt+e"] { assert!(!screen.contains(old_label)); }
        key(&mut app, KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(app.panes.borrow().picker.is_none());
        assert!(app.panes.borrow().pending_command.is_none());
        assert_eq!(app.input, "unchanged");
    }

    #[test]
    fn command_picker_navigation_wraps_in_both_directions() {
        let mut app = app();
        key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT));
        let count = buffer_choices(&app).len();
        assert!(count > 1);
        key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.panes.borrow().picker.as_ref().unwrap().selected, count - 1);
        key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.panes.borrow().picker.as_ref().unwrap().selected, 0);
    }

    #[test]
    fn window_swap_states_swaps_with_the_vertical_neighbor() {
        let mut app = app();
        prepare(&app, Rect::new(0, 0, 140, 42));
        let focused = app.panes.borrow().focused_id();
        let before = app.panes.borrow().rect(ActivePane::ChatInput);
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('4'), KeyModifiers::NONE)));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('0'), KeyModifiers::NONE)));
        prepare(&app, Rect::new(0, 0, 140, 42));
        let after = app.panes.borrow().rect(ActivePane::ChatInput);
        assert!(after.y < before.y);
        assert_eq!(app.panes.borrow().focused_id(), focused);
    }

    #[test]
    fn shrink_window_direct_binding_matches_m_x_command() {
        let mut app = app();
        prepare(&app, Rect::new(0, 0, 140, 42));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('-'), KeyModifiers::NONE)));
        assert!(!app.status_message.contains("Undefined"));
    }

    #[test]
    fn standard_resize_bindings_use_the_requested_axis_and_balance() {
        let mut app = app();
        chord(&mut app, KeyCode::Char('1'));
        chord(&mut app, KeyCode::Char('3'));
        let width = app.panes.borrow().rect(ActivePane::ChatMessages).width;
        chord(&mut app, KeyCode::Char('}'));
        assert!(app.panes.borrow().rect(ActivePane::ChatMessages).width > width);
        chord(&mut app, KeyCode::Char('{'));
        assert_eq!(app.panes.borrow().rect(ActivePane::ChatMessages).width, width);
        chord(&mut app, KeyCode::Char('^'));
        assert!(app.status_message.contains("No adjacent window"));
        app.panes.borrow_mut().action(Action::ResizeFocused { delta: 0.2 });
        chord(&mut app, KeyCode::Char('+'));
        let rects = app.panes.borrow().window_rectangles().to_vec();
        assert!(rects[0].1.width.abs_diff(rects[1].1.width) <= 1);
        chord(&mut app, KeyCode::Char('2'));
        let height = app.panes.borrow().rect(ActivePane::ChatMessages).height;
        chord(&mut app, KeyCode::Char('^'));
        assert!(app.panes.borrow().rect(ActivePane::ChatMessages).height > height);
    }

    #[test]
    fn picker_opens_two_channels_without_mixing_messages_or_drafts() {
        let mut app = app();
        app.channels = vec![
            crate::api::ChannelItem { id: "one".into(), title: "one".into() },
            crate::api::ChannelItem { id: "two".into(), title: "two".into() },
        ];
        app.active_channel_id = Some("one".into());
        app.messages = vec![serde_json::from_value(serde_json::json!({"id":"one-message","body":"First channel content"})).unwrap()];
        app.input = "draft one".into();
        app.pending_images = vec!["image one".into()];
        chord(&mut app, KeyCode::Char('1'));
        let first = app.panes.borrow().focused_id();
        chord(&mut app, KeyCode::Char('3'));
        chord(&mut app, KeyCode::Char('o'));
        let second = app.panes.borrow().focused_id();
        choose_buffer(&mut app, "#two · Chat");
        assert_eq!(app.active_channel_id.as_deref(), Some("two"));
        assert!(app.messages.is_empty());
        assert!(app.input.is_empty());
        assert!(app.pending_images.is_empty());
        app.messages = vec![serde_json::from_value(serde_json::json!({"id":"two-message","body":"Second channel content"})).unwrap()];
        app.input = "draft two".into();
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 42)).unwrap();
        terminal.draw(|frame| crate::ui::render(frame, &mut app)).unwrap();
        let screen: String = terminal.backend().buffer().content.iter().map(|cell| cell.symbol()).collect();
        assert!(screen.contains("First channel content"));
        assert!(screen.contains("Second channel content"));
        assert_eq!(app.panes.borrow().focused_id(), second);
        assert_eq!(app.active_channel_id.as_deref(), Some("two"));
        assert_eq!(app.input, "draft two");
        app.panes.borrow_mut().focus_id(first);
        activate_focused(&mut app);
        assert_eq!(app.active_channel_id.as_deref(), Some("one"));
        assert_eq!(app.input, "draft one");
        assert_eq!(app.pending_images, ["image one"]);
        assert_eq!(app.messages[0].id, "one-message");
        focus_composer(&mut app);
        assert_eq!(app.active_channel_id.as_deref(), Some("one"));
        assert_eq!(app.active_pane, ActivePane::ChatInput);
        assert_eq!(app.input, "draft one");
    }

    #[test]
    fn other_window_picker_and_cancel_preserve_existing_buffers() {
        let mut app = app();
        app.input = "untouched".into();
        chord(&mut app, KeyCode::Char('1'));
        let first = app.panes.borrow().focused_id();
        chord(&mut app, KeyCode::Char('4'));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE)));
        for c in "Notes".chars() { key(&mut app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)); }
        key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.active_pane, ActivePane::Notes);
        assert_ne!(app.panes.borrow().focused_id(), first);
        assert_eq!(app.panes.borrow().view(first), ActivePane::ChatMessages);
        assert_eq!(app.input, "untouched");
        chord(&mut app, KeyCode::Char('b'));
        key(&mut app, KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(app.panes.borrow().picker.is_none());
        assert_eq!(app.active_pane, ActivePane::Notes);
        assert_eq!(app.input, "untouched");
    }

    #[test]
    fn duplicate_composers_share_text_but_keep_their_own_point() {
        let mut app = app();
        app.active_channel_id = Some("one".into());
        app.channels = vec![crate::api::ChannelItem { id: "one".into(), title: "one".into() }];
        chord(&mut app, KeyCode::Char('1'));
        choose_buffer(&mut app, "Composer");
        app.input = "shared draft".into();
        app.cursor_pos = 5;
        let first = app.panes.borrow().focused_id();
        chord(&mut app, KeyCode::Char('3'));
        chord(&mut app, KeyCode::Char('o'));
        assert_eq!(app.cursor_pos, 5);
        app.cursor_pos = 2;
        app.input.push('!');
        app.panes.borrow_mut().focus_id(first);
        activate_focused(&mut app);
        assert_eq!(app.input, "shared draft!");
        assert_eq!(app.cursor_pos, 5);
    }

    #[test]
    fn older_history_rebases_selection_in_both_windows_at_their_own_widths() {
        let mut app = app();
        app.active_channel_id = Some("one".into());
        app.messages = vec![serde_json::from_value(serde_json::json!({
            "id":"recent", "author":"Diego", "body":"Existing selection"
        })).unwrap()];
        app.history_channel = Some("one".into());
        app.history_before = Some(30);
        chord(&mut app, KeyCode::Char('1'));
        chord(&mut app, KeyCode::Char('3'));
        app.panes.borrow_mut().action(Action::ResizeFocused { delta: -0.2 });
        prepare(&app, Rect::new(0, 0, 140, 42));
        let windows = app.panes.borrow().window_rectangles().to_vec();
        for (id, rect) in &windows {
            app.panes.borrow_mut().focus_id(*id);
            activate_focused(&mut app);
            let text = crate::ui::chat_log_text(&app, rect.width.saturating_sub(4) as usize);
            let start = text[..text.find("Existing").unwrap()].chars().count();
            app.chat_selection_anchor = Some(start);
            app.chat_cursor = Some(start + "Existing".len());
        }
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        crate::apply_backend_event(&mut app, crate::BackendEvent::HistoryPage {
            channel_id: "one".into(), before: Some(30),
            result: Ok(crate::api::MessagesResponse {
                messages: vec![serde_json::from_value(serde_json::json!({
                    "id":"old", "author":"Earlier", "body":"Long earlier history ".repeat(20)
                })).unwrap()], before_seq: None, has_more: false,
            }),
        }, &tx);
        for (id, rect) in windows {
            app.panes.borrow_mut().focus_id(id);
            activate_focused(&mut app);
            let text = crate::ui::chat_log_text(&app, rect.width.saturating_sub(4) as usize);
            assert_eq!(app.selected_chat_text(&text).as_deref(), Some("Existing"));
        }
    }

    #[test]
    fn mouse_targets_duplicate_windows_by_identity() {
        let mut app = app();
        app.active_channel_id = Some("one".into());
        app.messages = vec![serde_json::from_value(serde_json::json!({
            "id":"m", "body":"some chat text ".repeat(200)
        })).unwrap()];
        chord(&mut app, KeyCode::Char('1'));
        chord(&mut app, KeyCode::Char('3'));
        let first = app.panes.borrow().focused_id();
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 42)).unwrap();
        terminal.draw(|frame| crate::ui::render(frame, &mut app)).unwrap();
        let (second, rect) = app.panes.borrow().window_rectangles().iter().copied().find(|(id, _)| *id != first).unwrap();
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mouse = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollUp, column: rect.x + 2,
            row: rect.y + 2, modifiers: KeyModifiers::NONE,
        };
        let screen = Rect::new(0, 0, 140, 42);
        crate::handle_pane_mouse(&mut app, mouse, &tx, screen);
        assert_eq!(app.panes.borrow().focused_id(), first);
        assert_eq!(app.scroll_offset, 0);
        assert!(app.window_states[&second].scroll > 0);
        crate::handle_pane_mouse(&mut app, crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left), ..mouse
        }, &tx, screen);
        assert_eq!(app.panes.borrow().focused_id(), second);
        assert_eq!(app.loaded_window, Some(second));
        assert!(app.chat_cursor.is_some());
    }
    #[test]
    fn default_composer_keeps_original_height_and_mouse_bounds_on_tall_terminals() {
        let mut app = app();
        for rows in [24, 42, 80, 120] {
            prepare(&app, Rect::new(0, 0, 140, rows));
            let panes = app.panes.borrow();
            let input = panes.rect(ActivePane::ChatInput);
            let messages = panes.rect(ActivePane::ChatMessages);
            assert_eq!(input.height, 3);
            assert_eq!(messages.bottom(), input.y);
            assert_eq!(input.bottom(), rows);
            assert_eq!(panes.at(input.x + 1, input.y + 1).unwrap().0, ActivePane::ChatInput);
            assert_eq!(panes.at(input.x + 1, input.y - 1).unwrap().0, ActivePane::ChatMessages);
        }
        app.input = "one\ntwo\nthree".into();
        prepare(&app, Rect::new(0, 0, 140, 80));
        assert_eq!(app.panes.borrow().rect(ActivePane::ChatInput).height, 5);
        app.input.clear();
        prepare(&app, Rect::new(0, 0, 140, 80));
        assert_eq!(app.panes.borrow().rect(ActivePane::ChatInput).height, 3);
        app.active_pane = ActivePane::ChatInput;
        prepare(&app, Rect::new(0, 0, 140, 120));
        assert!(app.panes.borrow_mut().split(Direction::Vertical).is_err());
    }

    #[test]
    fn split_directions_duplicate_buffers_and_keep_independent_cursors() {
        for (code, direction) in [('2', Direction::Vertical), ('3', Direction::Horizontal)] {
            let mut app = app();
            app.input = "unsent draft 界".into();
            app.pending_images = vec!["image-data".into()];
            app.active_channel_id = Some("same-channel".into());
            app.messages = vec![serde_json::from_value(serde_json::json!({"id":"kept", "body":"Existing content"})).unwrap()];
            app.active_agent_ids.insert("running-agent".into());
            app.scroll_offset = 12;
            app.chat_cursor = Some(7);
            let first = app.panes.borrow().focused_id();
            let original_rect = app.panes.borrow().rect(ActivePane::ChatMessages);
            chord(&mut app, KeyCode::Char(code));
            assert_eq!(app.panes.borrow().focused_id(), first);
            let panes = app.panes.borrow();
            let copies: Vec<_> = panes.window_rectangles().iter().copied()
                .filter(|(id, _)| panes.view(*id) == ActivePane::ChatMessages).collect();
            assert_eq!(copies.len(), 2);
            let (second, second_rect) = copies.iter().copied().find(|(id, _)| *id != first).unwrap();
            let first_rect = panes.rect(ActivePane::ChatMessages);
            if direction == Direction::Vertical { assert_eq!(second_rect.y, first_rect.bottom()); assert_eq!(second_rect.x, original_rect.x); }
            else { assert_eq!(second_rect.x, first_rect.right()); assert_eq!(second_rect.y, original_rect.y); }
            drop(panes);
            app.panes.borrow_mut().focus_id(second);
            activate_focused(&mut app);
            assert_eq!(app.scroll_offset, 12);
            assert_eq!(app.chat_cursor, Some(7));
            app.scroll_offset = 3;
            app.chat_cursor = Some(2);
            app.panes.borrow_mut().focus_id(first);
            activate_focused(&mut app);
            assert_eq!(app.scroll_offset, 12);
            assert_eq!(app.chat_cursor, Some(7));
            app.panes.borrow_mut().focus_id(second);
            activate_focused(&mut app);
            chord(&mut app, KeyCode::Char('0'));
            app.panes.borrow_mut().focus_id(first);
            activate_focused(&mut app);
            assert_eq!(app.input, "unsent draft 界");
            assert_eq!(app.pending_images, ["image-data"]);
            assert_eq!(app.messages[0].body, "Existing content");
            assert_eq!(app.scroll_offset, 12);
            assert_eq!(app.chat_cursor, Some(7));
        }
    }

    #[test]
    fn delete_other_windows_is_not_a_maximize_toggle() {
        let mut app = app();
        app.input = "keep draft".into();
        let first = app.panes.borrow().focused_id();
        chord(&mut app, KeyCode::Char('1'));
        let full = vec![(ActivePane::ChatMessages, main_area(Rect::new(0, 0, 140, 42)))];
        assert_eq!(app.panes.borrow().rectangles(), full);
        chord(&mut app, KeyCode::Char('1'));
        assert_eq!(app.panes.borrow().rectangles(), full);
        assert_eq!(app.input, "keep draft");
        chord(&mut app, KeyCode::Char('3'));
        chord(&mut app, KeyCode::Char('o'));
        assert_ne!(app.panes.borrow().focused_id(), first);
        assert_eq!(app.active_pane, ActivePane::ChatMessages);
        let mut panes = app.panes.borrow_mut();
        let focused = panes.focused_id();
        panes.action(Action::MoveFocused { direction: Direction::Horizontal, towards: Towards::Start, scope: MoveScope::Window });
        assert_eq!(panes.focused_id(), focused);
    }

    #[test]
    fn resize_changes_geometry_and_last_view_cannot_close() {
        let mut app = app();
        let before = app.panes.borrow().rect(ActivePane::ChatMessages);
        execute_command(&mut app, "shrink-window");
        prepare(&app, Rect::new(0, 0, 140, 42));
        assert!(app.panes.borrow().rect(ActivePane::ChatMessages).height < before.height);
        let mut panes = app.panes.borrow_mut();
        while panes.views.len() > 1 { panes.close().unwrap(); }
        assert!(panes.close().is_err());
        assert_eq!(panes.views.len(), 1);
    }
    #[test]
    fn control_x_with_shift_or_caps_lock_starts_prefix_without_closing_a_view() {
        for code in [KeyCode::Char('x'), KeyCode::Char('X')] {
            for modifiers in [KeyModifiers::CONTROL, KeyModifiers::CONTROL | KeyModifiers::SHIFT] {
                let mut app = app();
                app.input = "keep draft".into();
                let count = app.panes.borrow().views.len();
                assert!(key(&mut app, KeyEvent::new(code, modifiers)));
                assert!(app.panes.borrow().prefix);
                assert_eq!(app.panes.borrow().views.len(), count);
                assert_eq!(app.input, "keep draft");
                assert!(!app.should_quit);
                assert!(key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
                assert!(!app.should_quit);
            }
        }
    }

    #[test]
    fn prefix_consumes_commands_cancels_and_leaves_readline_and_modals_alone() {
        let mut app = app();
        app.active_pane = ActivePane::ChatInput;
        app.input = "untouched".into();
        assert!(!key(&mut app, KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)));
        assert!(crate::emacs::handle_emacs_key(&mut app, &KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL), false));
        chord(&mut app, KeyCode::Char('?'));
        assert!(app.status_message.contains("Undefined"));
        assert_eq!(app.input, "untouched");
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 42)).unwrap();
        terminal.draw(|frame| crate::ui::render(frame, &mut app)).unwrap();
        let screen: String = terminal.backend().buffer().content.iter().map(|cell| cell.symbol()).collect();
        assert!(screen.contains("C-x:"), "Pending window prefix must be visible");
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL)));
        assert!(!app.panes.borrow().prefix);
        assert!(!app.should_quit);
        app.show_vaults = true;
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert!(key(&mut app, KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));
        assert!(!app.panes.borrow().prefix);
        assert!(app.should_quit);
    }
    #[test]
    fn tiny_terminals_keep_focused_view_and_restore_without_overlap() {
        let mut app = app();
        chord(&mut app, KeyCode::Char('2'));
        let original = app.panes.borrow().rectangles().to_vec();
        for (width, height) in [(0, 0), (1, 1), (20, 5), (59, 40), (80, 24), (140, 42)] {
            let area = Rect::new(0, 0, width, height);
            prepare(&app, area);
            let panes = app.panes.borrow();
            for (i, (_, rect)) in panes.rectangles().iter().enumerate() {
                if rect.is_empty() { continue; }
                assert!(area.contains((rect.x, rect.y).into()));
                assert!(rect.right() <= width && rect.bottom() <= height);
                for (_, other) in &panes.rectangles()[i + 1..] { assert!(!rect.intersects(*other)); }
            }
            if width < 60 || height < 12 { assert_eq!(panes.rectangles().len(), 1); }
        }
        assert_eq!(app.panes.borrow().rectangles(), original);
    }
}

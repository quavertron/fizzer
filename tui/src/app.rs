use crate::api::{AgentItem, CascadeClient, ChannelItem, ChatMessage};
use std::collections::HashSet;
use unicode_width::UnicodeWidthChar;

pub const HEADER_HEIGHT: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivePane {
    ChatSelector,
    ChatMessages,
    ChatInput,
    Agents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSettingsField {
    Model,
    ReasoningEffort,
    PriorityServiceTier,
    Orchestrator,
    ReplyToEveryMessage,
    TaggableByAgents,
    PingableByOthers,
    Yolo,
    Save,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPreset {
    pub id: &'static str,
    pub label: &'static str,
}

pub fn agent_model_presets(agent_id: &str) -> &'static [ModelPreset] {
    match agent_id {
        "claude-code" => &[
            ModelPreset { id: "claude-fable-5", label: "Claude Fable 5" },
            ModelPreset { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
            ModelPreset { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
            ModelPreset { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
        ],
        "codex" => &[
            ModelPreset { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            ModelPreset { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
            ModelPreset { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
            ModelPreset { id: "gpt-5.5", label: "GPT-5.5" },
            ModelPreset { id: "gpt-5.4", label: "GPT-5.4" },
            ModelPreset { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        ],
        "grok" => &[
            ModelPreset { id: "grok-4.5", label: "Grok 4.5" },
            ModelPreset { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast" },
        ],
        "antigravity" => &[
            ModelPreset { id: "flash_lite", label: "Gemini Flash Lite (tier)" },
            ModelPreset { id: "flash", label: "Gemini Flash (tier)" },
            ModelPreset { id: "pro", label: "Gemini Pro (tier)" },
            ModelPreset { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
            ModelPreset { id: "gemini-3.5-flash-extra-low", label: "Gemini 3.5 Flash (Low)" },
            ModelPreset { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Medium)" },
            ModelPreset { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)" },
            ModelPreset { id: "gemini-3-flash", label: "Gemini 3 Flash" },
            ModelPreset { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
            ModelPreset { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
            ModelPreset { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
            ModelPreset { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
            ModelPreset { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            ModelPreset { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
            ModelPreset { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
            ModelPreset { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
        ],
        "copilot" => &[
            ModelPreset { id: "auto", label: "Auto" },
            ModelPreset { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
            ModelPreset { id: "gpt-5.2", label: "GPT-5.2" },
        ],
        "hermes" => &[
            ModelPreset { id: "z-ai/glm-5.2", label: "GLM 5.2 (Hermes default)" },
            ModelPreset { id: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash 0731" },
            ModelPreset { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
            ModelPreset { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
            ModelPreset { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
            ModelPreset { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
            ModelPreset { id: "openai/gpt-5.5", label: "GPT-5.5" },
            ModelPreset { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
            ModelPreset { id: "x-ai/grok-4.5", label: "Grok 4.5" },
            ModelPreset { id: "moonshotai/kimi-k3", label: "Kimi K3" },
            ModelPreset { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max" },
        ],
        "omp" => &[
            ModelPreset { id: "openai-codex/gpt-5.6-sol", label: "Codex · GPT-5.6 Sol" },
            ModelPreset { id: "openai-codex/gpt-5.6-terra", label: "Codex · GPT-5.6 Terra" },
            ModelPreset { id: "openai-codex/gpt-5.6-luna", label: "Codex · GPT-5.6 Luna" },
            ModelPreset { id: "openai-codex/gpt-5.5", label: "Codex · GPT-5.5" },
            ModelPreset { id: "openai-codex/gpt-5.4", label: "Codex · GPT-5.4" },
            ModelPreset { id: "anthropic/claude-sonnet-5", label: "Claude Code · Sonnet 5" },
            ModelPreset { id: "anthropic/claude-opus-4-8", label: "Claude Code · Opus 4.8" },
        ],
        _ => &[],
    }
}

#[derive(Debug, Clone)]
pub struct AgentSettingsState {
    pub agent_idx: usize,
    pub agent: AgentItem,
    pub selected_field: AgentSettingsField,
    pub model_choice_idx: usize,
    pub editing_custom_model: bool,
    pub custom_model_input: String,
    pub error_message: Option<String>,
}

impl AgentSettingsState {
    pub fn new(agent_idx: usize, agent: AgentItem) -> Self {
        let presets = agent_model_presets(&agent.agent_id);
        let cur_model = agent.model.trim();

        let (model_choice_idx, custom_model_input) = if cur_model.is_empty() {
            (0, String::new())
        } else if let Some(pos) = presets.iter().position(|p| p.id == cur_model) {
            (1 + pos, String::new())
        } else {
            (1 + presets.len(), cur_model.to_string())
        };

        Self {
            agent_idx,
            agent,
            selected_field: AgentSettingsField::Model,
            model_choice_idx,
            editing_custom_model: false,
            custom_model_input,
            error_message: None,
        }
    }

    pub fn is_custom_selected(&self) -> bool {
        let presets = agent_model_presets(&self.agent.agent_id);
        self.model_choice_idx == 1 + presets.len()
    }

    pub fn sync_model_from_choice(&mut self) {
        let presets = agent_model_presets(&self.agent.agent_id);
        if self.model_choice_idx == 0 {
            self.agent.model.clear();
        } else if self.model_choice_idx <= presets.len() {
            self.agent.model = presets[self.model_choice_idx - 1].id.to_string();
        } else {
            self.agent.model = self.custom_model_input.trim().to_string();
        }
    }

    pub fn cycle_model(&mut self, forward: bool) {
        let presets = agent_model_presets(&self.agent.agent_id);
        let total_choices = 1 + presets.len() + 1;

        if forward {
            self.model_choice_idx = (self.model_choice_idx + 1) % total_choices;
        } else if self.model_choice_idx == 0 {
            self.model_choice_idx = total_choices - 1;
        } else {
            self.model_choice_idx -= 1;
        }

        self.editing_custom_model = false;
        self.sync_model_from_choice();
    }

    pub fn current_model_display(&self) -> (String, &'static str) {
        let presets = agent_model_presets(&self.agent.agent_id);
        if self.model_choice_idx == 0 {
            ("Default (CLI)".to_string(), "Default CLI model")
        } else if self.model_choice_idx <= presets.len() {
            let p = &presets[self.model_choice_idx - 1];
            (format!("{} [{}]", p.label, p.id), p.id)
        } else if self.editing_custom_model {
            (format!("Custom: {}▌", self.custom_model_input), "Custom model ID")
        } else if self.custom_model_input.is_empty() {
            ("Custom model ID...".to_string(), "Custom model ID")
        } else {
            (format!("Custom: {}", self.custom_model_input), "Custom model ID")
        }
    }

    pub fn fields(&self) -> Vec<AgentSettingsField> {
        let is_codex = self.agent.agent_id == "codex";
        let is_claude = self.agent.agent_id == "claude-code";
        let mut list = vec![AgentSettingsField::Model];
        if is_codex || is_claude {
            list.push(AgentSettingsField::ReasoningEffort);
        }
        if is_codex {
            list.push(AgentSettingsField::PriorityServiceTier);
        }
        list.push(AgentSettingsField::Orchestrator);
        list.push(AgentSettingsField::ReplyToEveryMessage);
        list.push(AgentSettingsField::TaggableByAgents);
        list.push(AgentSettingsField::PingableByOthers);
        list.push(AgentSettingsField::Yolo);
        list.push(AgentSettingsField::Save);
        list.push(AgentSettingsField::Cancel);
        list
    }

    pub fn next_field(&mut self) {
        if self.editing_custom_model {
            return;
        }
        let fields = self.fields();
        if let Some(pos) = fields.iter().position(|f| *f == self.selected_field) {
            self.selected_field = fields[(pos + 1) % fields.len()];
        }
    }

    pub fn prev_field(&mut self) {
        if self.editing_custom_model {
            return;
        }
        let fields = self.fields();
        if let Some(pos) = fields.iter().position(|f| *f == self.selected_field) {
            if pos == 0 {
                self.selected_field = fields[fields.len() - 1];
            } else {
                self.selected_field = fields[pos - 1];
            }
        }
    }

    pub fn toggle_or_action(&mut self) -> Option<bool> {
        match self.selected_field {
            AgentSettingsField::Model => {
                if self.is_custom_selected() {
                    self.editing_custom_model = !self.editing_custom_model;
                    if !self.editing_custom_model {
                        self.sync_model_from_choice();
                    }
                } else {
                    self.cycle_model(true);
                }
                None
            }
            AgentSettingsField::ReasoningEffort => {
                self.cycle_reasoning(true);
                None
            }
            AgentSettingsField::PriorityServiceTier => {
                self.agent.priority_service_tier = !self.agent.priority_service_tier;
                None
            }
            AgentSettingsField::Orchestrator => {
                self.agent.orchestrator = !self.agent.orchestrator;
                if self.agent.orchestrator {
                    self.agent.reply_to_every_message = true;
                }
                None
            }
            AgentSettingsField::ReplyToEveryMessage => {
                if !self.agent.orchestrator {
                    self.agent.reply_to_every_message = !self.agent.reply_to_every_message;
                }
                None
            }
            AgentSettingsField::TaggableByAgents => {
                self.agent.taggable_by_agents = !self.agent.taggable_by_agents;
                None
            }
            AgentSettingsField::PingableByOthers => {
                self.agent.pingable_by_others = !self.agent.pingable_by_others;
                None
            }
            AgentSettingsField::Yolo => {
                self.agent.yolo = !self.agent.yolo;
                None
            }
            AgentSettingsField::Save => Some(true),
            AgentSettingsField::Cancel => Some(false),
        }
    }

    pub fn cycle_reasoning(&mut self, forward: bool) {
        let is_codex = self.agent.agent_id == "codex";
        let options: &[&str] = if is_codex {
            &["", "low", "medium", "high", "xhigh", "max", "ultra"]
        } else {
            &["", "low", "medium", "high", "xhigh", "max"]
        };
        let cur = self.agent.reasoning_effort.as_str();
        let idx = options.iter().position(|&o| o == cur).unwrap_or(0);
        let next_idx = if forward {
            (idx + 1) % options.len()
        } else if idx == 0 {
            options.len() - 1
        } else {
            idx - 1
        };
        self.agent.reasoning_effort = options[next_idx].to_string();
    }

    pub fn click_row(&mut self, row: usize, col_in_modal: u16) -> Option<bool> {
        let is_codex = self.agent.agent_id == "codex";
        let is_claude = self.agent.agent_id == "claude-code";

        // Row 3: Model
        if row == 3 {
            self.selected_field = AgentSettingsField::Model;
            return self.toggle_or_action();
        }

        let mut cur_row = 4;
        if is_codex || is_claude {
            if row == cur_row {
                self.selected_field = AgentSettingsField::ReasoningEffort;
                return self.toggle_or_action();
            }
            cur_row += 1;
        }

        if is_codex {
            if row == cur_row {
                self.selected_field = AgentSettingsField::PriorityServiceTier;
                return self.toggle_or_action();
            }
            cur_row += 1;
        }

        // Divider: Replies
        cur_row += 1;

        // Orchestrator
        if row == cur_row {
            self.selected_field = AgentSettingsField::Orchestrator;
            return self.toggle_or_action();
        }
        cur_row += 1;

        // Reply to every
        if row == cur_row {
            self.selected_field = AgentSettingsField::ReplyToEveryMessage;
            return self.toggle_or_action();
        }
        cur_row += 1;

        // Divider: Mentions
        cur_row += 1;

        // Taggable
        if row == cur_row {
            self.selected_field = AgentSettingsField::TaggableByAgents;
            return self.toggle_or_action();
        }
        cur_row += 1;

        // Pingable
        if row == cur_row {
            self.selected_field = AgentSettingsField::PingableByOthers;
            return self.toggle_or_action();
        }
        cur_row += 1;

        // Divider: Execution
        cur_row += 1;

        // Yolo
        if row == cur_row {
            self.selected_field = AgentSettingsField::Yolo;
            return self.toggle_or_action();
        }
        cur_row += 1;

        // Blank
        cur_row += 1;

        // Buttons
        if row == cur_row {
            if col_in_modal <= 39 {
                self.selected_field = AgentSettingsField::Save;
                return Some(true);
            } else {
                self.selected_field = AgentSettingsField::Cancel;
                return Some(false);
            }
        }

        None
    }
}

pub struct App {
    pub client: CascadeClient,
    pub active_pane: ActivePane,
    pub vault_id: Option<String>,
    pub vault_name: String,
    pub channels: Vec<ChannelItem>,
    pub selected_channel_idx: usize,
    pub active_channel_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    /// Message currently selected while the chat log pane has focus.
    pub selected_message_idx: usize,
    pub agents: Vec<AgentItem>,
    /// Agent registration or provider IDs with a queued/running session.
    pub active_agent_ids: HashSet<String>,
    /// Monotonic animation frame used by the agents panel termimations.
    pub animation_tick: u64,
    pub selected_agent_idx: usize,
    pub agent_settings_modal: Option<AgentSettingsState>,
    pub show_channels: bool,
    pub show_agents: bool,
    pub input: String,
    pub cursor_pos: usize,
    pub input_scroll_offset: usize,
    pub input_height_override: Option<u16>,
    pub status_message: String,
    pub is_loading: bool,
    pub author: String,
    pub scroll_offset: usize,
    /// Character offset in the flattened chat log. `None` initializes at EOF.
    pub chat_cursor: Option<usize>,
    /// Anchor for a keyboard text selection in the flattened chat log.
    pub chat_selection_anchor: Option<usize>,
    pub should_quit: bool,
    /// Whether the last backend request reached the server. When false the
    /// header shows a `[BACKEND DOWN]` badge; the app never fabricates data.
    pub backend_online: bool,
    /// Best-effort local check for the desktop runner daemon (the process that
    /// answers @mentions). Only meaningful when the runner runs on this machine.
    pub runner_online: bool,
    /// When `Some`, the channels panel is capturing a name for a new channel.
    pub new_channel_name: Option<String>,
    /// Base64 data-URL images staged from clipboard paste, sent with the next message.
    pub pending_images: Vec<String>,
}

impl App {
    pub fn new(client: CascadeClient) -> Self {
        let author = std::env::var("CASCADE_CHAT_AUTHOR")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".to_string());

        Self {
            client,
            active_pane: ActivePane::ChatInput,
            vault_id: None,
            vault_name: "Default Vault".to_string(),
            channels: Vec::new(),
            selected_channel_idx: 0,
            active_channel_id: None,
            messages: Vec::new(),
            selected_message_idx: 0,
            agents: Vec::new(),
            active_agent_ids: HashSet::new(),
            animation_tick: 0,
            selected_agent_idx: 0,
            agent_settings_modal: None,
            show_channels: true,
            show_agents: true,
            input: String::new(),
            cursor_pos: 0,
            input_scroll_offset: 0,
            input_height_override: None,
            status_message: "Initializing Fizzer TUI...".to_string(),
            is_loading: false,
            author,
            scroll_offset: 0,
            chat_cursor: None,
            chat_selection_anchor: None,
            should_quit: false,
            backend_online: true,
            runner_online: false,
            new_channel_name: None,
            pending_images: Vec::new(),
        }
    }

    pub fn open_agent_settings(&mut self) {
        if let Some(agent) = self.agents.get(self.selected_agent_idx).cloned() {
            self.agent_settings_modal = Some(AgentSettingsState::new(self.selected_agent_idx, agent));
        }
    }

    pub fn close_agent_settings(&mut self) {
        self.agent_settings_modal = None;
    }

    pub fn toggle_channels(&mut self) {
        self.show_channels = !self.show_channels;
        if !self.show_channels && self.active_pane == ActivePane::ChatSelector {
            self.active_pane = ActivePane::ChatInput;
        }
        self.status_message = format!("Channels panel {}", if self.show_channels { "visible" } else { "collapsed" });
    }

    pub fn toggle_agents(&mut self) {
        self.show_agents = !self.show_agents;
        if !self.show_agents && self.active_pane == ActivePane::Agents {
            self.active_pane = ActivePane::ChatInput;
        }
        self.status_message = format!("Agents panel {}", if self.show_agents { "visible" } else { "collapsed" });
    }

    pub fn switch_pane(&mut self, is_wide: bool) {
        let can_show_agents = self.show_agents && is_wide;
        let mut order: Vec<ActivePane> = Vec::new();
        if self.show_channels {
            order.push(ActivePane::ChatSelector);
        }
        order.push(ActivePane::ChatMessages);
        order.push(ActivePane::ChatInput);
        if can_show_agents {
            order.push(ActivePane::Agents);
        }

        if order.is_empty() {
            self.active_pane = ActivePane::ChatInput;
            return;
        }

        if let Some(pos) = order.iter().position(|p| *p == self.active_pane) {
            let next = order[(pos + 1) % order.len()];
            if next == ActivePane::ChatMessages && self.active_pane != ActivePane::ChatMessages {
                self.selected_message_idx = self.messages.len().saturating_sub(1);
            }
            self.active_pane = next;
        } else {
            self.active_pane = order[0];
        }
    }


    pub fn next_channel(&mut self) {
        if !self.channels.is_empty() {
            self.selected_channel_idx = (self.selected_channel_idx + 1) % self.channels.len();
        }
    }

    pub fn prev_channel(&mut self) {
        if !self.channels.is_empty() {
            if self.selected_channel_idx == 0 {
                self.selected_channel_idx = self.channels.len() - 1;
            } else {
                self.selected_channel_idx -= 1;
            }
        }
    }

    pub fn activate_selected_channel(&mut self) {
        if let Some(ch) = self.channels.get(self.selected_channel_idx) {
            self.active_channel_id = Some(ch.id.clone());
            self.scroll_offset = 0;
            self.active_pane = ActivePane::ChatInput;
            self.status_message = format!("Switched to #{}", ch.title);
        }
    }

    pub fn scroll_up(&mut self) {
        self.scroll_offset = self.scroll_offset.saturating_add(2);
    }

    pub fn scroll_down(&mut self) {
        self.scroll_offset = self.scroll_offset.saturating_sub(2);
    }

    fn chat_offset(&self, text: &str) -> usize {
        self.chat_cursor.unwrap_or_else(|| text.chars().count()).min(text.chars().count())
    }

    fn set_chat_offset(&mut self, offset: usize, text: &str, extend: bool) {
        let current = self.chat_offset(text);
        if extend {
            self.chat_selection_anchor.get_or_insert(current);
        } else {
            self.chat_selection_anchor = None;
        }
        self.chat_cursor = Some(offset.min(text.chars().count()));
        self.scroll_offset = 0;
    }

    pub fn move_chat_cursor_horizontal(&mut self, text: &str, delta: isize, extend: bool) {
        let current = self.chat_offset(text);
        let next = if delta.is_negative() {
            current.saturating_sub(delta.unsigned_abs())
        } else {
            current.saturating_add(delta as usize).min(text.chars().count())
        };
        self.set_chat_offset(next, text, extend);
    }

    pub fn move_chat_cursor_vertical(&mut self, text: &str, delta: isize, extend: bool) {
        let chars: Vec<char> = text.chars().collect();
        let current = self.chat_offset(text);
        let line_start = chars[..current].iter().rposition(|c| *c == '\n').map_or(0, |i| i + 1);
        let column = current - line_start;
        let line_end = chars[current..].iter().position(|c| *c == '\n').map_or(chars.len(), |i| current + i);
        let target_start = if delta.is_negative() {
            if line_start == 0 { return; }
            let previous_end = line_start - 1;
            chars[..previous_end].iter().rposition(|c| *c == '\n').map_or(0, |i| i + 1)
        } else {
            if line_end == chars.len() { return; }
            line_end + 1
        };
        let target_end = chars[target_start..].iter().position(|c| *c == '\n').map_or(chars.len(), |i| target_start + i);
        self.set_chat_offset(target_start + column.min(target_end - target_start), text, extend);
    }

    pub fn move_chat_cursor_home(&mut self, text: &str, extend: bool) {
        let current = self.chat_offset(text);
        let start = text[..text.char_indices().nth(current).map_or(text.len(), |(i, _)| i)]
            .rfind('\n').map_or(0, |i| i + 1);
        self.set_chat_offset(text[..start].chars().count(), text, extend);
    }

    pub fn move_chat_cursor_end(&mut self, text: &str, extend: bool) {
        let current = self.chat_offset(text);
        let byte = text.char_indices().nth(current).map_or(text.len(), |(i, _)| i);
        let end = text[byte..].find('\n').map_or(text.len(), |i| byte + i);
        self.set_chat_offset(text[..end].chars().count(), text, extend);
    }

    pub fn chat_selection_bounds(&self, text: &str) -> Option<(usize, usize)> {
        let cursor = self.chat_offset(text);
        let anchor = self.chat_selection_anchor?;
        (anchor != cursor).then_some((anchor.min(cursor), anchor.max(cursor)))
    }

    pub fn selected_chat_text(&self, text: &str) -> Option<String> {
        let (start, end) = self.chat_selection_bounds(text)?;
        Some(text.chars().skip(start).take(end - start).collect())
    }

    pub fn select_all_chat(&mut self, text: &str) {
        self.chat_selection_anchor = Some(0);
        self.chat_cursor = Some(text.chars().count());
        self.scroll_offset = 0;
    }

    pub fn select_previous_message(&mut self) {
        if !self.messages.is_empty() {
            self.selected_message_idx = self.selected_message_idx.saturating_sub(1);
        }
    }

    pub fn select_next_message(&mut self) {
        if !self.messages.is_empty() {
            self.selected_message_idx = (self.selected_message_idx + 1).min(self.messages.len() - 1);
        }
    }

    pub fn clamp_message_selection(&mut self) {
        self.selected_message_idx = self
            .selected_message_idx
            .min(self.messages.len().saturating_sub(1));
    }

    pub fn insert_char(&mut self, c: char) {
        let byte_pos = self.byte_index();
        self.input.insert(byte_pos, c);
        self.cursor_pos += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor_pos > 0 {
            let current_pos = self.cursor_pos;
            self.cursor_pos -= 1;
            let byte_pos = self.byte_index();
            let _ = current_pos;
            if byte_pos < self.input.len() {
                self.input.remove(byte_pos);
            }
        }
    }

    pub fn delete(&mut self) {
        let byte_pos = self.byte_index();
        if byte_pos < self.input.len() {
            self.input.remove(byte_pos);
        }
    }

    pub fn clear_line(&mut self) {
        if self.input.is_empty() {
            self.cursor_pos = 0;
            return;
        }

        if !self.input.contains('\n') {
            if self.cursor_pos == 0 {
                self.input.clear();
            } else {
                let chars: Vec<char> = self.input.chars().collect();
                let remaining: String = chars[self.cursor_pos.min(chars.len())..].iter().collect();
                self.input = remaining;
                self.cursor_pos = 0;
            }
            self.input_scroll_offset = 0;
            return;
        }

        let chars: Vec<char> = self.input.chars().collect();
        let cur_pos = self.cursor_pos.min(chars.len());

        let mut line_start = 0;
        for i in (0..cur_pos).rev() {
            if chars[i] == '\n' {
                line_start = i + 1;
                break;
            }
        }

        let mut line_end = chars.len();
        for i in cur_pos..chars.len() {
            if chars[i] == '\n' {
                line_end = i;
                break;
            }
        }

        if cur_pos > line_start {
            let mut new_chars = chars[..line_start].to_vec();
            new_chars.extend_from_slice(&chars[cur_pos..]);
            self.input = new_chars.into_iter().collect();
            self.cursor_pos = line_start;
        } else if line_end > line_start {
            let mut new_chars = chars[..line_start].to_vec();
            new_chars.extend_from_slice(&chars[line_end..]);
            self.input = new_chars.into_iter().collect();
            self.cursor_pos = line_start;
        } else if line_start > 0 {
            let mut new_chars = chars[..line_start - 1].to_vec();
            new_chars.extend_from_slice(&chars[line_start..]);
            self.input = new_chars.into_iter().collect();
            self.cursor_pos = line_start - 1;
        } else {
            self.input.clear();
            self.cursor_pos = 0;
        }
    }

    pub fn delete_word(&mut self) {
        if self.cursor_pos == 0 || self.input.is_empty() {
            return;
        }
        let chars: Vec<char> = self.input.chars().collect();
        let cur = self.cursor_pos.min(chars.len());
        let mut target = cur;

        while target > 0 && chars[target - 1].is_whitespace() && chars[target - 1] != '\n' {
            target -= 1;
        }
        while target > 0 && !chars[target - 1].is_whitespace() {
            target -= 1;
        }

        if target < cur {
            let mut new_chars = chars[..target].to_vec();
            new_chars.extend_from_slice(&chars[cur..]);
            self.input = new_chars.into_iter().collect();
            self.cursor_pos = target;
        }
    }

    pub fn clear_to_end_of_line(&mut self) {
        if self.input.is_empty() {
            return;
        }
        let chars: Vec<char> = self.input.chars().collect();
        let cur = self.cursor_pos.min(chars.len());
        let mut line_end = chars.len();
        for i in cur..chars.len() {
            if chars[i] == '\n' {
                line_end = i;
                break;
            }
        }
        if line_end > cur {
            let mut new_chars = chars[..cur].to_vec();
            new_chars.extend_from_slice(&chars[line_end..]);
            self.input = new_chars.into_iter().collect();
        }
    }

    pub fn move_cursor_left(&mut self) {
        self.cursor_pos = self.cursor_pos.saturating_sub(1);
    }

    pub fn move_cursor_right(&mut self) {
        let char_count = self.input.chars().count();
        if self.cursor_pos < char_count {
            self.cursor_pos += 1;
        }
    }

    pub fn move_cursor_word_left(&mut self) {
        if self.cursor_pos == 0 || self.input.is_empty() {
            return;
        }
        let chars: Vec<char> = self.input.chars().collect();
        let mut target = self.cursor_pos.min(chars.len());

        while target > 0 && chars[target - 1].is_whitespace() && chars[target - 1] != '\n' {
            target -= 1;
        }
        while target > 0 && !chars[target - 1].is_whitespace() {
            target -= 1;
        }
        self.cursor_pos = target;
    }

    pub fn move_cursor_word_right(&mut self) {
        let chars: Vec<char> = self.input.chars().collect();
        let len = chars.len();
        let mut target = self.cursor_pos.min(len);

        while target < len && chars[target].is_whitespace() && chars[target] != '\n' {
            target += 1;
        }
        while target < len && !chars[target].is_whitespace() {
            target += 1;
        }
        self.cursor_pos = target;
    }

    pub fn delete_word_forward(&mut self) {
        let chars: Vec<char> = self.input.chars().collect();
        let len = chars.len();
        if self.cursor_pos >= len || self.input.is_empty() {
            return;
        }
        let cur = self.cursor_pos;
        let mut target = cur;

        while target < len && chars[target].is_whitespace() && chars[target] != '\n' {
            target += 1;
        }
        while target < len && !chars[target].is_whitespace() {
            target += 1;
        }

        if target > cur {
            let mut new_chars = chars[..cur].to_vec();
            new_chars.extend_from_slice(&chars[target..]);
            self.input = new_chars.into_iter().collect();
        }
    }

    pub fn move_cursor_home(&mut self) {
        self.cursor_pos = 0;
    }

    pub fn move_cursor_end(&mut self) {
        self.cursor_pos = self.input.chars().count();
    }

    pub fn cursor_line_col(&self) -> (usize, usize) {
        let mut line = 0;
        let mut col = 0;
        for (i, c) in self.input.chars().enumerate() {
            if i == self.cursor_pos {
                return (line, col);
            }
            if c == '\n' {
                line += 1;
                col = 0;
            } else {
                col += 1;
            }
        }
        (line, col)
    }

    pub fn move_cursor_up_line(&mut self) {
        let (cur_line, cur_col) = self.cursor_line_col();
        if cur_line == 0 {
            self.input_scroll_offset = self.input_scroll_offset.saturating_sub(1);
            return;
        }
        let lines: Vec<&str> = self.input.split('\n').collect();
        let target_line_len = lines[cur_line - 1].chars().count();
        let target_col = cur_col.min(target_line_len);

        let mut idx = 0;
        for l in 0..(cur_line - 1) {
            idx += lines[l].chars().count() + 1;
        }
        idx += target_col;
        self.cursor_pos = idx;

        if cur_line - 1 < self.input_scroll_offset {
            self.input_scroll_offset = cur_line - 1;
        }
    }

    pub fn move_cursor_down_line(&mut self) {
        let (cur_line, cur_col) = self.cursor_line_col();
        let lines: Vec<&str> = self.input.split('\n').collect();
        if cur_line + 1 >= lines.len() {
            self.input_scroll_offset = (self.input_scroll_offset + 1).min(lines.len().saturating_sub(1));
            return;
        }
        let target_line_len = lines[cur_line + 1].chars().count();
        let target_col = cur_col.min(target_line_len);

        let mut idx = 0;
        for l in 0..=cur_line {
            idx += lines[l].chars().count() + 1;
        }
        idx += target_col;
        self.cursor_pos = idx.min(self.input.chars().count());
    }

    pub fn ensure_cursor_visible(&mut self, inner_height: usize) {
        if inner_height == 0 {
            return;
        }
        let (cur_line, _) = self.cursor_line_col();
        if cur_line < self.input_scroll_offset {
            self.input_scroll_offset = cur_line;
        } else if cur_line >= self.input_scroll_offset + inner_height {
            self.input_scroll_offset = cur_line.saturating_sub(inner_height.saturating_sub(1));
        }
    }

    pub fn input_scroll_up(&mut self) {
        self.input_scroll_offset = self.input_scroll_offset.saturating_sub(1);
    }

    pub fn input_scroll_down(&mut self) {
        let total_lines = self.input.split('\n').count();
        if total_lines > 1 {
            self.input_scroll_offset = (self.input_scroll_offset + 1).min(total_lines.saturating_sub(1));
        }
    }

    pub fn input_box_height(&self, total_height: u16) -> u16 {
        self.input_box_height_for_width(total_height, 80)
    }

    pub fn input_box_height_for_width(&self, total_height: u16, total_width: u16) -> u16 {
        let available_for_chat_modality = total_height.saturating_sub(HEADER_HEIGHT + 1);
        let max_height = available_for_chat_modality.saturating_sub(5).max(3);

        if let Some(override_h) = self.input_height_override {
            return override_h.min(max_height).max(3);
        }

        let text_width = total_width.saturating_sub(4).max(1) as usize;
        let line_count = self.visual_input_line_count(text_width).max(1) as u16;
        let desired = line_count + 2;
        desired.min(max_height).max(3)
    }

    pub fn visual_input_line_count(&self, width: usize) -> usize {
        let width = width.max(1);
        self.input
            .split('\n')
            .map(|line| {
                let mut lines = 1;
                let mut column = 0;
                for c in line.chars() {
                    let char_width = c.width().unwrap_or(0);
                    if char_width > 0 && column + char_width > width {
                        lines += 1;
                        column = 0;
                    }
                    column += char_width;
                }
                lines
            })
            .sum::<usize>()
            .max(1)
    }

    pub fn is_input_tall(&self, total_height: u16) -> bool {
        self.input_box_height(total_height) >= 20
    }

    pub fn toggle_input_expand(&mut self, total_height: u16) {
        if self.input_height_override.is_some() {
            self.input_height_override = None;
            self.status_message = "Input composer height: auto".to_string();
        } else {
            let max_height = total_height.saturating_sub(HEADER_HEIGHT + 6).max(20);
            let tall_height = 22.min(max_height).max(20);
            self.input_height_override = Some(tall_height);
            self.status_message = "Input composer expanded".to_string();
        }
    }

    pub fn grow_input_height(&mut self, total_height: u16) {
        let current = self.input_box_height(total_height);
        let max_height = total_height.saturating_sub(HEADER_HEIGHT + 6).max(3);
        let next = (current + 2).min(max_height);
        self.input_height_override = Some(next);
        self.status_message = format!("Input height: {}", next);
    }

    pub fn shrink_input_height(&mut self) {
        let current = self.input_height_override.unwrap_or(3);
        let next = current.saturating_sub(2).max(3);
        self.input_height_override = Some(next);
        self.status_message = format!("Input height: {}", next);
    }

    fn byte_index(&self) -> usize {
        self.input
            .char_indices()
            .map(|(i, _)| i)
            .nth(self.cursor_pos)
            .unwrap_or(self.input.len())
    }

    pub fn active_channel_title(&self) -> &str {
        if let Some(active_id) = &self.active_channel_id {
            if let Some(ch) = self.channels.iter().find(|c| &c.id == active_id) {
                return &ch.title;
            }
        }
        "No channel selected"
    }

    pub fn next_agent(&mut self) {
        if !self.agents.is_empty() {
            self.selected_agent_idx = (self.selected_agent_idx + 1) % self.agents.len();
        }
    }

    pub fn prev_agent(&mut self) {
        if !self.agents.is_empty() {
            if self.selected_agent_idx == 0 {
                self.selected_agent_idx = self.agents.len() - 1;
            } else {
                self.selected_agent_idx -= 1;
            }
        }
    }

    pub fn insert_agent_mention(&mut self) {
        if let Some(agent) = self.agents.get(self.selected_agent_idx) {
            let mention = if !agent.mention.is_empty() {
                format!("@{} ", agent.mention)
            } else {
                format!("@{} ", agent.display_name.to_lowercase())
            };
            self.input.push_str(&mention);
            self.cursor_pos = self.input.chars().count();
            self.active_pane = ActivePane::ChatInput;
            self.status_message = format!("Mentioned {}", agent.display_name);
        }
    }

    pub fn mark_offline(&mut self, message: impl Into<String>) {
        self.backend_online = false;
        self.channels.clear();
        self.messages.clear();
        self.agents.clear();
        self.active_channel_id = None;
        self.status_message = message.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_app() -> App {
        App::new(crate::api::CascadeClient::new("http://127.0.0.1:1".into(), None))
    }

    #[test]
    fn test_word_cursor_movement() {
        let mut app = make_app();
        app.input = "foo   bar  baz".into();
        app.cursor_pos = 0;

        // Move word right
        app.move_cursor_word_right();
        assert_eq!(app.cursor_pos, 3); // after "foo"

        app.move_cursor_word_right();
        assert_eq!(app.cursor_pos, 9); // after "bar"

        app.move_cursor_word_right();
        assert_eq!(app.cursor_pos, 14); // after "baz"

        // Move past end stays at end
        app.move_cursor_word_right();
        assert_eq!(app.cursor_pos, 14);

        // Move word left
        app.move_cursor_word_left();
        assert_eq!(app.cursor_pos, 11); // start of "baz"

        app.move_cursor_word_left();
        assert_eq!(app.cursor_pos, 6); // start of "bar"

        app.move_cursor_word_left();
        assert_eq!(app.cursor_pos, 0); // start of "foo"

        // Move past start stays at start
        app.move_cursor_word_left();
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn test_delete_word_forward() {
        let mut app = make_app();
        app.input = "one   two three".into();
        app.cursor_pos = 0;

        app.delete_word_forward();
        assert_eq!(app.input, "   two three");
        assert_eq!(app.cursor_pos, 0);

        app.delete_word_forward();
        assert_eq!(app.input, " three");
        assert_eq!(app.cursor_pos, 0);

        app.delete_word_forward();
        assert_eq!(app.input, "");
        assert_eq!(app.cursor_pos, 0);
    }
}

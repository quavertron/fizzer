use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vault {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultsResponse {
    #[serde(default)]
    pub vaults: Vec<Vault>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDetail {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDetailResponse {
    pub note: NoteDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesResponse {
    #[serde(default)]
    pub notes: Vec<NoteSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelItem {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub body: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    /// Data-URL images attached to the message. The list API strips heavy
    /// data-URLs and instead sets `has_images`, so use `has_image()`.
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(rename = "hasImages", default)]
    pub has_images: bool,
}

impl ChatMessage {
    /// Whether this message carries any image, whether hydrated or stripped by the list API.
    pub fn has_image(&self) -> bool {
        self.has_images || !self.images.is_empty()
    }
}

/// Keep a burst compact, but never fold a later conversational turn into it.
/// Mirrors the Electron frontend's `canGroupChatMessages` (client/src/chat/shared.ts).
const CHAT_MESSAGE_GROUP_WINDOW_MS: i64 = 90_000;

pub fn continues_chat_group(prev: &ChatMessage, next: &ChatMessage) -> bool {
    if prev.agent_id != next.agent_id || prev.author.trim() != next.author.trim() {
        return false;
    }
    let prev_date = prev.created_at.split('T').next().unwrap_or("");
    let next_date = next.created_at.split('T').next().unwrap_or("");
    if prev_date.is_empty() || prev_date != next_date {
        return false;
    }
    match (parse_iso8601_ms(&prev.created_at), parse_iso8601_ms(&next.created_at)) {
        (Some(a), Some(b)) => {
            let elapsed = b - a;
            (0..=CHAT_MESSAGE_GROUP_WINDOW_MS).contains(&elapsed)
        }
        _ => false,
    }
}

/// Parses an ISO-8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SS[.fff]Z") into
/// milliseconds since the epoch, without pulling in a datetime crate.
fn parse_iso8601_ms(raw: &str) -> Option<i64> {
    let (date, time) = raw.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;

    let time_clean = time.trim_end_matches('Z');
    let (hms, frac) = time_clean.split_once('.').unwrap_or((time_clean, "0"));
    let mut time_parts = hms.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;
    let millis: i64 = format!("{:0<3}", frac).chars().take(3).collect::<String>().parse().ok()?;

    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis)
}

/// Howard Hinnant's `days_from_civil`: proleptic-Gregorian day count since the epoch.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesResponse {
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: serde_json::Value,
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    #[serde(default)]
    pub authenticated: bool,
    pub user: Option<SessionUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageResponse {
    pub message: ChatMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentItem {
    pub id: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(default)]
    pub mention: String,
    #[serde(rename = "agentId", default)]
    pub agent_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub orchestrator: bool,
    #[serde(rename = "vaultAgentId", default)]
    pub vault_agent_id: Option<String>,
    #[serde(rename = "ownerUserId", default)]
    pub owner_user_id: Option<u64>,
    #[serde(rename = "reasoningEffort", default)]
    pub reasoning_effort: String,
    #[serde(rename = "priorityServiceTier", default)]
    pub priority_service_tier: bool,
    #[serde(rename = "replyToEveryMessage", default)]
    pub reply_to_every_message: bool,
    #[serde(rename = "taggableByAgents", default)]
    pub taggable_by_agents: bool,
    #[serde(rename = "pingableByOthers", default)]
    pub pingable_by_others: bool,
    #[serde(default)]
    pub yolo: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(rename = "conversationId", default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelAgentsResponse {
    #[serde(default)]
    pub agents: Vec<AgentItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub mention: String,
    #[serde(rename = "registration_id", alias = "registrationId", default)]
    pub registration_id: Option<String>,
    #[serde(rename = "channel_id", alias = "channelId", default)]
    pub channel_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSessionsResponse {
    #[serde(default)]
    pub sessions: Vec<ActiveSession>,
}

#[derive(Debug, Clone)]
pub struct CascadeClient {
    pub base_url: String,
    pub token: Option<String>,
    client: reqwest::Client,
}

impl CascadeClient {
    pub fn new(base_url: String, token: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            client,
        }
    }

    fn auth_header(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.token {
            if !token.is_empty() {
                return req.header("Authorization", format!("Bearer {}", token));
            }
        }
        req
    }

    pub async fn check_session(&self) -> Result<Option<String>, String> {
        let url = format!("{}/api/session", self.base_url);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if res.status().is_success() {
            if let Ok(sess) = res.json::<SessionResponse>().await {
                if sess.authenticated {
                    return Ok(sess.user.map(|u| u.username));
                }
            }
        }
        Ok(None)
    }

    pub async fn fetch_vaults(&self) -> Result<Vec<Vault>, String> {
        let url = format!("{}/api/vaults", self.base_url);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("GET /api/vaults returned {}", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<VaultsResponse>(&body) {
            return Ok(resp.vaults);
        }
        if let Ok(vaults) = serde_json::from_str::<Vec<Vault>>(&body) {
            return Ok(vaults);
        }

        Err("Failed to parse vaults response".into())
    }

    pub async fn fetch_channels(&self, vault_id: &str) -> Result<Vec<ChannelItem>, String> {
        const CHAT_NOTE_MARKER: &str = "cascade://chat-channel";
        Ok(self
            .fetch_notes(vault_id)
            .await?
            .into_iter()
            .filter(|n| n.content_preview.trim().starts_with(CHAT_NOTE_MARKER))
            .map(|n| ChannelItem {
                id: n.id,
                title: if n.title.is_empty() { "untitled-chat".to_string() } else { n.title },
            })
            .collect())
    }

    pub async fn fetch_notes(&self, vault_id: &str) -> Result<Vec<NoteSummary>, String> {
        let url = format!("{}/api/vaults/{}/notes", self.base_url, vault_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("GET {} returned {}", url, res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        let notes = if let Ok(resp) = serde_json::from_str::<NotesResponse>(&body) {
            resp.notes
        } else if let Ok(list) = serde_json::from_str::<Vec<NoteSummary>>(&body) {
            list
        } else {
            Vec::new()
        };

        Ok(notes)
    }

    pub async fn fetch_note(&self, note_id: &str) -> Result<NoteDetail, String> {
        let url = format!("{}/api/notes/{}", self.base_url, note_id);
        let res = self
            .auth_header(self.client.get(&url))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("GET {} returned {}", url, res.status()));
        }
        let body = res.text().await.map_err(|e| e.to_string())?;
        serde_json::from_str::<NoteDetailResponse>(&body)
            .map(|response| response.note)
            .map_err(|e| format!("Failed to parse note response: {}", e))
    }

    pub async fn update_note(&self, note_id: &str, content: &str) -> Result<(), String> {
        let url = format!("{}/api/notes/{}", self.base_url, note_id);
        let res = self
            .auth_header(self.client.put(&url).json(&serde_json::json!({ "content": content })))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("PUT {} returned {}", url, res.status()));
        }
        Ok(())
    }

    pub async fn fetch_messages(&self, vault_id: &str, channel_id: &str) -> Result<Vec<ChatMessage>, String> {
        let url = format!("{}/api/vaults/{}/channels/{}/messages?limit=60", self.base_url, vault_id, channel_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("GET {} returned {}", url, res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<MessagesResponse>(&body) {
            return Ok(resp.messages);
        }
        if let Ok(messages) = serde_json::from_str::<Vec<ChatMessage>>(&body) {
            return Ok(messages);
        }

        Ok(Vec::new())
    }

    pub async fn fetch_agents(&self, vault_id: &str, channel_id: &str) -> Result<Vec<AgentItem>, String> {
        let url = format!("{}/api/vaults/{}/channels/{}/agents", self.base_url, vault_id, channel_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("GET {} returned {}", url, res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<ChannelAgentsResponse>(&body) {
            return Ok(resp.agents);
        }
        if let Ok(agents) = serde_json::from_str::<Vec<AgentItem>>(&body) {
            return Ok(agents);
        }

        Ok(Vec::new())
    }

    pub async fn fetch_active_sessions(&self, vault_id: &str) -> Result<Vec<ActiveSession>, String> {
        let url = format!("{}/api/vaults/{}/active-sessions", self.base_url, vault_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("GET {} returned {}", url, res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<ActiveSessionsResponse>(&body) {
            return Ok(resp.sessions);
        }
        if let Ok(sessions) = serde_json::from_str::<Vec<ActiveSession>>(&body) {
            return Ok(sessions);
        }

        Ok(Vec::new())
    }

    pub async fn send_message(
        &self,
        vault_id: &str,
        channel_id: &str,
        body: &str,
        images: &[String],
    ) -> Result<ChatMessage, String> {
        let url = format!("{}/api/vaults/{}/channels/{}/messages", self.base_url, vault_id, channel_id);
        let random_id = format!("msg-tui-{}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(), rand_suffix());

        let mut payload = serde_json::json!({
            "id": random_id,
            "body": body,
        });
        if !images.is_empty() {
            payload["images"] = serde_json::json!(images);
        }

        let req = self.auth_header(self.client.post(&url).json(&payload));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("POST {} returned {} ({})", url, status, err));
        }

        if let Ok(resp) = res.json::<CreateMessageResponse>().await {
            return Ok(resp.message);
        }

        Ok(ChatMessage {
            id: random_id,
            author: "me".to_string(),
            body: body.to_string(),
            created_at: "Just now".to_string(),
            agent_id: None,
            images: images.to_vec(),
            has_images: !images.is_empty(),
        })
    }

    pub async fn update_agent(
        &self,
        vault_id: &str,
        channel_id: &str,
        agent: &AgentItem,
    ) -> Result<AgentItem, String> {
        let url = format!("{}/api/vaults/{}/channels/{}/agents", self.base_url, vault_id, channel_id);
        let payload = serde_json::json!({
            "id": agent.id,
            "vaultAgentId": agent.vault_agent_id,
            "agentId": agent.agent_id,
            "displayName": agent.display_name,
            "color": agent.color,
            "model": agent.model,
            "reasoningEffort": agent.reasoning_effort,
            "priorityServiceTier": agent.priority_service_tier,
            "orchestrator": agent.orchestrator,
            "replyToEveryMessage": agent.reply_to_every_message,
            "taggableByAgents": agent.taggable_by_agents,
            "pingableByOthers": agent.pingable_by_others,
            "yolo": agent.yolo,
            "mention": agent.mention,
        });

        let req = self.auth_header(self.client.put(&url).json(&payload));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("PUT {} returned {} ({})", url, status, err));
        }

        #[derive(Deserialize)]
        struct PutAgentResponse {
            registration: AgentItem,
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<PutAgentResponse>(&body) {
            return Ok(resp.registration);
        }
        if let Ok(item) = serde_json::from_str::<AgentItem>(&body) {
            return Ok(item);
        }

        Err("Failed to parse updated agent response".to_string())
    }

    /// Create a chat channel. Channels are notes tagged with the chat marker;
    /// the backend returns the created note, which we surface as a `ChannelItem`.
    pub async fn create_channel(&self, vault_id: &str, title: &str) -> Result<ChannelItem, String> {
        let url = format!("{}/api/vaults/{}/notes", self.base_url, vault_id);
        let payload = serde_json::json!({
            "title": title,
            "content": "cascade://chat-channel",
        });

        let req = self.auth_header(self.client.post(&url).json(&payload));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("POST {} returned {} ({})", url, status, err));
        }

        #[derive(Deserialize)]
        struct CreateNoteResponse {
            note: NoteSummary,
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<CreateNoteResponse>(&body) {
            let title = if resp.note.title.is_empty() {
                "untitled-chat".to_string()
            } else {
                resp.note.title
            };
            return Ok(ChannelItem { id: resp.note.id, title });
        }

        Err("Failed to parse created channel response".to_string())
    }

    pub async fn rename_channel(&self, channel_id: &str, title: &str) -> Result<ChannelItem, String> {
        let url = format!("{}/api/notes/{}/rename", self.base_url, channel_id);
        let req = self.auth_header(self.client.post(&url).json(&serde_json::json!({ "title": title })));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("POST {} returned {} ({})", url, status, err));
        }

        #[derive(Deserialize)]
        struct RenameNoteResponse {
            note: NoteSummary,
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        let response = serde_json::from_str::<RenameNoteResponse>(&body)
            .map_err(|e| format!("Failed to parse renamed channel response: {}", e))?;
        Ok(ChannelItem {
            id: response.note.id,
            title: if response.note.title.is_empty() {
                "untitled-chat".to_string()
            } else {
                response.note.title
            },
        })
    }
}

pub fn format_timestamp(raw: &str) -> String {
    if let Some((_, time_part)) = raw.split_once('T') {
        let time_clean = time_part.trim_end_matches('Z');
        // Drop any fractional-seconds suffix, keep HH:MM:SS.
        let hms = time_clean.split('.').next().unwrap_or(time_clean);
        if hms.len() >= 8 {
            return hms[..8].to_string();
        }
        if hms.len() >= 5 {
            return hms[..5].to_string();
        }
    }
    raw.to_string()
}

fn rand_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:06x}", nanos % 0xffffff)
}

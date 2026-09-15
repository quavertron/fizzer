use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vault {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

impl Vault {
    #[allow(dead_code)]
    pub fn is_remote(&self) -> bool {
        self.origin.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptInviteResponse {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(rename = "alreadyMember", default)]
    pub already_member: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultsResponse {
    pub vaults: Vec<Vault>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultMember {
    #[serde(rename = "userId", alias = "id", default)]
    pub user_id: serde_json::Value,
    #[serde(default)]
    pub username: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMembersResponse {
    pub members: Vec<VaultMember>,
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
    pub notes: Vec<NoteSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelItem {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub body: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(alias = "agent_id", rename = "agentId", default)]
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
    pub messages: Vec<ChatMessage>,
    #[serde(rename = "beforeSeq", default)]
    pub before_seq: Option<i64>,
    #[serde(rename = "hasMore", default)]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: serde_json::Value,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_user_color")]
    pub color: String,
}

fn default_user_color() -> String {
    "FFFFFF".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub authenticated: bool,
    pub user: Option<SessionUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageResponse {
    pub message: ChatMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub agents: Vec<AgentItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub mention: String,
    #[serde(rename = "registration_id", alias = "registrationId", default)]
    pub registration_id: Option<String>,
    #[serde(rename = "channel_id", alias = "channelId", default)]
    pub channel_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSessionsResponse {
    pub sessions: Vec<ActiveSession>,
}

#[derive(Debug, Clone)]
pub struct CascadeClient {
    pub base_url: String,
    pub token: Option<String>,
    client: reqwest::Client,
}

fn format_status_error(method: &str, endpoint: &str, status: reqwest::StatusCode) -> String {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        "Rate limited (429: Too Many Requests)".to_string()
    } else {
        format!("{} {} returned {}", method, endpoint, status)
    }
}

fn format_status_body_error(
    method: &str,
    endpoint: &str,
    status: reqwest::StatusCode,
    err_body: &str,
) -> String {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        "Rate limited (429: Too Many Requests)".to_string()
    } else {
        let trimmed = err_body.trim();
        if trimmed.is_empty() {
            format!("{} {} returned {}", method, endpoint, status)
        } else {
            format!("{} {} returned {} ({})", method, endpoint, status, trimmed)
        }
    }
}

impl CascadeClient {
    pub fn new(base_url: String, token: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            client,
        }
    }

    pub fn is_local_instance(&self) -> bool {
        let origin = self.base_url.trim().to_ascii_lowercase();
        let authority = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .unwrap_or(&origin)
            .split('/')
            .next()
            .unwrap_or_default()
            .rsplit('@')
            .next()
            .unwrap_or_default();

        authority == "localhost"
            || authority.starts_with("localhost:")
            || authority == "127.0.0.1"
            || authority.starts_with("127.0.0.1:")
            || authority == "[::1]"
            || authority.starts_with("[::1]:")
    }

    fn auth_header(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.token {
            if !token.is_empty() {
                return req.header("Authorization", format!("Bearer {}", token));
            }
        }
        req
    }

    pub async fn check_session(&self) -> Result<Option<(String, String)>, String> {
        let url = format!("{}/api/session", self.base_url);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/session", res.status()));
        }
        let sess = res.json::<SessionResponse>().await
            .map_err(|e| format!("Failed to parse session response: {}", e))?;
        Ok(if sess.authenticated { sess.user.map(|u| (u.username, u.color)) } else { None })
    }

    pub async fn fetch_vaults(&self) -> Result<Vec<Vault>, String> {
        let url = format!("{}/api/vaults", self.base_url);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/vaults", res.status()));
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

    pub async fn create_vault(&self, name: &str) -> Result<Vault, String> {
        let url = format!("{}/api/vaults", self.base_url);
        let req = self.auth_header(self.client.post(&url).json(&serde_json::json!({ "name": name })));
        let res = req.send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format_status_body_error("POST", "/api/vaults", res.status(), &res.text().await.unwrap_or_default()));
        }
        let body = res.text().await.map_err(|e| e.to_string())?;
        #[derive(Deserialize)]
        struct Response { vault: Vault }
        serde_json::from_str::<Response>(&body)
            .map(|response| response.vault)
            .map_err(|e| format!("Failed to parse created vault: {}", e))
    }

    pub async fn login_remote(origin: &str, username: &str, password: &str) -> Result<(Self, SessionUser), String> {
        let base_url = crate::normalize_remote_origin(origin)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        let res = client
            .post(format!("{}/api/auth/login", base_url))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format_status_body_error("POST", "/api/auth/login", status, &body));
        }
        #[derive(Deserialize)]
        struct Response { token: String, user: SessionUser }
        let response = serde_json::from_str::<Response>(&body)
            .map_err(|e| format!("Failed to parse remote login response: {}", e))?;
        Ok((Self::new(base_url, Some(response.token)), response.user))
    }

    pub async fn accept_vault_invite(&self, token: &str) -> Result<AcceptInviteResponse, String> {
        let url = format!("{}/api/vault-invites/{}/accept", self.base_url, token);
        let req = self.auth_header(self.client.post(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format_status_body_error("POST", "/api/vault-invites/:token/accept", status, &body));
        }
        serde_json::from_str::<AcceptInviteResponse>(&body)
            .map_err(|e| format!("Failed to parse accept invite response: {}", e))
    }

    pub async fn fetch_vault_members(&self, vault_id: &str) -> Result<Vec<VaultMember>, String> {
        let url = format!("{}/api/vaults/{}/members", self.base_url, vault_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/vaults/:id/members", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<VaultMembersResponse>(&body) {
            return Ok(resp.members);
        }
        serde_json::from_str::<Vec<VaultMember>>(&body)
            .map_err(|e| format!("Failed to parse vault members response: {}", e))
    }

    pub async fn update_profile(&self, display_name: &str, color: &str) -> Result<VaultMember, String> {
        let url = format!("{}/api/me/profile", self.base_url);
        let req = self.auth_header(self.client.put(&url).json(&serde_json::json!({
            "displayName": display_name,
            "avatarUrl": "",
            "color": color,
        })));
        let res = req.send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format_status_error("PUT", "/api/me/profile", res.status()));
        }
        let body = res.text().await.map_err(|e| e.to_string())?;
        #[derive(Deserialize)]
        struct ProfileResponse {
            user: VaultMember,
        }
        serde_json::from_str::<ProfileResponse>(&body)
            .map(|response| response.user)
            .map_err(|e| format!("Failed to parse updated profile: {}", e))
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
            return Err(format_status_error("GET", "/api/notes", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<NotesResponse>(&body) {
            return Ok(resp.notes);
        }
        serde_json::from_str::<Vec<NoteSummary>>(&body)
            .map_err(|e| format!("Failed to parse notes response: {}", e))
    }

    pub async fn fetch_note(&self, note_id: &str) -> Result<NoteDetail, String> {
        let url = format!("{}/api/notes/{}", self.base_url, note_id);
        let res = self
            .auth_header(self.client.get(&url))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/notes", res.status()));
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
            return Err(format_status_error("PUT", "/api/notes", res.status()));
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn fetch_messages(&self, vault_id: &str, channel_id: &str) -> Result<Vec<ChatMessage>, String> {
        self.fetch_message_page(vault_id, channel_id, None).await.map(|page| page.messages)
    }

    pub async fn fetch_message_page(&self, vault_id: &str, channel_id: &str, before: Option<i64>) -> Result<MessagesResponse, String> {
        let limit = if before.is_some() { 20 } else { 8 };
        let mut url = format!("{}/api/vaults/{}/channels/{}/messages?limit={limit}", self.base_url, vault_id, channel_id);
        if let Some(seq) = before { url.push_str(&format!("&beforeSeq={seq}")); }
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/messages", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        match serde_json::from_str::<MessagesResponse>(&body) {
            Ok(resp) => Ok(resp),
            Err(resp_err) => match serde_json::from_str::<Vec<ChatMessage>>(&body) {
                Ok(messages) => Ok(MessagesResponse { messages, before_seq: None, has_more: false }),
                Err(vec_err) => Err(format!(
                    "Failed to parse messages response: {}; as list: {}",
                    resp_err, vec_err
                )),
            },
        }
    }

    pub async fn fetch_agents(&self, vault_id: &str, channel_id: &str) -> Result<Vec<AgentItem>, String> {
        let url = format!("{}/api/vaults/{}/channels/{}/agents", self.base_url, vault_id, channel_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/agents", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<ChannelAgentsResponse>(&body) {
            return Ok(resp.agents);
        }
        if let Ok(agents) = serde_json::from_str::<Vec<AgentItem>>(&body) {
            return Ok(agents);
        }

        Err("Failed to parse agents response".into())
    }

    pub async fn fetch_active_sessions(&self, vault_id: &str) -> Result<Vec<ActiveSession>, String> {
        let url = format!("{}/api/vaults/{}/active-sessions", self.base_url, vault_id);
        let req = self.auth_header(self.client.get(&url));
        let res = req.send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format_status_error("GET", "/api/active-sessions", res.status()));
        }

        let body = res.text().await.map_err(|e| e.to_string())?;
        if let Ok(resp) = serde_json::from_str::<ActiveSessionsResponse>(&body) {
            return Ok(resp.sessions);
        }
        if let Ok(sessions) = serde_json::from_str::<Vec<ActiveSession>>(&body) {
            return Ok(sessions);
        }

        Err("Failed to parse active sessions response".into())
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
            return Err(format_status_body_error("POST", "/api/messages", status, &err));
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
            return Err(format_status_body_error("PUT", "/api/agents", status, &err));
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
            return Err(format_status_body_error("POST", "/api/notes", status, &err));
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
            return Err(format_status_body_error("POST", "/api/notes/rename", status, &err));
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(status: u16, body: &str) -> CascadeClient {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = CascadeClient::new(format!("http://{}", listener.local_addr().unwrap()), None);
        let response = format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        client
    }

    #[test]
    fn identifies_loopback_instances_as_local() {
        for origin in [
            "http://localhost",
            "https://localhost:4000/",
            "http://127.0.0.1:4000",
            "http://[::1]:4000",
        ] {
            assert!(CascadeClient::new(origin.into(), None).is_local_instance(), "{origin}");
        }
        for origin in ["https://cscd.online", "http://192.168.1.20:4000"] {
            assert!(
                !CascadeClient::new(origin.into(), None).is_local_instance(),
                "{origin}"
            );
        }
    }

    #[tokio::test]
    async fn history_negotiates_and_decodes_gzip() {
        // gzip-encoded {"messages":[]}.
        let body: &[u8] = &[31,139,8,0,0,0,0,0,0,19,171,86,202,77,45,46,78,76,79,45,86,178,138,142,173,5,0,145,195,48,0,15,0,0,0];
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = CascadeClient::new(format!("http://{}", listener.local_addr().unwrap()), None);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(request.lines().any(|line| line.starts_with("accept-encoding:") && line.contains("gzip")));
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        assert!(client.fetch_messages("v", "c").await.unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn malformed_collections_are_errors_instead_of_empty_snapshots() {
        for body in ["not json", "{}", r#"{"error":"backend failure"}"#] {
            assert!(server(200, body).await.fetch_vaults().await.is_err());
            assert!(server(200, body).await.fetch_notes("v").await.is_err());
            assert!(server(200, body).await.fetch_messages("v", "c").await.is_err());
            assert!(server(200, body).await.fetch_agents("v", "c").await.is_err());
            assert!(server(200, body).await.fetch_active_sessions("v").await.is_err());
        }
        assert!(server(200, r#"{"notes":[]}"#).await.fetch_notes("v").await.unwrap().is_empty());
        assert!(server(200, "[]").await.fetch_messages("v", "c").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn session_server_and_parse_errors_are_not_healthy_responses() {
        assert!(server(500, "{}").await.check_session().await.is_err());
        assert!(server(200, "not json").await.check_session().await.is_err());
        assert!(server(200, "{}").await.check_session().await.is_err());
        assert_eq!(server(200, r#"{"authenticated":false}"#).await.check_session().await.unwrap(), None);
        assert_eq!(server(200, r#"{"authenticated":true,"user":{"id":1,"username":"human"}}"#)
            .await.check_session().await.unwrap(), Some(("human".into(), "FFFFFF".into())));
    }

    #[tokio::test]
    async fn user_messages_without_agent_id_deserialize_successfully() {
        let json = r#"{"messages":[{"id":"msg-1","author":"diego","body":"hello","createdAt":"2026-09-09T00:00:00Z"}]}"#;
        let messages = server(200, json).await.fetch_messages("v", "c").await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "msg-1");
        assert_eq!(messages[0].author, "diego");
        assert_eq!(messages[0].body, "hello");
        assert_eq!(messages[0].agent_id, None);
    }
}

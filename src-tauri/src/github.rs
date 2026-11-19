//! GitHub account: sign-in with the OAuth device flow, the token in the operating system's credential
//! store, and the few REST calls the Projects panel needs (repositories, owners, creating a repository).
//!
//! The token never leaves the Rust side: commands and MCP tools only ever see the account's login
//! and name. Git operations get it through `GitHub::token` inside this crate.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Client id of the maintainers' GitHub OAuth App (Device Flow enabled). A client id is public, not
/// a secret, and there is no client secret anywhere: every user signs in with their own account.
const DEFAULT_CLIENT_ID: &str = "Ov23liulC5lI5lRloweb";
/// The client id compiled in: `TESSEL_GITHUB_CLIENT_ID` at build time (the release workflow sets it),
/// otherwise the maintainers' default. A client id set in the app (GitHub dialog → Settings) wins
/// over it; with none at all the dialog offers the personal-access-token sign-in only.
pub const BUILT_IN_CLIENT_ID: Option<&str> = match option_env!("TESSEL_GITHUB_CLIENT_ID") {
  Some(id) if !id.is_empty() => Some(id),
  _ => Some(DEFAULT_CLIENT_ID),
};
/// `repo`: read and write access to the user's public and private repositories (incl. organisation ones).
pub const SCOPES: &str = "repo";

const KEYRING_SERVICE: &str = "Tessel";
const KEYRING_USER: &str = "github-token";
const OAUTH: &str = "https://github.com/login";
const API: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("Tessel/", env!("CARGO_PKG_VERSION"));

/// Where the token lives. The real one is the OS credential store; tests use memory.
pub trait TokenStore: Send + Sync {
  fn get(&self) -> Result<Option<String>, String>;
  fn set(&self, token: &str) -> Result<(), String>;
  fn delete(&self) -> Result<(), String>;
}

/// Windows Credential Manager, macOS Keychain, or the Secret Service on Linux.
pub struct KeyringStore;

impl KeyringStore {
  fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("The credential store is not available: {e}"))
  }
}

impl TokenStore for KeyringStore {
  fn get(&self) -> Result<Option<String>, String> {
    match Self::entry()?.get_password() {
      Ok(token) => Ok(Some(token)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(format!("Could not read the GitHub login from the credential store: {e}")),
    }
  }

  fn set(&self, token: &str) -> Result<(), String> {
    Self::entry()?
      .set_password(token)
      .map_err(|e| format!("Could not store the GitHub login in the credential store: {e}"))
  }

  fn delete(&self) -> Result<(), String> {
    match Self::entry()?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("Could not remove the GitHub login from the credential store: {e}")),
    }
  }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(Mutex<Option<String>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
  fn get(&self) -> Result<Option<String>, String> {
    Ok(self.0.lock().unwrap().clone())
  }
  fn set(&self, token: &str) -> Result<(), String> {
    *self.0.lock().unwrap() = Some(token.to_string());
    Ok(())
  }
  fn delete(&self) -> Result<(), String> {
    *self.0.lock().unwrap() = None;
    Ok(())
  }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
  pub id: u64,
  pub login: String,
  pub name: Option<String>,
  pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
  /// Whether a client id is set, i.e. sign-in is possible at all.
  pub configured: bool,
  /// The client id in use (public; it is no secret).
  pub client_id: Option<String>,
  /// Whether it comes from the app settings rather than the build.
  pub client_id_from_settings: bool,
  pub user: Option<User>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
  /// The code the user types on the verification page.
  pub user_code: String,
  pub verification_uri: String,
  /// Seconds until the code expires.
  pub expires_in: u64,
  #[serde(skip)]
  pub device_code: String,
  /// Seconds between two polls.
  pub interval: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
  pub full_name: String,
  pub name: String,
  pub owner: String,
  pub private: bool,
  pub description: Option<String>,
  pub clone_url: String,
  pub html_url: String,
  pub default_branch: Option<String>,
  pub updated_at: Option<String>,
}

/// What one poll of the device flow said.
#[derive(Debug, PartialEq)]
pub enum Poll {
  Token(String),
  Pending,
  SlowDown,
  Failed(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
  #[serde(default)]
  client_id: Option<String>,
}

struct PendingLogin {
  code: DeviceCode,
  expires_at: Instant,
}

pub struct GitHub {
  settings_file: PathBuf,
  settings: Mutex<Settings>,
  tokens: Box<dyn TokenStore>,
  user: Mutex<Option<User>>,
  pending: Mutex<Option<PendingLogin>>,
  /// Bumped by every start, cancel and logout, so a running poll loop notices it is stale.
  generation: AtomicU64,
  http: reqwest::Client,
}

impl GitHub {
  pub fn new(settings_file: PathBuf, tokens: Box<dyn TokenStore>) -> Self {
    let settings = std::fs::read(&settings_file)
      .ok()
      .and_then(|bytes| serde_json::from_slice(&bytes).ok())
      .unwrap_or_default();
    let http = reqwest::Client::builder()
      .user_agent(USER_AGENT)
      .timeout(Duration::from_secs(30))
      .build()
      .unwrap_or_default();
    Self {
      settings_file,
      settings: Mutex::new(settings),
      tokens,
      user: Mutex::new(None),
      pending: Mutex::new(None),
      generation: AtomicU64::new(0),
      http,
    }
  }

  fn settings_client_id(&self) -> Option<String> {
    self.settings.lock().unwrap().client_id.clone().filter(|id| !id.is_empty())
  }

  pub fn client_id(&self) -> Option<String> {
    self.settings_client_id().or_else(|| BUILT_IN_CLIENT_ID.map(str::to_string).filter(|id| !id.is_empty()))
  }

  /// Sets (or with None / an empty string clears) the client id stored in the app settings.
  pub fn set_client_id(&self, client_id: Option<&str>) -> Result<(), String> {
    let client_id = client_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(id) = client_id
      && (id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
      return Err("That does not look like a GitHub client id (letters, digits, '.', '_' and '-' only)".into());
    }
    let mut settings = self.settings.lock().unwrap();
    settings.client_id = client_id.map(str::to_string);
    let json = serde_json::to_vec_pretty(&*settings).map_err(|e| e.to_string())?;
    if let Some(parent) = self.settings_file.parent() {
      std::fs::create_dir_all(parent).map_err(|e| format!("Could not save the GitHub settings: {e}"))?;
    }
    std::fs::write(&self.settings_file, json).map_err(|e| format!("Could not save the GitHub settings: {e}"))
  }

  /// The stored token, for git and the REST calls. Never hand it to the webview or to MCP.
  pub(crate) fn token(&self) -> Option<String> {
    self.tokens.get().ok().flatten()
  }

  /// Name and no-reply e-mail of the signed-in user, for commits in repositories without a git identity.
  pub fn identity(&self) -> Option<crate::git::Identity> {
    let user = self.user.lock().unwrap().clone()?;
    let name = user.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| user.login.clone());
    Some((name, format!("{}+{}@users.noreply.github.com", user.id, user.login)))
  }

  pub async fn account(&self) -> Result<Account, String> {
    let client_id = self.client_id();
    let mut account = Account {
      configured: client_id.is_some(),
      client_id_from_settings: self.settings_client_id().is_some(),
      client_id,
      user: None,
    };
    if self.tokens.get()?.is_none() {
      *self.user.lock().unwrap() = None;
      return Ok(account);
    }
    if let Some(user) = self.user.lock().unwrap().clone() {
      account.user = Some(user);
      return Ok(account);
    }
    account.user = Some(self.fetch_user().await?);
    Ok(account)
  }

  async fn fetch_user(&self) -> Result<User, String> {
    let value = self.api(reqwest::Method::GET, "/user", None).await?;
    let user = parse_user(&value).ok_or("GitHub sent an unexpected answer for the account")?;
    *self.user.lock().unwrap() = Some(user.clone());
    Ok(user)
  }

  /// Asks GitHub for a device code; the user enters it on the verification page.
  pub async fn start_login(&self) -> Result<DeviceCode, String> {
    let client_id = self.client_id().ok_or(NOT_CONFIGURED)?;
    self.generation.fetch_add(1, Ordering::SeqCst);
    let response = self
      .http
      .post(format!("{OAUTH}/device/code"))
      .header("Accept", "application/json")
      .form(&[("client_id", client_id.as_str()), ("scope", SCOPES)])
      .send()
      .await
      .map_err(offline)?;
    let value: Value = response.json().await.map_err(offline)?;
    let code = parse_device_code(&value)?;
    *self.pending.lock().unwrap() = Some(PendingLogin { code: code.clone(), expires_at: Instant::now() + Duration::from_secs(code.expires_in) });
    Ok(code)
  }

  /// Polls until the user has confirmed the code, then stores the token and returns the account.
  pub async fn wait_login(&self) -> Result<User, String> {
    let generation = self.generation.load(Ordering::SeqCst);
    let client_id = self.client_id().ok_or(NOT_CONFIGURED)?;
    let (device_code, mut interval, expires_at) = {
      let pending = self.pending.lock().unwrap();
      let pending = pending.as_ref().ok_or("No GitHub sign-in was started")?;
      (pending.code.device_code.clone(), pending.code.interval.max(1), pending.expires_at)
    };
    loop {
      tokio::time::sleep(Duration::from_secs(interval)).await;
      if self.generation.load(Ordering::SeqCst) != generation {
        return Err(CANCELLED.into());
      }
      if Instant::now() >= expires_at {
        *self.pending.lock().unwrap() = None;
        return Err("The sign-in code expired. Start the GitHub sign-in again.".into());
      }
      let response = self
        .http
        .post(format!("{OAUTH}/oauth/access_token"))
        .header("Accept", "application/json")
        .form(&[
          ("client_id", client_id.as_str()),
          ("device_code", device_code.as_str()),
          ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(offline)?;
      let value: Value = response.json().await.map_err(offline)?;
      match parse_poll(&value) {
        Poll::Pending => {}
        Poll::SlowDown => interval += 5,
        Poll::Failed(message) => {
          *self.pending.lock().unwrap() = None;
          return Err(message);
        }
        Poll::Token(token) => {
          if self.generation.load(Ordering::SeqCst) != generation {
            return Err(CANCELLED.into());
          }
          *self.pending.lock().unwrap() = None;
          self.tokens.set(&token)?;
          *self.user.lock().unwrap() = None;
          return self.fetch_user().await;
        }
      }
    }
  }

  pub fn cancel_login(&self) {
    self.generation.fetch_add(1, Ordering::SeqCst);
    *self.pending.lock().unwrap() = None;
  }

  /// Forgets the token (it stays valid on GitHub until revoked there under Settings → Applications).
  pub fn logout(&self) -> Result<(), String> {
    self.cancel_login();
    *self.user.lock().unwrap() = None;
    self.tokens.delete()
  }

  /// Signs in with a personal access token instead of the device flow (builds without a client id,
  /// organisations that block OAuth Apps). The token is checked against GitHub, then goes straight
  /// to the credential store.
  pub async fn login_with_token(&self, token: &str) -> Result<User, String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
      return Err("That does not look like a GitHub personal access token".into());
    }
    let value = self.request(token, reqwest::Method::GET, "/user", None).await.map_err(|(status, message)| {
      if status == Some(401) { "GitHub did not accept this token (wrong, expired or revoked).".into() } else { message }
    })?;
    let user = parse_user(&value).ok_or("GitHub sent an unexpected answer for the account")?;
    self.cancel_login();
    self.tokens.set(token)?;
    *self.user.lock().unwrap() = Some(user.clone());
    Ok(user)
  }

  /// One REST call with an explicit token. Errors carry the HTTP status, if there was an answer.
  async fn request(&self, token: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, (Option<u16>, String)> {
    let mut request = self
      .http
      .request(method, format!("{API}{path}"))
      .bearer_auth(token)
      .header("Accept", "application/vnd.github+json")
      .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body {
      request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| (None, offline(e)))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
      return Err((Some(status.as_u16()), api_error(status.as_u16(), &value)));
    }
    Ok(value)
  }

  /// A REST call with the stored token. A rejected token is removed, so the UI shows "signed out".
  async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let token = self.tokens.get()?.ok_or("You are not signed in to GitHub")?;
    match self.request(&token, method, path, body).await {
      Ok(value) => Ok(value),
      Err((Some(401), _)) => {
        *self.user.lock().unwrap() = None;
        let _ = self.tokens.delete();
        Err("The GitHub login is no longer valid. Sign in again.".into())
      }
      Err((_, message)) => Err(message),
    }
  }

  /// Every repository the user can access: own, collaborator and organisation ones, most recently
  /// changed first (at most 1000). `query` filters by name, owner and description.
  pub async fn repos(&self, query: Option<&str>) -> Result<Vec<Repo>, String> {
    let mut repos = Vec::new();
    for page in 1..=10 {
      let path = format!("/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member");
      let value = self.api(reqwest::Method::GET, &path, None).await?;
      let items = value.as_array().cloned().unwrap_or_default();
      let count = items.len();
      repos.extend(items.iter().filter_map(parse_repo));
      if count < 100 {
        break;
      }
    }
    Ok(filter_repos(repos, query))
  }

  /// Where a new repository can be created: the user's own account first, then their organisations.
  pub async fn owners(&self) -> Result<Vec<String>, String> {
    let login = match self.user.lock().unwrap().clone() {
      Some(user) => user.login,
      None => String::new(),
    };
    let login = if login.is_empty() { self.fetch_user().await?.login } else { login };
    let orgs = self.api(reqwest::Method::GET, "/user/orgs?per_page=100", None).await?;
    let mut owners = vec![login];
    owners.extend(orgs.as_array().into_iter().flatten().filter_map(|o| o.get("login")?.as_str().map(str::to_string)));
    Ok(owners)
  }

  /// Creates a repository (with a first commit, so it can be cloned and pushed to right away).
  pub async fn create_repo(&self, owner: &str, name: &str, private: bool, description: Option<&str>) -> Result<Repo, String> {
    let name = name.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
      return Err("A repository name may contain letters, digits, '.', '_' and '-' only".into());
    }
    let own = self.user.lock().unwrap().as_ref().is_some_and(|u| u.login.eq_ignore_ascii_case(owner));
    let path = if own || owner.is_empty() { "/user/repos".to_string() } else { format!("/orgs/{owner}/repos") };
    let body = json!({ "name": name, "private": private, "description": description.unwrap_or(""), "auto_init": true });
    let value = self.api(reqwest::Method::POST, &path, Some(body)).await?;
    parse_repo(&value).ok_or_else(|| "GitHub sent an unexpected answer for the new repository".into())
  }
}

const NOT_CONFIGURED: &str = "GitHub sign-in is not set up: enter the client id of your GitHub OAuth App in the Projects panel (GitHub → Settings).";
const CANCELLED: &str = "The GitHub sign-in was cancelled.";

fn offline(error: reqwest::Error) -> String {
  format!("Could not reach GitHub: {error}")
}

fn api_error(status: u16, body: &Value) -> String {
  let message = body.get("message").and_then(Value::as_str).unwrap_or("unknown error");
  let details: Vec<&str> = body
    .get("errors")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(|e| e.get("message").and_then(Value::as_str))
    .collect();
  match status {
    403 if message.to_lowercase().contains("rate limit") => "GitHub's rate limit is reached; try again in a few minutes.".into(),
    403 => format!("GitHub denied the request: {message}. The organisation may have to approve Tessel (OAuth App access)."),
    404 => "Not found on GitHub (or your account has no access).".into(),
    _ if details.is_empty() => format!("GitHub: {message} ({status})"),
    _ => format!("GitHub: {message}: {}", details.join("; ")),
  }
}

pub fn parse_device_code(value: &Value) -> Result<DeviceCode, String> {
  if let Some(error) = value.get("error").and_then(Value::as_str) {
    return Err(match error {
      "device_flow_disabled" => "Device flow is not enabled for this OAuth App. Turn on \"Enable Device Flow\" in its settings on GitHub.".into(),
      "unauthorized_client" | "incorrect_client_credentials" => "GitHub does not know this client id. Check the client id of the OAuth App.".into(),
      _ => format!("GitHub refused the sign-in: {}", value.get("error_description").and_then(Value::as_str).unwrap_or(error)),
    });
  }
  let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
  let number = |key: &str, default: u64| value.get(key).and_then(Value::as_u64).unwrap_or(default);
  match (text("device_code"), text("user_code"), text("verification_uri")) {
    (Some(device_code), Some(user_code), Some(verification_uri)) => Ok(DeviceCode {
      user_code,
      verification_uri,
      expires_in: number("expires_in", 900),
      device_code,
      interval: number("interval", 5),
    }),
    _ => Err("GitHub sent an unexpected answer to the sign-in request".into()),
  }
}

pub fn parse_poll(value: &Value) -> Poll {
  if let Some(token) = value.get("access_token").and_then(Value::as_str) {
    return Poll::Token(token.to_string());
  }
  match value.get("error").and_then(Value::as_str) {
    Some("authorization_pending") => Poll::Pending,
    Some("slow_down") => Poll::SlowDown,
    Some("expired_token") => Poll::Failed("The sign-in code expired. Start the GitHub sign-in again.".into()),
    Some("access_denied") => Poll::Failed("The sign-in was declined on GitHub.".into()),
    Some(other) => Poll::Failed(format!(
      "GitHub sign-in failed: {}",
      value.get("error_description").and_then(Value::as_str).unwrap_or(other)
    )),
    None => Poll::Failed("GitHub sent an unexpected answer while signing in".into()),
  }
}

pub fn parse_user(value: &Value) -> Option<User> {
  Some(User {
    id: value.get("id")?.as_u64()?,
    login: value.get("login")?.as_str()?.to_string(),
    name: value.get("name").and_then(Value::as_str).map(str::to_string),
    avatar_url: value.get("avatar_url").and_then(Value::as_str).map(str::to_string),
  })
}

pub fn parse_repo(value: &Value) -> Option<Repo> {
  let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
  Some(Repo {
    full_name: text("full_name")?,
    name: text("name")?,
    owner: value.get("owner")?.get("login")?.as_str()?.to_string(),
    private: value.get("private").and_then(Value::as_bool).unwrap_or(false),
    description: text("description"),
    clone_url: text("clone_url")?,
    html_url: text("html_url").unwrap_or_default(),
    default_branch: text("default_branch"),
    updated_at: text("updated_at"),
  })
}

/// Repositories whose name, owner or description contain every word of `query` (case-insensitive).
pub fn filter_repos(repos: Vec<Repo>, query: Option<&str>) -> Vec<Repo> {
  let words: Vec<String> = query.unwrap_or("").split_whitespace().map(str::to_lowercase).collect();
  if words.is_empty() {
    return repos;
  }
  repos
    .into_iter()
    .filter(|repo| {
      let haystack = format!("{} {}", repo.full_name, repo.description.as_deref().unwrap_or("")).to_lowercase();
      words.iter().all(|word| haystack.contains(word))
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::testing::{TempDir, block_on};

  fn github(dir: &TempDir) -> GitHub {
    GitHub::new(dir.0.join("github.json"), Box::new(MemoryStore::default()))
  }

  #[test]
  fn device_codes_and_polls_are_understood() {
    let code = parse_device_code(&json!({
      "device_code": "dev", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device",
      "expires_in": 899, "interval": 5
    }))
    .unwrap();
    assert_eq!((code.user_code.as_str(), code.expires_in, code.interval), ("ABCD-1234", 899, 5));
    // The device code itself is not sent to the webview.
    assert!(serde_json::to_value(&code).unwrap().get("deviceCode").is_none());
    assert!(parse_device_code(&json!({ "error": "device_flow_disabled" })).unwrap_err().contains("Enable Device Flow"));
    assert!(parse_device_code(&json!({ "error": "unauthorized_client" })).unwrap_err().contains("client id"));

    assert_eq!(parse_poll(&json!({ "access_token": "gho_x", "scope": "repo" })), Poll::Token("gho_x".into()));
    assert_eq!(parse_poll(&json!({ "error": "authorization_pending" })), Poll::Pending);
    assert_eq!(parse_poll(&json!({ "error": "slow_down", "interval": 10 })), Poll::SlowDown);
    assert!(matches!(parse_poll(&json!({ "error": "access_denied" })), Poll::Failed(m) if m.contains("declined")));
    assert!(matches!(parse_poll(&json!({ "error": "expired_token" })), Poll::Failed(m) if m.contains("expired")));
  }

  #[test]
  fn repos_are_parsed_and_searched() {
    let repo = |name: &str, owner: &str, description: &str| {
      parse_repo(&json!({
        "full_name": format!("{owner}/{name}"), "name": name, "owner": { "login": owner }, "private": true,
        "description": description, "clone_url": format!("https://github.com/{owner}/{name}.git"),
        "html_url": format!("https://github.com/{owner}/{name}"), "default_branch": "main"
      }))
      .unwrap()
    };
    let repos = vec![repo("survival-models", "team", "Survival server"), repo("factory", "team", "Factory server models"), repo("dotfiles", "me", "")];
    assert!(repos[0].private);
    assert_eq!(repos[0].clone_url, "https://github.com/team/survival-models.git");
    assert_eq!(filter_repos(repos.clone(), None).len(), 3);
    let names = |query| filter_repos(repos.clone(), Some(query)).into_iter().map(|r| r.name).collect::<Vec<_>>();
    assert_eq!(names("server"), ["survival-models", "factory"]);
    assert_eq!(names("TEAM models"), ["survival-models", "factory"]);
    assert_eq!(names("me/dot"), ["dotfiles"]);
    assert!(parse_repo(&json!({ "name": "x" })).is_none());
  }

  #[test]
  fn client_id_is_a_validated_setting() {
    let dir = TempDir::new("github-settings");
    let github = github(&dir);
    github.set_client_id(Some(" Ov23liAbc123 ")).unwrap();
    assert_eq!(github.client_id().as_deref(), Some("Ov23liAbc123"));
    assert!(github.set_client_id(Some("bad id; rm -rf")).is_err());
    let reloaded = GitHub::new(dir.0.join("github.json"), Box::new(MemoryStore::default()));
    assert_eq!(reloaded.client_id().as_deref(), Some("Ov23liAbc123"));
    reloaded.set_client_id(None).unwrap();
    assert_eq!(reloaded.client_id(), BUILT_IN_CLIENT_ID.map(str::to_string));
  }

  #[test]
  fn logout_forgets_the_token_and_the_account_shows_no_token() {
    let dir = TempDir::new("github-logout");
    let github = github(&dir);
    github.tokens.set("gho_secret").unwrap();
    *github.user.lock().unwrap() = Some(User { id: 7, login: "steve".into(), name: None, avatar_url: None });
    assert_eq!(github.identity(), Some(("steve".into(), "7+steve@users.noreply.github.com".into())));
    let account = block_on(github.account()).unwrap();
    let json = serde_json::to_string(&account).unwrap();
    assert!(json.contains("steve") && !json.contains("gho_secret"), "{json}");

    github.logout().unwrap();
    assert_eq!(github.token(), None);
    // Obviously broken tokens are refused before anything is sent or stored.
    assert!(block_on(github.login_with_token("  ")).unwrap_err().contains("personal access token"));
    assert!(block_on(github.login_with_token("ghp_a b")).unwrap_err().contains("personal access token"));
    assert_eq!(github.token(), None);
    assert!(block_on(github.account()).unwrap().user.is_none());
    assert!(block_on(github.repos(None)).unwrap_err().contains("not signed in"));
  }

  #[test]
  fn api_errors_are_explained() {
    assert!(api_error(403, &json!({ "message": "API rate limit exceeded" })).contains("rate limit"));
    assert!(api_error(422, &json!({ "message": "Validation Failed", "errors": [{ "message": "name already exists on this account" }] })).contains("already exists"));
    assert!(api_error(404, &Value::Null).contains("Not found"));
  }
}

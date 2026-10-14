use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

pub use super::acp::AcpAgentHarness;
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SpawnedChild,
        StandardCodingAgentExecutor,
    },
    logs::utils::patch,
    model_selector::{ModelInfo, ModelSelectorConfig, PermissionPolicy},
    profile::ExecutorConfig,
};

const SUPPRESSED_STDERR_PATTERNS: &[&str] = &[
    "was started but never ended. Skipping metrics.",
    "YOLO mode is enabled. All tool calls will be automatically approved.",
];

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Gemini {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

pub const GEMINI_DEFAULT_COMMAND: &str = "npx -y @google/gemini-cli@0.64.0";

/// `--acp` replaced the deprecated `--experimental-acp` (0.64.0 accepts both, 0.29.3 only the
/// latter). Use `--acp` only when the command pins a version known to support it; otherwise
/// fall back to the flag every version understands.
pub fn gemini_acp_flag(base_command: &str) -> &'static str {
    let version = base_command
        .split_whitespace()
        .find_map(|tok| tok.strip_prefix("@google/gemini-cli@"))
        .and_then(|v| {
            let mut it = v.split(['.', '-']).map(|p| p.parse::<u64>().ok());
            Some((it.next()??, it.next()??))
        });
    match version {
        Some(v) if v >= (0, 64) => "--acp",
        _ => "--experimental-acp",
    }
}

#[cfg(test)]
mod acp_flag_tests {
    use super::gemini_acp_flag;
    #[test]
    fn picks_flag() {
        assert_eq!(gemini_acp_flag("npx -y @google/gemini-cli@0.64.0"), "--acp");
        assert_eq!(
            gemini_acp_flag("npx -y @google/gemini-cli@0.29.3"),
            "--experimental-acp"
        );
        assert_eq!(
            gemini_acp_flag("/usr/local/bin/gemini"),
            "--experimental-acp"
        );
        assert_eq!(
            gemini_acp_flag("npx -y @google/gemini-cli@latest"),
            "--experimental-acp"
        );
    }
}

const GEMINI_AUTH_KEYS: [&str; 2] = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

/// Gemini CLI >= 0.64 only reads `~/.gemini/.env` for *trusted* workspaces, so agents in
/// vibe-kanban worktrees (untrusted) fail with "Gemini API key is missing". Load just the
/// auth keys from `~/.gemini/.env` into the child env when they're not already set.
fn with_gemini_auth_env(env: &ExecutionEnv) -> ExecutionEnv {
    let mut env = env.clone();
    let missing: Vec<&str> = GEMINI_AUTH_KEYS
        .into_iter()
        .filter(|k| !env.vars.contains_key(*k) && std::env::var_os(k).is_none())
        .collect();
    if missing.is_empty() {
        return env;
    }
    let Some(path) = dirs::home_dir().map(|h| h.join(".gemini").join(".env")) else {
        return env;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return env;
    };
    for (key, value) in parse_dotenv_keys(&content, &missing) {
        tracing::debug!("Loaded {key} for Gemini from ~/.gemini/.env");
        env.insert(key, value);
    }
    env
}

fn parse_dotenv_keys(content: &str, keys: &[&str]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim();
        if !keys.contains(&k) || out.iter().any(|(e, _): &(String, String)| e == k) {
            continue;
        }
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
            .unwrap_or(v);
        if !v.is_empty() {
            out.push((k.to_string(), v.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod dotenv_tests {
    use super::parse_dotenv_keys;
    #[test]
    fn parses_auth_keys_only() {
        let c =
            "# c\nexport GEMINI_API_KEY=\"abc\"\nOTHER=x\nGOOGLE_API_KEY='g'\nGEMINI_API_KEY=dup\n";
        let got = parse_dotenv_keys(c, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
        assert_eq!(
            got,
            vec![
                ("GEMINI_API_KEY".to_string(), "abc".to_string()),
                ("GOOGLE_API_KEY".to_string(), "g".to_string())
            ]
        );
    }
}

impl Gemini {
    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new(GEMINI_DEFAULT_COMMAND);

        if let Some(model) = &self.model {
            builder = builder.extend_params(["--model", model.as_str()]);
        }

        if self.yolo.unwrap_or(false) {
            builder = builder.extend_params(["--yolo"]);
            builder = builder.extend_params(["--allowed-tools", "run_shell_command"]);
        }

        builder = builder.extend_params([gemini_acp_flag(
            self.cmd
                .base_command_override
                .as_deref()
                .unwrap_or(GEMINI_DEFAULT_COMMAND),
        )]);

        apply_overrides(builder, &self.cmd)
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Gemini {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            self.yolo = Some(matches!(
                permission_policy,
                crate::model_selector::PermissionPolicy::Auto
            ));
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let harness = AcpAgentHarness::new();
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let gemini_command = self.build_command_builder()?.build_initial()?;
        let env = &with_gemini_auth_env(env);
        let approvals = if self.yolo.unwrap_or(false) {
            None
        } else {
            self.approvals.clone()
        };
        harness
            .spawn_with_command(
                current_dir,
                combined_prompt,
                gemini_command,
                env,
                &self.cmd,
                approvals,
            )
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let harness = AcpAgentHarness::new();
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let gemini_command = self.build_command_builder()?.build_follow_up(&[])?;
        let env = &with_gemini_auth_env(env);
        let approvals = if self.yolo.unwrap_or(false) {
            None
        } else {
            self.approvals.clone()
        };
        harness
            .spawn_follow_up_with_command(
                current_dir,
                combined_prompt,
                session_id,
                gemini_command,
                env,
                &self.cmd,
                approvals,
            )
            .await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        super::acp::normalize_logs_with_suppressed_stderr_patterns(
            msg_store,
            worktree_path,
            SUPPRESSED_STDERR_PATTERNS,
        )
    }

    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|home| home.join(".gemini").join("settings.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = dirs::home_dir()
            .and_then(|home| std::fs::metadata(home.join(".gemini").join("oauth_creds.json")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let mcp_config_found = self
            .default_mcp_config_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        let installation_indicator_found = dirs::home_dir()
            .map(|home| home.join(".gemini").join("installation_id").exists())
            .unwrap_or(false);

        if mcp_config_found || installation_indicator_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        use crate::model_selector::*;
        ExecutorConfig {
            executor: BaseCodingAgent::Gemini,
            variant: None,
            model_id: self.model.clone(),
            agent_id: None,
            reasoning_id: None,
            permission_policy: Some(if self.yolo.unwrap_or(false) {
                PermissionPolicy::Auto
            } else {
                PermissionPolicy::Supervised
            }),
        }
    }

    async fn discover_options(
        &self,
        _workdir: Option<&std::path::Path>,
        _repo_path: Option<&std::path::Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let options = ExecutorDiscoveredOptions {
            model_selector: ModelSelectorConfig {
                models: vec![
                    ModelInfo {
                        id: "gemini-4-argon".to_string(),
                        name: "Gemini 4 Argon".to_string(),
                        provider_id: None,
                        reasoning_options: vec![],
                    },
                    ModelInfo {
                        id: "gemini-3.1-pro-preview".to_string(),
                        name: "Gemini 3.1 Pro Preview".to_string(),
                        provider_id: None,
                        reasoning_options: vec![],
                    },
                    ModelInfo {
                        id: "gemini-3-pro-preview".to_string(),
                        name: "Gemini 3 Pro".to_string(),
                        provider_id: None,
                        reasoning_options: vec![],
                    },
                    ModelInfo {
                        id: "gemini-3-flash-preview".to_string(),
                        name: "Gemini 3 Flash".to_string(),
                        provider_id: None,
                        reasoning_options: vec![],
                    },
                ],
                default_model: Some("gemini-3-pro-preview".to_string()),
                permissions: vec![PermissionPolicy::Auto, PermissionPolicy::Supervised],
                ..Default::default()
            },
            ..Default::default()
        };
        Ok(Box::pin(futures::stream::once(async move {
            patch::executor_discovered_options(options)
        })))
    }
}

/// Live check: GEMINI_BIN=/path/to/gemini cargo test -p executors gemini_live -- --ignored --nocapture
#[cfg(test)]
mod gemini_live {
    use std::io::{BufRead, BufReader, Write};

    use super::{GEMINI_AUTH_KEYS, with_gemini_auth_env};
    use crate::env::{ExecutionEnv, RepoContext};

    #[test]
    #[ignore]
    fn gemini_live_session_new_untrusted_dir() {
        let bin = std::env::var("GEMINI_BIN").expect("GEMINI_BIN");
        let dir_buf = std::env::temp_dir().join(format!("vk-gemini-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir_buf).unwrap();
        let dir = &dir_buf;
        // Simulate a backend without the key in its own env.
        for k in GEMINI_AUTH_KEYS {
            unsafe { std::env::remove_var(k) };
        }
        let env = with_gemini_auth_env(&ExecutionEnv::new(
            RepoContext::new(std::path::PathBuf::new(), vec![]),
            false,
            String::new(),
        ));
        assert!(
            env.vars.contains_key("GEMINI_API_KEY"),
            "key not loaded from ~/.gemini/.env"
        );
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg(super::gemini_acp_flag("npx -y @google/gemini-cli@0.64.0"))
            .current_dir(dir.as_path())
            .envs(&env.vars)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1,"clientCapabilities":{{}}}}}}"#).unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":"{}","mcpServers":[]}}}}"#, dir.as_path().display()).unwrap();
        stdin.flush().unwrap();
        loop {
            let mut line = String::new();
            assert!(out.read_line(&mut line).unwrap() > 0, "gemini exited");
            if line.contains(r#""id":2"#) {
                let _ = child.kill();
                eprintln!("session/new -> {}", &line[..line.len().min(120)]);
                assert!(line.contains("sessionId"), "session/new failed: {line}");
                break;
            }
        }
    }
}

//! Minimal JSON-RPC helper tailored for the Codex executor.
//!
//! We keep this bespoke layer because the codex-app-server client must handle server-initiated
//! requests as well as client-initiated requests. When a bidirectional client that
//! supports this pattern is available, this module should be straightforward to
//! replace.

use std::{
    collections::HashMap,
    fmt::Debug,
    io,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

use async_trait::async_trait;
use codex_app_server_protocol::{
    JSONRPCError, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, RequestId,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

use crate::executors::{ExecutorError, ExecutorExitResult};

#[derive(Debug)]
pub enum PendingResponse {
    Result(Value),
    Error(JSONRPCError),
    Shutdown,
}

#[derive(Clone)]
pub struct ExitSignalSender {
    inner: Arc<Mutex<Option<oneshot::Sender<ExecutorExitResult>>>>,
}

impl ExitSignalSender {
    pub fn new(sender: oneshot::Sender<ExecutorExitResult>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Some(sender))),
        }
    }

    pub async fn send_exit_signal(&self, result: ExecutorExitResult) {
        if let Some(sender) = self.inner.lock().await.take() {
            let _ = sender.send(result);
        }
    }
}

#[derive(Clone)]
pub struct JsonRpcPeer {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<PendingResponse>>>>,
    id_counter: Arc<AtomicI64>,
    /// Codex app-server version parsed from the `initialize` response userAgent.
    server_version: Arc<std::sync::Mutex<Option<(u64, u64, u64)>>>,
}

impl JsonRpcPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        callbacks: Arc<dyn JsonRpcCallbacks>,
        exit_tx: ExitSignalSender,
        cancel: CancellationToken,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            id_counter: Arc::new(AtomicI64::new(1)),
            server_version: Arc::new(std::sync::Mutex::new(None)),
        };

        let reader_peer = peer.clone();
        let callbacks = callbacks.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = String::new();

            loop {
                buffer.clear();
                tokio::select! {
                    _ = cancel.cancelled() => {
                        tracing::debug!("Codex executor cancelled");
                        break;
                    }
                    read_result = reader.read_line(&mut buffer) => {
                        match read_result {
                            Ok(0) => break,
                            Ok(_) => {
                                let line = buffer.trim_end_matches(['\n', '\r']);
                                if line.is_empty() {
                                    continue;
                                }

                                match serde_json::from_str::<JSONRPCMessage>(line) {
                                    Ok(JSONRPCMessage::Response(response)) => {
                                        let request_id = response.id.clone();
                                        let result = response.result.clone();
                                        reader_peer.observe_response(&result);
                                        if callbacks
                                            .on_response(&reader_peer, line, &response)
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                        reader_peer
                                            .resolve(request_id, PendingResponse::Result(result))
                                            .await;
                                    }
                                    Ok(JSONRPCMessage::Error(error)) => {
                                        let request_id = error.id.clone();
                                        if callbacks
                                            .on_error(&reader_peer, line, &error)
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                        reader_peer
                                            .resolve(request_id, PendingResponse::Error(error))
                                            .await;
                                    }
                                    Ok(JSONRPCMessage::Request(request)) => {
                                        if callbacks
                                            .on_request(&reader_peer, line, request)
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Ok(JSONRPCMessage::Notification(notification)) => {
                                        match callbacks
                                            .on_notification(&reader_peer, line, notification)
                                            .await
                                        {
                                            // finished
                                            Ok(true) => break,
                                            Ok(false) => {}
                                            Err(_) => {
                                                break;
                                            }
                                        }
                                    }
                                    Err(_) => {
                                        if callbacks.on_non_json(line).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(err) => {
                                tracing::warn!("Error reading Codex output: {err}");
                                break;
                            }
                        }
                    }
                }
            }

            exit_tx.send_exit_signal(ExecutorExitResult::Success).await;
            let _ = reader_peer.shutdown().await;
        });

        peer
    }

    fn observe_response(&self, result: &Value) {
        if let Some(ua) = result.get("userAgent").and_then(Value::as_str)
            && let Some(v) = compat::parse_user_agent_version(ua)
        {
            tracing::info!("Codex app-server version detected: {}.{}.{}", v.0, v.1, v.2);
            *self
                .server_version
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(v);
        }
    }

    pub fn next_request_id(&self) -> RequestId {
        RequestId::Integer(self.id_counter.fetch_add(1, Ordering::Relaxed))
    }

    pub async fn register(&self, request_id: RequestId) -> PendingReceiver {
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id, sender);
        receiver
    }

    pub async fn resolve(&self, request_id: RequestId, response: PendingResponse) {
        if let Some(sender) = self.pending.lock().await.remove(&request_id) {
            let _ = sender.send(response);
        }
    }

    pub async fn shutdown(&self) -> Result<(), ExecutorError> {
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(PendingResponse::Shutdown);
        }
        Ok(())
    }

    pub async fn send<T>(&self, message: &T) -> Result<(), ExecutorError>
    where
        T: Serialize + Sync,
    {
        let mut value = serde_json::to_value(message)
            .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?;
        let version = *self
            .server_version
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        compat::adapt_outgoing(&mut value, version);
        let raw = serde_json::to_string(&value)
            .map_err(|err| ExecutorError::Io(io::Error::other(err.to_string())))?;
        self.send_raw(&raw).await
    }

    pub async fn request<R, T>(
        &self,
        request_id: RequestId,
        message: &T,
        label: &str,
        cancel: CancellationToken,
    ) -> Result<R, ExecutorError>
    where
        R: DeserializeOwned + Debug,
        T: Serialize + Sync,
    {
        let receiver = self.register(request_id).await;
        self.send(message).await?;
        await_response(receiver, label, cancel).await
    }

    async fn send_raw(&self, payload: &str) -> Result<(), ExecutorError> {
        let mut guard = self.stdin.lock().await;
        guard
            .write_all(payload.as_bytes())
            .await
            .map_err(ExecutorError::Io)?;
        guard.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        guard.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }
}

pub type PendingReceiver = oneshot::Receiver<PendingResponse>;

pub async fn await_response<R>(
    receiver: PendingReceiver,
    label: &str,
    cancel: CancellationToken,
) -> Result<R, ExecutorError>
where
    R: DeserializeOwned + Debug,
{
    let response = tokio::select! {
        _ = cancel.cancelled() => {
            return Err(ExecutorError::Io(io::Error::other(format!(
                "{label} request cancelled",
            ))));
        }
        result = receiver => result,
    };

    match response {
        Ok(PendingResponse::Result(value)) => serde_json::from_value(value).map_err(|err| {
            ExecutorError::Io(io::Error::other(format!(
                "failed to decode {label} response: {err}",
            )))
        }),
        Ok(PendingResponse::Error(error)) => Err(ExecutorError::Io(io::Error::other(format!(
            "{label} request failed: {}",
            error.error.message
        )))),
        Ok(PendingResponse::Shutdown) => Err(ExecutorError::Io(io::Error::other(format!(
            "server was shutdown while waiting for {label} response",
        )))),
        Err(_) => Err(ExecutorError::Io(io::Error::other(format!(
            "{label} request was dropped",
        )))),
    }
}

#[async_trait]
pub trait JsonRpcCallbacks: Send + Sync {
    async fn on_request(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        request: JSONRPCRequest,
    ) -> Result<(), ExecutorError>;

    async fn on_response(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        response: &JSONRPCResponse,
    ) -> Result<(), ExecutorError>;

    async fn on_error(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        error: &JSONRPCError,
    ) -> Result<(), ExecutorError>;

    async fn on_notification(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        notification: JSONRPCNotification,
    ) -> Result<bool, ExecutorError>;

    async fn on_non_json(&self, _raw: &str) -> Result<(), ExecutorError>;
}

/// Forward-compatibility shims for newer Codex app-server protocol versions.
///
/// vibe-kanban is compiled against the 0.124 protocol types. Newer Codex binaries
/// removed some fields/values; we patch the outgoing JSON so both old and new
/// binaries accept it.
pub mod compat {
    use serde_json::Value;

    /// First version known (tested) to have dropped `on-failure` approval policy.
    /// 0.142.5 still accepts it; 0.154.0 does not.
    pub const ON_FAILURE_REMOVED: (u64, u64, u64) = (0, 143, 0);

    /// Parse `x.y.z` from a userAgent like `vibe-codex-executor/0.154.0 (Mac OS ...)`.
    pub fn parse_user_agent_version(ua: &str) -> Option<(u64, u64, u64)> {
        let first = ua.split_whitespace().next()?;
        let ver = first.rsplit('/').next()?;
        parse_version(ver)
    }

    pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
        let core = s.trim().split(['-', '+']).next()?;
        let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
        Some((
            it.next()??,
            it.next().flatten().unwrap_or(0),
            it.next().flatten().unwrap_or(0),
        ))
    }

    /// Patch an outgoing JSON-RPC message in place.
    pub fn adapt_outgoing(msg: &mut Value, version: Option<(u64, u64, u64)>) {
        let Some(params) = msg.get_mut("params").and_then(Value::as_object_mut) else {
            return;
        };
        // `permissionProfile` was removed (0.154 rejects it even as null; 0.142 ignores it).
        // We never set it, so drop it when null for every version.
        if params.get("permissionProfile").is_some_and(Value::is_null) {
            params.remove("permissionProfile");
        }
        let new_enough = version.is_some_and(|v| v >= ON_FAILURE_REMOVED);
        if new_enough && params.get("approvalPolicy").and_then(Value::as_str) == Some("on-failure")
        {
            tracing::warn!(
                "Codex >= 0.143 has no `on-failure` approval policy; using `on-request`"
            );
            params.insert("approvalPolicy".into(), Value::String("on-request".into()));
        }
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        use super::*;

        #[test]
        fn parses_user_agent() {
            assert_eq!(
                parse_user_agent_version("vibe-codex-executor/0.154.0 (Mac OS 27; arm64) x"),
                Some((0, 154, 0))
            );
            assert_eq!(parse_version("0.142.5-alpha.1"), Some((0, 142, 5)));
            assert_eq!(parse_user_agent_version("garbage"), None);
        }

        #[test]
        fn strips_null_permission_profile_and_maps_policy() {
            let mut m = json!({"id":3,"method":"thread/start","params":{"permissionProfile":null,"approvalPolicy":"on-failure"}});
            adapt_outgoing(&mut m, Some((0, 142, 5)));
            assert!(m["params"].get("permissionProfile").is_none());
            assert_eq!(m["params"]["approvalPolicy"], "on-failure");
            adapt_outgoing(&mut m, Some((0, 154, 0)));
            assert_eq!(m["params"]["approvalPolicy"], "on-request");
        }

        #[test]
        fn keeps_non_null_permission_profile() {
            let mut m = json!({"params":{"permissionProfile":{"x":1}}});
            adapt_outgoing(&mut m, None);
            assert!(m["params"].get("permissionProfile").is_some());
        }
    }
}

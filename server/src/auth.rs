use sha2::{Digest, Sha256};

pub const COOKIE_NAME: &str = "webdvd_session";
pub const COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 30; // 30 days

/// Single-password session auth.
///
/// The session token is `SHA256(PLAYER_PASSWORD)` hex-encoded — set as a
/// cookie on successful login, and compared against the env-derived expected
/// token on each request. Rotating the password naturally invalidates
/// existing sessions (the hash changes).
///
/// If `PLAYER_PASSWORD` is unset or empty, auth is disabled and every
/// request is treated as authenticated. Useful for local dev.
pub struct Auth {
    expected_token: Option<String>,
}

impl Auth {
    pub fn from_env() -> Self {
        match std::env::var("PLAYER_PASSWORD") {
            Ok(p) if !p.is_empty() => {
                tracing::info!("Auth enabled (PLAYER_PASSWORD set)");
                Self {
                    expected_token: Some(hash_password(&p)),
                }
            }
            _ => {
                tracing::warn!(
                    "PLAYER_PASSWORD not set — auth disabled, all discs accessible"
                );
                Self {
                    expected_token: None,
                }
            }
        }
    }

    pub fn enabled(&self) -> bool {
        self.expected_token.is_some()
    }

    /// Verify a candidate password against the configured one.
    pub fn check_password(&self, password: &str) -> bool {
        match &self.expected_token {
            Some(expected) => &hash_password(password) == expected,
            None => true,
        }
    }

    /// The opaque token to set as the cookie value on successful login.
    pub fn session_token(&self) -> Option<&str> {
        self.expected_token.as_deref()
    }

    /// Check whether the supplied Cookie header value grants access.
    pub fn is_authed(&self, cookie_header: Option<&str>) -> bool {
        let Some(expected) = &self.expected_token else {
            return true;
        };
        let Some(header) = cookie_header else {
            return false;
        };
        extract_session_token(header)
            .map(|tok| tok == expected)
            .unwrap_or(false)
    }
}

fn hash_password(password: &str) -> String {
    hex::encode(Sha256::digest(password.as_bytes()))
}

/// Find `webdvd_session=<value>` in a Cookie header string and return the
/// value. Returns None if the cookie is not present.
fn extract_session_token(cookie_header: &str) -> Option<&str> {
    cookie_header.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix(&format!("{COOKIE_NAME}="))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_with(password: &str) -> Auth {
        Auth {
            expected_token: Some(hash_password(password)),
        }
    }

    #[test]
    fn check_password_matches() {
        let auth = auth_with("hunter2");
        assert!(auth.check_password("hunter2"));
        assert!(!auth.check_password("wrong"));
        assert!(!auth.check_password(""));
    }

    #[test]
    fn disabled_auth_accepts_everything() {
        let auth = Auth { expected_token: None };
        assert!(!auth.enabled());
        assert!(auth.check_password("anything"));
        assert!(auth.is_authed(None));
        assert!(auth.is_authed(Some("garbage")));
    }

    #[test]
    fn is_authed_validates_cookie() {
        let auth = auth_with("hunter2");
        let token = auth.session_token().unwrap().to_string();

        assert!(auth.is_authed(Some(&format!("webdvd_session={token}"))));
        assert!(auth.is_authed(Some(&format!("foo=bar; webdvd_session={token}; baz=qux"))));
        assert!(!auth.is_authed(None));
        assert!(!auth.is_authed(Some("")));
        assert!(!auth.is_authed(Some("webdvd_session=wrong")));
        assert!(!auth.is_authed(Some("other_cookie=value")));
    }

    #[test]
    fn extract_session_token_handles_whitespace() {
        assert_eq!(
            extract_session_token("a=1; webdvd_session=abc; b=2"),
            Some("abc"),
        );
        assert_eq!(extract_session_token("webdvd_session=xyz"), Some("xyz"));
        assert_eq!(extract_session_token("missing=1"), None);
    }
}

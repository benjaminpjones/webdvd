use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::disc::{Disc, Visibility};

/// A collection of DVD discs found under a root directory.
/// Expects: root/<title>/VIDEO_TS/
pub struct Library {
    pub discs: BTreeMap<String, Arc<Disc>>,
}

impl Library {
    /// Scan a root directory for subdirectories containing VIDEO_TS/.
    pub fn scan(root: &Path) -> anyhow::Result<Self> {
        if !root.is_dir() {
            anyhow::bail!("{} is not a directory", root.display());
        }

        let mut discs = BTreeMap::new();

        let mut entries: Vec<_> = std::fs::read_dir(root)?
            .filter_map(|e| e.ok())
            .collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let video_ts = path.join("VIDEO_TS");
            if !video_ts.is_dir() {
                continue;
            }

            let slug = entry
                .file_name()
                .to_string_lossy()
                .to_string();

            let visibility = load_visibility(&path);

            match Disc::open(&video_ts, visibility) {
                Ok(disc) => {
                    discs.insert(slug, Arc::new(disc));
                }
                Err(e) => {
                    tracing::warn!(
                        "Skipping {}: {}",
                        path.display(),
                        e,
                    );
                }
            }
        }

        if discs.is_empty() {
            anyhow::bail!(
                "No discs found in {}. Expected subdirectories with VIDEO_TS/.",
                root.display(),
            );
        }

        Ok(Self { discs })
    }
}

/// Read `meta.json` from the disc directory (sibling to VIDEO_TS/) and
/// extract the visibility flag. Missing file, parse error, or absent field
/// all default to Private — opt-in for public exposure.
fn load_visibility(disc_dir: &Path) -> Visibility {
    let path = disc_dir.join("meta.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Visibility::Private;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
        tracing::warn!("Failed to parse {} — defaulting to private", path.display());
        return Visibility::Private;
    };
    match v.get("visibility").and_then(|x| x.as_str()) {
        Some("public") => Visibility::Public,
        _ => Visibility::Private,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_meta_defaults_to_private() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_visibility(dir.path()), Visibility::Private);
    }

    #[test]
    fn meta_with_public_returns_public() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("meta.json"), r#"{"visibility":"public"}"#).unwrap();
        assert_eq!(load_visibility(dir.path()), Visibility::Public);
    }

    #[test]
    fn meta_with_private_returns_private() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("meta.json"), r#"{"visibility":"private"}"#).unwrap();
        assert_eq!(load_visibility(dir.path()), Visibility::Private);
    }

    #[test]
    fn meta_missing_visibility_field_defaults_to_private() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("meta.json"), r#"{"other":"field"}"#).unwrap();
        assert_eq!(load_visibility(dir.path()), Visibility::Private);
    }

    #[test]
    fn unparsable_meta_defaults_to_private() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("meta.json"), "not json").unwrap();
        assert_eq!(load_visibility(dir.path()), Visibility::Private);
    }
}

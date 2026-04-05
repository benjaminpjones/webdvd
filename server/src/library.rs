use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::disc::Disc;

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

            match Disc::open(&video_ts) {
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

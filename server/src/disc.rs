use std::path::{Path, PathBuf};

/// Represents a VIDEO_TS directory on disk.
pub struct Disc {
    pub path: PathBuf,
    vts_ifos: Vec<PathBuf>,
    vobs: Vec<PathBuf>,
}

impl Disc {
    pub fn open(video_ts: &Path) -> anyhow::Result<Self> {
        if !video_ts.is_dir() {
            anyhow::bail!("{} is not a directory", video_ts.display());
        }

        let mut vts_ifos = Vec::new();
        let mut vobs = Vec::new();

        for entry in std::fs::read_dir(video_ts)? {
            let entry = entry?;
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_uppercase();

            if name.ends_with(".IFO") && name.starts_with("VTS_") {
                vts_ifos.push(path);
            } else if name.ends_with(".VOB") {
                vobs.push(path);
            }
        }

        vts_ifos.sort();
        vobs.sort();

        if vobs.is_empty() {
            anyhow::bail!("No VOB files found in {}", video_ts.display());
        }

        Ok(Self {
            path: video_ts.to_path_buf(),
            vts_ifos,
            vobs,
        })
    }

    pub fn vts_count(&self) -> usize {
        self.vts_ifos.len()
    }

    pub fn vob_count(&self) -> usize {
        self.vobs.len()
    }

    /// Get VOB files for a given title set number (1-indexed).
    /// Title set N corresponds to VTS_NN_*.VOB files.
    pub fn vobs_for_titleset(&self, titleset: u32) -> Vec<&Path> {
        let prefix = format!("VTS_{:02}_", titleset);
        self.vobs
            .iter()
            .filter(|p| {
                let name = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_uppercase();
                // Skip VTS_NN_0.VOB (menu VOB), include VTS_NN_1.VOB and up
                name.starts_with(&prefix) && !name.ends_with("_0.VOB")
            })
            .map(|p| p.as_path())
            .collect()
    }

    /// List available title sets (by number).
    pub fn titlesets(&self) -> Vec<u32> {
        let mut sets: Vec<u32> = self
            .vts_ifos
            .iter()
            .filter_map(|p| {
                let name = p.file_name()?.to_string_lossy().to_uppercase();
                // VTS_01_0.IFO -> 1
                let num_str = name.strip_prefix("VTS_")?.split('_').next()?;
                num_str.parse().ok()
            })
            .collect();
        sets.sort();
        sets.dedup();
        sets
    }
}

use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(has_dvdread)]
use crate::dvdread::{self, DvdReader};

/// Represents a VIDEO_TS directory on disk.
pub struct Disc {
    pub path: PathBuf,
    vts_ifos: Vec<PathBuf>,
    vobs: Vec<PathBuf>,
    #[cfg(has_dvdread)]
    dvdread: Option<Mutex<DvdReader>>,
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

        // Try to open via libdvdread for CSS decryption support.
        // DVDOpen wants the disc root (parent of VIDEO_TS), not VIDEO_TS itself.
        #[cfg(has_dvdread)]
        let dvdread = {
            let dvd_root = video_ts.parent().unwrap_or(video_ts);
            match DvdReader::open(dvd_root) {
                Ok(reader) => {
                    tracing::info!("libdvdread available — CSS decryption enabled");
                    Some(Mutex::new(reader))
                }
                Err(e) => {
                    tracing::warn!("libdvdread unavailable ({e}), using raw file I/O");
                    None
                }
            }
        };

        Ok(Self {
            path: video_ts.to_path_buf(),
            vts_ifos,
            vobs,
            #[cfg(has_dvdread)]
            dvdread,
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

    /// List all IFO and BUP filenames in the VIDEO_TS directory.
    pub fn ifo_files(&self) -> Vec<String> {
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.path) {
            for entry in entries.flatten() {
                let name = entry
                    .file_name()
                    .to_string_lossy()
                    .to_uppercase();
                if name.ends_with(".IFO") || name.ends_with(".BUP") {
                    files.push(name.to_string());
                }
            }
        }
        files.sort();
        files
    }

    /// Get the full path to a VIDEO_TS file by name (IFO/BUP only).
    /// Returns None if the file doesn't exist or the name is invalid.
    pub fn video_ts_file(&self, filename: &str) -> Option<PathBuf> {
        let upper = filename.to_uppercase();
        // Validate: must be IFO or BUP, no path separators
        if (!upper.ends_with(".IFO") && !upper.ends_with(".BUP"))
            || filename.contains('/')
            || filename.contains('\\')
        {
            return None;
        }
        let path = self.path.join(&upper);
        if path.is_file() {
            Some(path)
        } else {
            None
        }
    }

    /// List all VOB filenames in the VIDEO_TS directory.
    pub fn vob_files(&self) -> Vec<String> {
        self.vobs
            .iter()
            .filter_map(|p| {
                Some(p.file_name()?.to_string_lossy().to_uppercase())
            })
            .collect()
    }

    /// Get the full path to a VOB file by name.
    /// Returns None if the file doesn't exist or the name is invalid.
    pub fn vob_file(&self, filename: &str) -> Option<PathBuf> {
        let upper = filename.to_uppercase();
        if !upper.ends_with(".VOB")
            || filename.contains('/')
            || filename.contains('\\')
        {
            return None;
        }
        let path = self.path.join(&upper);
        if path.is_file() {
            Some(path)
        } else {
            None
        }
    }

    /// Get menu VOB files. Titleset 0 = VMGM (VIDEO_TS.VOB),
    /// otherwise VTS_NN_0.VOB for the given titleset.
    pub fn menu_vobs(&self, titleset: u32) -> Vec<&Path> {
        if titleset == 0 {
            // VMGM menu — VIDEO_TS.VOB
            self.vobs
                .iter()
                .filter(|p| {
                    let name = p
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_uppercase();
                    name.starts_with("VIDEO_TS") && name.ends_with(".VOB")
                })
                .map(|p| p.as_path())
                .collect()
        } else {
            // VTS menu — VTS_NN_0.VOB
            let target = format!("VTS_{:02}_0.VOB", titleset);
            self.vobs
                .iter()
                .filter(|p| {
                    let name = p
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_uppercase();
                    name == target
                })
                .map(|p| p.as_path())
                .collect()
        }
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

    /// Read a DVD file by name, using libdvdread for CSS decryption if
    /// available, otherwise falling back to raw file I/O.
    pub fn read_file(&self, filename: &str) -> anyhow::Result<Vec<u8>> {
        #[cfg(has_dvdread)]
        if let Some(ref dvdread_mutex) = self.dvdread
            && let Some((titlenum, domain)) = dvdread::parse_dvd_filename(filename) {
                let reader = dvdread_mutex.lock().unwrap();
                return reader.read_file(titlenum, domain);
            }

        // Fallback: raw file I/O
        let upper = filename.to_uppercase();
        let path = self.path.join(&upper);
        Ok(std::fs::read(&path)?)
    }

    /// Read VOB blocks via libdvdread (for transcoding with sector offsets).
    /// Returns None if dvdread is unavailable — caller should use raw file I/O.
    #[cfg(has_dvdread)]
    pub fn read_vob_blocks(
        &self,
        titlenum: i32,
        domain: dvdread::DvdReadDomain,
        start_block: u32,
        block_count: u32,
    ) -> Option<anyhow::Result<Vec<u8>>> {
        let dvdread_mutex = self.dvdread.as_ref()?;
        let reader = dvdread_mutex.lock().unwrap();
        Some(reader.read_vob_blocks(titlenum, domain, start_block, block_count))
    }

    /// Open a DVD file for chunked block reading via dvdread.
    /// Returns None if dvdread is unavailable.
    #[cfg(has_dvdread)]
    pub fn open_dvd_file(
        &self,
        titlenum: i32,
        domain: dvdread::DvdReadDomain,
    ) -> Option<anyhow::Result<dvdread::DvdFile>> {
        let dvdread_mutex = self.dvdread.as_ref()?;
        let reader = dvdread_mutex.lock().unwrap();
        Some(reader.open_file(titlenum, domain))
    }

    /// Whether libdvdread is active for this disc.
    pub fn has_dvdread(&self) -> bool {
        #[cfg(has_dvdread)]
        { self.dvdread.is_some() }
        #[cfg(not(has_dvdread))]
        { false }
    }

    /// Read a sector range from a VOB file.
    /// Returns (data, total_file_size).
    pub fn read_vob_range(
        &self,
        filename: &str,
        start_sector: u64,
        end_sector: u64,
    ) -> anyhow::Result<(Vec<u8>, u64)> {
        let block_count = (end_sector - start_sector + 1) as u32;

        #[cfg(has_dvdread)]
        if let Some(ref dvdread_mutex) = self.dvdread
            && let Some((titlenum, domain)) = dvdread::parse_dvd_filename(filename) {
                let reader = dvdread_mutex.lock().unwrap();
                let total_size = reader.file_size(titlenum, domain)?;
                let data = reader.read_vob_blocks(
                    titlenum, domain, start_sector as u32, block_count,
                )?;
                return Ok((data, total_size));
            }

        // Fallback: raw file I/O with seeking
        let upper = filename.to_uppercase();
        let path = self.path.join(&upper);
        let total_size = std::fs::metadata(&path)?.len();
        let byte_offset = start_sector * 2048;
        let byte_count = block_count as u64 * 2048;

        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path)?;
        file.seek(SeekFrom::Start(byte_offset))?;
        let mut buf = vec![0u8; byte_count as usize];
        file.read_exact(&mut buf)?;
        Ok((buf, total_size))
    }

    /// Get total size of a VOB file in bytes.
    pub fn vob_size(&self, filename: &str) -> anyhow::Result<u64> {
        let upper = filename.to_uppercase();
        let path = self.path.join(&upper);
        Ok(std::fs::metadata(&path)?.len())
    }
}

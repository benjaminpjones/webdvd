use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Cache directory schema version. Bump when ffmpeg codec settings change
/// in a way that would alter output bytes — transparently invalidates the
/// old cache.
const SCHEMA_VERSION: &str = "v1";

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Identifies a single transcoded segment for caching purposes.
///
/// Two requests with equal CacheKeys produce byte-identical ffmpeg output
/// (modulo non-determinism in ffmpeg itself), so they can share a cache slot.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub slug: String,
    pub kind: Kind,
    pub titleset: u32,
    pub sector: Option<u64>,
    pub last_sector: Option<u64>,
    /// Start seconds, rounded to milliseconds to match ffmpeg arg formatting.
    pub start_ms: Option<u64>,
    /// Duration seconds, rounded to milliseconds.
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Menu,
    Title,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Menu => "menu",
            Kind::Title => "title",
        }
    }
}

pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Full path to the cached (fragmented, streaming) `.mp4` for a given key.
    pub fn final_path(&self, key: &CacheKey) -> PathBuf {
        self.root
            .join(SCHEMA_VERSION)
            .join(&key.slug)
            .join(filename(key))
    }

    /// Path to the seekable (faststart, non-fragmented) remux of a title. Once
    /// this exists the whole title is cached and the client can play it via a
    /// native, range-seekable `<video>` — instant seeking with no re-transcode.
    pub fn seekable_path(&self, key: &CacheKey) -> PathBuf {
        self.root
            .join(SCHEMA_VERSION)
            .join(&key.slug)
            .join(format!("{}.seek.mp4", filename_stem(key)))
    }

    /// Per-request temp path. Two concurrent transcodes of the same key
    /// each get unique tmp files, so they don't collide on writes; whichever
    /// finishes first wins the atomic rename to `final_path`.
    pub fn tmp_path(&self, key: &CacheKey) -> PathBuf {
        let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let stem = filename_stem(key);
        self.root
            .join(SCHEMA_VERSION)
            .join(&key.slug)
            .join(format!("{stem}.{pid}.{n}.tmp"))
    }

    /// Ensure the directory containing the cache file exists.
    pub async fn ensure_dir(&self, key: &CacheKey) -> std::io::Result<()> {
        let dir = self.root.join(SCHEMA_VERSION).join(&key.slug);
        tokio::fs::create_dir_all(&dir).await
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// If the final cached file exists, return a streaming body backed by it.
    /// Returns None if the file is missing — caller should fall through to
    /// transcoding.
    pub async fn serve_if_cached(&self, key: &CacheKey) -> Option<axum::body::Body> {
        let path = self.final_path(key);
        let file = tokio::fs::File::open(&path).await.ok()?;
        tracing::info!("Cache hit: {}", path.display());
        let stream = tokio_util::io::ReaderStream::new(file);
        Some(axum::body::Body::from_stream(stream))
    }
}

/// Read from an AsyncRead, splitting bytes into two destinations:
/// a channel feeding the HTTP response, and a writer (the cache .tmp file).
///
/// The HTTP client and the cache file are independent: if the client
/// disconnects, file writing continues so the cache still populates. If the
/// file write fails, the HTTP stream still completes.
///
/// Returns (bytes_total_read, file_write_ok). Caller decides whether to
/// rename the tmp file or discard it based on file_write_ok plus the
/// process exit status.
pub async fn tee_to_channel_and_file<R, W>(
    mut reader: R,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    mut file: Option<W>,
) -> (u64, bool)
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut buf = vec![0u8; 65536];
    let mut http_open = true;
    let mut file_ok = file.is_some();
    let mut total: u64 = 0;

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::warn!("tee read error: {e}");
                break;
            }
        };
        total += n as u64;
        let chunk = Bytes::copy_from_slice(&buf[..n]);

        if http_open && tx.send(Ok(chunk.clone())).await.is_err() {
            http_open = false;
            tracing::debug!("HTTP client closed; continuing to populate cache");
        }

        if file_ok
            && let Some(f) = file.as_mut()
            && let Err(e) = f.write_all(&chunk).await
        {
            tracing::warn!("Cache write error: {e}");
            file_ok = false;
        }
    }

    if let Some(mut f) = file {
        let _ = f.flush().await;
    }

    (total, file_ok)
}

/// After ffmpeg has exited and the tee task has flushed the tmp file,
/// either atomically rename it into the cache slot (on success) or delete
/// it (on failure).
pub async fn finalize_tmp(tmp_path: &Path, final_path: &Path, keep: bool, bytes_total: u64) {
    if keep {
        match tokio::fs::rename(tmp_path, final_path).await {
            Ok(()) => tracing::info!(
                "Cached {} ({} MB)",
                final_path.display(),
                bytes_total / (1024 * 1024),
            ),
            Err(e) => {
                tracing::warn!(
                    "Cache rename {} -> {} failed: {e}",
                    tmp_path.display(),
                    final_path.display(),
                );
                let _ = tokio::fs::remove_file(tmp_path).await;
            }
        }
    } else {
        if let Err(e) = tokio::fs::remove_file(tmp_path).await {
            tracing::debug!("Cache tmp cleanup ({}): {e}", tmp_path.display());
        }
    }
}

/// Convenience wrapper that orchestrates the full tee-and-finalize flow.
/// Returns an axum Body backed by the HTTP channel; spawns a background
/// task that owns the ffmpeg Child, tees its stdout, waits for exit, and
/// renames/deletes the tmp file accordingly.
///
/// `keep_alive` is moved into the background task so anonymous owned
/// resources (e.g. concat tempfile) survive until ffmpeg exits.
pub fn spawn_tee_and_finalize<K>(
    cache: Arc<Cache>,
    key: CacheKey,
    stdout: tokio::process::ChildStdout,
    mut child: tokio::process::Child,
    keep_alive: K,
    cache_output: bool,
) -> axum::body::Body
where
    K: Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    let tmp_path = cache.tmp_path(&key);
    let final_path = cache.final_path(&key);

    tokio::spawn(async move {
        let _keep_alive = keep_alive;

        // Ephemeral segments (mid-title seeks) stream without caching, so they
        // don't accumulate overlapping per-sector tails on disk.
        let file = if cache_output {
            if let Err(e) = cache.ensure_dir(&key).await {
                tracing::warn!("Failed to create cache dir for {}: {e}", key.slug);
            }
            match tokio::fs::File::create(&tmp_path).await {
                Ok(f) => Some(f),
                Err(e) => {
                    tracing::warn!("Failed to open cache tmp {}: {e}", tmp_path.display());
                    None
                }
            }
        } else {
            None
        };

        let (bytes_total, file_ok) = tee_to_channel_and_file(stdout, tx, file).await;

        let status_ok = match child.wait().await {
            Ok(s) if s.success() => true,
            Ok(s) => {
                tracing::warn!("ffmpeg exited non-zero: {s}");
                false
            }
            Err(e) => {
                tracing::error!("ffmpeg wait error: {e}");
                false
            }
        };

        if !cache_output {
            return;
        }

        let cached_ok = status_ok && file_ok;
        finalize_tmp(&tmp_path, &final_path, cached_ok, bytes_total).await;

        // Once a full title is cached, remux it to a faststart (non-fragmented,
        // indexed) file so future views can seek natively via HTTP Range with no
        // re-transcode. The fragmented original is then removed — clients use
        // the seekable file, so nothing else needs it. Menus don't need seeking.
        if cached_ok && key.kind == Kind::Title {
            let seek_path = cache.seekable_path(&key);
            remux_to_seekable(&final_path, &seek_path).await;
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    axum::body::Body::from_stream(stream)
}

/// Stream-copy a fragmented cache file into a faststart (moov-at-front,
/// non-fragmented) MP4 that native `<video>` can range-seek. On success the
/// fragmented original is deleted (only the seekable file is served from here
/// on). Best-effort: any failure just leaves the fragmented cache in place.
async fn remux_to_seekable(final_path: &Path, seek_path: &Path) {
    let tmp = seek_path.with_extension("seek.tmp");
    let status = tokio::process::Command::new("ffmpeg")
        .args(["-y", "-i"])
        .arg(final_path)
        .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;

    match status {
        Ok(s) if s.success() => match tokio::fs::rename(&tmp, seek_path).await {
            Ok(()) => {
                tracing::info!("Remuxed seekable cache: {}", seek_path.display());
                // The fragmented copy is no longer served; reclaim its space.
                let _ = tokio::fs::remove_file(final_path).await;
            }
            Err(e) => {
                tracing::warn!("Seekable rename failed ({e}); keeping fragmented cache");
                let _ = tokio::fs::remove_file(&tmp).await;
            }
        },
        Ok(s) => {
            tracing::warn!("Seekable remux exited {s}; keeping fragmented cache");
            let _ = tokio::fs::remove_file(&tmp).await;
        }
        Err(e) => {
            tracing::warn!("Seekable remux failed to spawn ({e}); keeping fragmented cache");
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }
}

fn filename(key: &CacheKey) -> String {
    format!("{}.mp4", filename_stem(key))
}

fn filename_stem(key: &CacheKey) -> String {
    fn opt_u64(v: Option<u64>) -> String {
        v.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string())
    }
    format!(
        "{}_{}_{}_{}_{}_{}",
        key.kind.as_str(),
        key.titleset,
        opt_u64(key.sector),
        opt_u64(key.last_sector),
        opt_u64(key.start_ms),
        opt_u64(key.duration_ms),
    )
}

/// Convert seconds (f64) to milliseconds (u64) the same way the ffmpeg arg
/// formatter does — used so cache keys match across requests that pass the
/// same logical times in slightly different float representations.
pub fn secs_to_ms(secs: Option<f64>) -> Option<u64> {
    secs.map(|s| (s * 1000.0).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> Cache {
        Cache::new(PathBuf::from("/var/cache/webdvd"))
    }

    #[test]
    fn final_path_for_sector_seeked_title() {
        let key = CacheKey {
            slug: "THE_MATRIX".into(),
            kind: Kind::Title,
            titleset: 1,
            sector: Some(0),
            last_sector: Some(499999),
            start_ms: None,
            duration_ms: None,
        };
        assert_eq!(
            cache().final_path(&key),
            PathBuf::from("/var/cache/webdvd/v1/THE_MATRIX/title_1_0_499999_-_-.mp4"),
        );
    }

    #[test]
    fn seekable_path_uses_seek_mp4_suffix() {
        let key = CacheKey {
            slug: "THE_MATRIX".into(),
            kind: Kind::Title,
            titleset: 2,
            sector: Some(4262),
            last_sector: Some(2878796),
            start_ms: None,
            duration_ms: None,
        };
        assert_eq!(
            cache().seekable_path(&key),
            PathBuf::from("/var/cache/webdvd/v1/THE_MATRIX/title_2_4262_2878796_-_-.seek.mp4"),
        );
    }

    #[test]
    fn final_path_for_menu() {
        let key = CacheKey {
            slug: "THE_MATRIX".into(),
            kind: Kind::Menu,
            titleset: 0,
            sector: None,
            last_sector: None,
            start_ms: None,
            duration_ms: None,
        };
        assert_eq!(
            cache().final_path(&key),
            PathBuf::from("/var/cache/webdvd/v1/THE_MATRIX/menu_0_-_-_-_-.mp4"),
        );
    }

    #[test]
    fn final_path_for_time_based() {
        let key = CacheKey {
            slug: "SHREK".into(),
            kind: Kind::Title,
            titleset: 2,
            sector: None,
            last_sector: None,
            start_ms: Some(60_000),
            duration_ms: Some(30_000),
        };
        assert_eq!(
            cache().final_path(&key),
            PathBuf::from("/var/cache/webdvd/v1/SHREK/title_2_-_-_60000_30000.mp4"),
        );
    }

    #[test]
    fn tmp_path_includes_pid_and_counter_for_uniqueness() {
        let key = CacheKey {
            slug: "X".into(),
            kind: Kind::Title,
            titleset: 1,
            sector: Some(0),
            last_sector: Some(100),
            start_ms: None,
            duration_ms: None,
        };
        let c = cache();
        let a = c.tmp_path(&key);
        let b = c.tmp_path(&key);
        assert_ne!(a, b, "two tmp paths for same key must be unique");
        assert!(a.to_string_lossy().ends_with(".tmp"));
        assert!(b.to_string_lossy().ends_with(".tmp"));
    }

    #[tokio::test]
    async fn tee_writes_to_both_destinations() {
        let input = b"hello world, this is some test data".to_vec();
        let reader = std::io::Cursor::new(input.clone());

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
        let file_buf: Vec<u8> = Vec::new();
        let file_cursor = std::io::Cursor::new(file_buf);

        // tokio::io::AsyncWriteExt is implemented for tokio::io::Cursor via the
        // wrapping in tokio_util. Simpler: use a Vec<u8> wrapped in compat.
        // For this test, write to a real tmp file.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        let file = tokio::fs::File::create(&path).await.unwrap();
        let _ = file_cursor;

        let (total, file_ok) = tee_to_channel_and_file(reader, tx, Some(file)).await;

        assert_eq!(total, input.len() as u64);
        assert!(file_ok);

        // Channel should have received the bytes
        let mut received = Vec::new();
        while let Some(Ok(chunk)) = rx.recv().await {
            received.extend_from_slice(&chunk);
        }
        assert_eq!(received, input);

        // File should also contain them
        let on_disk = tokio::fs::read(&path).await.unwrap();
        assert_eq!(on_disk, input);
    }

    #[tokio::test]
    async fn tee_continues_to_file_if_http_drops() {
        let input = vec![0xABu8; 200_000]; // larger than one chunk
        let reader = std::io::Cursor::new(input.clone());

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(2);
        drop(rx); // simulate client disconnect immediately

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        let file = tokio::fs::File::create(&path).await.unwrap();

        let (total, file_ok) = tee_to_channel_and_file(reader, tx, Some(file)).await;
        assert_eq!(total, input.len() as u64);
        assert!(
            file_ok,
            "file write must succeed even if HTTP client dropped"
        );

        let on_disk = tokio::fs::read(&path).await.unwrap();
        assert_eq!(on_disk, input);
    }

    #[tokio::test]
    async fn finalize_tmp_renames_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("x.tmp");
        let final_path = dir.path().join("x.mp4");
        tokio::fs::write(&tmp, b"data").await.unwrap();

        finalize_tmp(&tmp, &final_path, true, 4).await;

        assert!(!tmp.exists());
        assert!(final_path.exists());
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"data");
    }

    #[tokio::test]
    async fn finalize_tmp_deletes_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("x.tmp");
        let final_path = dir.path().join("x.mp4");
        tokio::fs::write(&tmp, b"junk").await.unwrap();

        finalize_tmp(&tmp, &final_path, false, 4).await;

        assert!(!tmp.exists());
        assert!(!final_path.exists());
    }

    #[tokio::test]
    async fn finalize_tmp_clobbers_existing_final_atomically() {
        // If a concurrent transcode of the same key already won the cache slot,
        // the second one's rename clobbers (Unix semantics). Both files have
        // identical bytes so this is benign.
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("x.tmp");
        let final_path = dir.path().join("x.mp4");
        tokio::fs::write(&tmp, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"old").await.unwrap();

        finalize_tmp(&tmp, &final_path, true, 3).await;

        assert!(!tmp.exists());
        assert!(final_path.exists());
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"new");
    }

    #[test]
    fn secs_to_ms_rounds() {
        assert_eq!(secs_to_ms(None), None);
        assert_eq!(secs_to_ms(Some(0.0)), Some(0));
        assert_eq!(secs_to_ms(Some(1.234)), Some(1234));
        assert_eq!(secs_to_ms(Some(1.2349)), Some(1235));
    }
}

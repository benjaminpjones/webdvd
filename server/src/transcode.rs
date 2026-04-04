use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use crate::disc::Disc;

/// Transcode options for extracting a specific segment.
#[derive(Default)]
pub struct TranscodeOpts {
    /// Start time in seconds (ffmpeg -ss)
    pub start_secs: Option<f64>,
    /// Duration in seconds (ffmpeg -t)
    pub duration_secs: Option<f64>,
    /// DVD sector to start from (sector * 2048 = byte offset).
    /// Used for menu sub-menus where PGCs share a VOB but have
    /// different sector ranges.
    pub sector: Option<u64>,
    /// Last sector of the cell — limits the read to this sector (inclusive).
    pub last_sector: Option<u64>,
}

/// Spawn ffmpeg to transcode VOB files into H.264/AAC fMP4, returning a
/// streaming body. Playback can begin as soon as the first fragment arrives.
///
/// When `disc.has_dvdread()` is true, VOB data is read through libdvdread
/// for CSS decryption and piped to ffmpeg via stdin.
pub async fn transcode_to_stream(
    vob_files: &[&Path],
    opts: &TranscodeOpts,
    disc: &Arc<Disc>,
    titleset: u32,
    is_menu: bool,
) -> anyhow::Result<axum::body::Body> {
    if vob_files.is_empty() {
        anyhow::bail!("No VOB files to transcode");
    }

    // Build concat list for ffmpeg (used when dvdread is not active)
    let concat_list: String = vob_files
        .iter()
        .map(|p| format!("file '{}'", p.display()))
        .collect::<Vec<_>>()
        .join("\n");

    let concat_file = tempfile::NamedTempFile::new()?;
    std::fs::write(concat_file.path(), &concat_list)?;

    // When dvdread is active, always pipe through stdin for CSS decryption.
    // When sector is specified, also use stdin for sector-based seeking.
    let use_stdin = opts.sector.is_some() || disc.has_dvdread();

    tracing::info!(
        "Transcoding {} VOB file(s) to streaming fMP4 (ss={:?}, t={:?}, sector={:?}, dvdread={})",
        vob_files.len(),
        opts.start_secs,
        opts.duration_secs,
        opts.sector,
        disc.has_dvdread(),
    );

    let mut args: Vec<String> = Vec::new();

    // Input seeking (-ss before -i for fast seek)
    if let Some(ss) = opts.start_secs {
        args.extend(["-ss".to_string(), format!("{ss:.3}")]);
    }

    if use_stdin {
        // Read from stdin (we'll pipe VOB data)
        args.extend([
            "-y".to_string(),
            "-f".to_string(), "mpeg".to_string(),
            "-i".to_string(), "pipe:0".to_string(),
        ]);
    } else {
        args.extend([
            "-y".to_string(),
            "-f".to_string(), "concat".to_string(),
            "-safe".to_string(), "0".to_string(),
            "-i".to_string(),
        ]);
        args.push(concat_file.path().to_string_lossy().to_string());
    }

    // Duration limit
    if let Some(t) = opts.duration_secs {
        args.extend(["-t".to_string(), format!("{t:.3}")]);
    }

    args.extend(["-c:v".to_string(), "libx264".to_string()]);
    args.extend(["-vf".to_string(), "yadif".to_string()]);

    args.extend([
        "-preset".to_string(), "fast".to_string(),
        "-crf".to_string(), "23".to_string(),
        "-c:a".to_string(), "aac".to_string(),
        "-b:a".to_string(), "192k".to_string(),
        "-ac".to_string(), "2".to_string(),
        "-movflags".to_string(), "+frag_keyframe+empty_moov".to_string(),
        "-f".to_string(), "mp4".to_string(),
        "pipe:1".to_string(),
    ]);

    let stdin_mode = if use_stdin { Stdio::piped() } else { Stdio::null() };
    let mut child = Command::new("ffmpeg")
        .args(&args)
        .stdin(stdin_mode)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    if use_stdin {
        let mut stdin = child.stdin.take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture ffmpeg stdin"))?;

        let sector = opts.sector;
        let last_sector = opts.last_sector;
        let vob_paths: Vec<_> = vob_files.iter().map(|p| p.to_path_buf()).collect();
        let disc = disc.clone();

        tokio::spawn(async move {
            let result = if disc.has_dvdread() {
                pipe_dvdread(&disc, titleset, is_menu, sector, last_sector, &mut stdin).await
            } else {
                pipe_raw_files(&vob_paths, sector, last_sector, &mut stdin).await
            };
            if let Err(e) = result {
                tracing::error!("Stdin pipe error: {e}");
            }
            let _ = stdin.shutdown().await;
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Failed to capture ffmpeg stdout"))?;

    // Spawn a background task to wait for ffmpeg to finish and keep the
    // concat tempfile alive for the duration of the transcode.
    tokio::spawn(async move {
        let status = child.wait().await;
        drop(concat_file); // keep tempfile alive until ffmpeg exits
        match status {
            Ok(s) if s.success() => tracing::info!("ffmpeg exited successfully"),
            Ok(s) => tracing::warn!("ffmpeg exited with status: {s}"),
            Err(e) => tracing::error!("ffmpeg wait error: {e}"),
        }
    });

    let stream = ReaderStream::new(stdout);
    Ok(axum::body::Body::from_stream(stream))
}

/// Pipe VOB data through libdvdread (CSS-decrypted) to ffmpeg stdin.
///
/// Reads in chunks via a channel to avoid loading multi-GB title VOBs
/// into memory at once.
async fn pipe_dvdread(
    disc: &Arc<Disc>,
    titleset: u32,
    is_menu: bool,
    sector: Option<u64>,
    last_sector: Option<u64>,
    stdin: &mut tokio::process::ChildStdin,
) -> anyhow::Result<()> {
    #[cfg(has_dvdread)]
    {
        use crate::dvdread::DvdReadDomain;
        let domain = if is_menu {
            DvdReadDomain::MenuVobs
        } else {
            DvdReadDomain::TitleVobs
        };

        if let Some(dvd_file_result) = disc.open_dvd_file(titleset as i32, domain) {
            let dvd_file = dvd_file_result?;
            let total_blocks = dvd_file.total_blocks() as u64;

            let start_block = sector.unwrap_or(0);
            let end_block = match last_sector {
                Some(last) => (last + 1).min(total_blocks),
                None => total_blocks,
            };

            if start_block >= end_block {
                return Ok(());
            }

            let remaining = end_block - start_block;
            tracing::info!(
                "Streaming {} blocks ({} MB) of decrypted VOB data to ffmpeg",
                remaining,
                remaining * 2048 / (1024 * 1024),
            );

            // Read blocks in a blocking task, send chunks through a channel
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);

            tokio::task::spawn_blocking(move || {
                const CHUNK_BLOCKS: u64 = 512; // 1MB per chunk
                let mut offset = start_block;
                while offset < end_block {
                    let count = CHUNK_BLOCKS.min(end_block - offset) as u32;
                    match dvd_file.read_blocks(offset as u32, count) {
                        Ok(data) => {
                            if tx.blocking_send(data).is_err() {
                                break; // receiver dropped (ffmpeg closed stdin)
                            }
                        }
                        Err(e) => {
                            tracing::error!("DVDReadBlocks error at block {offset}: {e}");
                            break;
                        }
                    }
                    offset += count as u64;
                }
            });

            let mut total_bytes: u64 = 0;
            while let Some(chunk) = rx.recv().await {
                total_bytes += chunk.len() as u64;
                if stdin.write_all(&chunk).await.is_err() {
                    break; // ffmpeg closed
                }
            }

            tracing::info!("Piped {} bytes total to ffmpeg", total_bytes);
            return Ok(());
        }
    }

    // Fallback: raw file read (no dvdread)
    let disc = disc.clone();
    let vob_name = if is_menu {
        if titleset == 0 {
            "VIDEO_TS.VOB".to_string()
        } else {
            format!("VTS_{:02}_0.VOB", titleset)
        }
    } else {
        format!("VTS_{:02}_1.VOB", titleset)
    };

    let data = tokio::task::spawn_blocking(move || {
        disc.read_file(&vob_name)
    }).await??;

    tracing::info!("Piping {} bytes of VOB data to ffmpeg", data.len());
    stdin.write_all(&data).await?;
    Ok(())
}

/// Pipe raw VOB file data to ffmpeg stdin (original non-dvdread path).
async fn pipe_raw_files(
    vob_paths: &[std::path::PathBuf],
    sector: Option<u64>,
    last_sector: Option<u64>,
    stdin: &mut tokio::process::ChildStdin,
) -> anyhow::Result<()> {
    use tokio::io::AsyncReadExt;

    let byte_offset = sector.map(|s| s * 2048).unwrap_or(0);
    let max_bytes: Option<u64> = match (sector, last_sector) {
        (Some(s), Some(last)) => Some((last - s + 1) * 2048),
        _ => None,
    };

    // Find which VOB file contains the start offset
    let mut cumulative: u64 = 0;
    let mut start_file_idx = 0;
    let mut offset_in_file = byte_offset;

    for (i, path) in vob_paths.iter().enumerate() {
        let meta = tokio::fs::metadata(path).await?;
        let size = meta.len();
        if cumulative + size > byte_offset {
            start_file_idx = i;
            offset_in_file = byte_offset - cumulative;
            break;
        }
        cumulative += size;
    }

    tracing::info!(
        "Piping {} VOB(s) from byte {byte_offset} (sector {:?}), max_bytes={:?}",
        vob_paths.len(), sector, max_bytes,
    );

    let mut buf = vec![0u8; 65536];
    let mut bytes_written: u64 = 0;

    for path in &vob_paths[start_file_idx..] {
        let mut file = tokio::fs::File::open(path).await?;
        // Seek into the first file; subsequent files start from 0
        if offset_in_file > 0 {
            tokio::io::AsyncSeekExt::seek(
                &mut file,
                std::io::SeekFrom::Start(offset_in_file),
            ).await?;
            offset_in_file = 0;
        }

        loop {
            let to_read = if let Some(max) = max_bytes {
                let remaining = max.saturating_sub(bytes_written);
                if remaining == 0 { break; }
                buf.len().min(remaining as usize)
            } else {
                buf.len()
            };
            match file.read(&mut buf[..to_read]).await {
                Ok(0) => break, // EOF of this file — continue to next
                Ok(n) => {
                    bytes_written += n as u64;
                    if stdin.write_all(&buf[..n]).await.is_err() {
                        return Ok(());
                    }
                }
                Err(_) => break,
            }
        }

        // If byte limit reached, stop
        if let Some(max) = max_bytes {
            if bytes_written >= max { break; }
        }
    }

    Ok(())
}

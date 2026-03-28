use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

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
pub async fn transcode_to_stream(
    vob_files: &[&Path],
    opts: &TranscodeOpts,
) -> anyhow::Result<axum::body::Body> {
    if vob_files.is_empty() {
        anyhow::bail!("No VOB files to transcode");
    }

    // Build concat list for ffmpeg
    let concat_list: String = vob_files
        .iter()
        .map(|p| format!("file '{}'", p.display()))
        .collect::<Vec<_>>()
        .join("\n");

    let concat_file = tempfile::NamedTempFile::new()?;
    std::fs::write(concat_file.path(), &concat_list)?;

    // When sector is specified, pipe VOB data from that byte offset via stdin.
    // This handles DVD menu sub-menus where different PGCs share the same VOB
    // but start at different sector positions.
    let use_stdin = opts.sector.is_some();

    tracing::info!(
        "Transcoding {} VOB file(s) to streaming fMP4 (ss={:?}, t={:?}, sector={:?})",
        vob_files.len(),
        opts.start_secs,
        opts.duration_secs,
        opts.sector,
    );

    let mut args: Vec<String> = Vec::new();

    // Input seeking (-ss before -i for fast seek)
    if let Some(ss) = opts.start_secs {
        args.extend(["-ss".to_string(), format!("{ss:.3}")]);
    }

    if use_stdin {
        // Read from stdin (we'll pipe VOB data from the sector offset)
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

    // If sector-based seeking, pipe VOB data from the byte offset to ffmpeg stdin.
    // Handles multi-VOB titlesets by finding which file contains the start sector
    // and reading across file boundaries.
    if let Some(sector) = opts.sector {
        let byte_offset = sector * 2048;
        let max_bytes: Option<u64> = opts.last_sector.map(|last| {
            (last - sector + 1) * 2048
        });
        let vob_paths: Vec<_> = vob_files.iter().map(|p| p.to_path_buf()).collect();
        let mut stdin = child.stdin.take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture ffmpeg stdin"))?;

        tracing::info!(
            "Piping {} VOB(s) from byte {byte_offset} (sector {sector}), max_bytes={:?}",
            vob_paths.len(), max_bytes,
        );

        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;

            // Find which VOB file contains the start offset and seek into it.
            // VOB files are logically concatenated, so we accumulate sizes.
            let mut cumulative: u64 = 0;
            let mut start_file_idx = 0;
            let mut offset_in_file = byte_offset;

            for (i, path) in vob_paths.iter().enumerate() {
                let meta = match tokio::fs::metadata(path).await {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::error!("Failed to stat VOB {}: {e}", path.display());
                        return;
                    }
                };
                let size = meta.len();
                if cumulative + size > byte_offset {
                    start_file_idx = i;
                    offset_in_file = byte_offset - cumulative;
                    break;
                }
                cumulative += size;
            }

            let mut buf = vec![0u8; 65536];
            let mut bytes_written: u64 = 0;

            for path in &vob_paths[start_file_idx..] {
                let mut file = match tokio::fs::File::open(path).await {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::error!("Failed to open VOB {}: {e}", path.display());
                        return;
                    }
                };
                // Seek into the first file; subsequent files start from 0
                if offset_in_file > 0 {
                    if let Err(e) = tokio::io::AsyncSeekExt::seek(
                        &mut file,
                        std::io::SeekFrom::Start(offset_in_file),
                    ).await {
                        tracing::error!("Failed to seek VOB: {e}");
                        return;
                    }
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
                                let _ = stdin.shutdown().await;
                                return;
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

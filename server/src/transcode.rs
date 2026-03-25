use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

/// Transcode options for extracting a specific segment.
#[derive(Default)]
pub struct TranscodeOpts {
    /// Start time in seconds (ffmpeg -ss)
    pub start_secs: Option<f64>,
    /// Duration in seconds (ffmpeg -t)
    pub duration_secs: Option<f64>,
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

    tracing::info!(
        "Transcoding {} VOB file(s) to streaming fMP4 (ss={:?}, t={:?})",
        vob_files.len(),
        opts.start_secs,
        opts.duration_secs,
    );

    let mut args: Vec<String> = Vec::new();

    // Input seeking (-ss before -i for fast seek)
    if let Some(ss) = opts.start_secs {
        args.extend(["-ss".to_string(), format!("{ss:.3}")]);
    }

    args.extend([
        "-y".to_string(),
        "-f".to_string(), "concat".to_string(),
        "-safe".to_string(), "0".to_string(),
        "-i".to_string(),
    ]);
    args.push(concat_file.path().to_string_lossy().to_string());

    // Duration limit
    if let Some(t) = opts.duration_secs {
        args.extend(["-t".to_string(), format!("{t:.3}")]);
    }

    args.extend([
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "fast".to_string(),
        "-crf".to_string(), "23".to_string(),
        "-c:a".to_string(), "aac".to_string(),
        "-b:a".to_string(), "192k".to_string(),
        "-ac".to_string(), "2".to_string(),
        "-movflags".to_string(), "+frag_keyframe+empty_moov".to_string(),
        "-f".to_string(), "mp4".to_string(),
        "pipe:1".to_string(),
    ]);

    let mut child = Command::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

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

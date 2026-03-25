use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;
use tokio_util::io::ReaderStream;

/// Spawn ffmpeg to transcode VOB files into H.264/AAC fMP4, returning a
/// streaming body. Playback can begin as soon as the first fragment arrives.
pub async fn transcode_to_stream(
    vob_files: &[&Path],
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
        "Transcoding {} VOB file(s) to streaming fMP4",
        vob_files.len()
    );

    let mut child = Command::new("ffmpeg")
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i",
        ])
        .arg(concat_file.path())
        .args([
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-movflags", "+frag_keyframe+empty_moov",
            "-f", "mp4",
            "pipe:1",
        ])
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

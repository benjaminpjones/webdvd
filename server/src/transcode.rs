use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

/// Transcode a list of VOB files into H.264/AAC MP4, returning the raw bytes.
/// Uses ffmpeg's concat demuxer to join multiple VOBs seamlessly.
pub async fn transcode_to_mp4(vob_files: &[&Path]) -> anyhow::Result<Vec<u8>> {
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
        "Transcoding {} VOB file(s) to MP4",
        vob_files.len()
    );

    let output = Command::new("ffmpeg")
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
            "-movflags", "+faststart+frag_keyframe+empty_moov",
            "-f", "mp4",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg failed: {}", stderr);
    }

    tracing::info!("Transcoded {} bytes", output.stdout.len());
    Ok(output.stdout)
}

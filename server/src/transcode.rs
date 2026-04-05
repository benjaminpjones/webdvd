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

/// Parse a NAV pack sector to extract DSI fields needed for ILVU navigation.
/// Returns (vobu_ea, vob_id, ilvu_flag, ilvu_ea) or None if the sector
/// doesn't look like a valid NAV pack.
#[cfg(any(has_dvdread, test))]
fn parse_nav_pack(sector_data: &[u8]) -> Option<(u32, u16, bool, u32)> {
    if sector_data.len() < 2048 {
        return None;
    }
    // DSI data starts at byte 0x407 in the NAV pack sector.
    // dsi_gi layout: nv_pck_scr(4) + nv_pck_lbn(4) + vobu_ea(4) +
    //   1stref_ea(4) + 2ndref_ea(4) + 3rdref_ea(4) + vobu_vob_idn(2)
    let dsi = 0x407;
    let vobu_ea = u32::from_be_bytes([
        sector_data[dsi + 8], sector_data[dsi + 9],
        sector_data[dsi + 10], sector_data[dsi + 11],
    ]);
    let vob_id = u16::from_be_bytes([
        sector_data[dsi + 24], sector_data[dsi + 25],
    ]);
    // sml_pbi starts at dsi + 32 (sizeof dsi_gi)
    let sml = dsi + 32;
    let category = u16::from_be_bytes([
        sector_data[sml], sector_data[sml + 1],
    ]);
    let ilvu_flag = (category >> 14) & 1 == 1;
    let ilvu_ea = u32::from_be_bytes([
        sector_data[sml + 2], sector_data[sml + 3],
        sector_data[sml + 4], sector_data[sml + 5],
    ]);
    Some((vobu_ea, vob_id, ilvu_flag, ilvu_ea))
}

/// Pipe VOB data through libdvdread (CSS-decrypted) to ffmpeg stdin.
///
/// Reads in chunks via a channel to avoid loading multi-GB title VOBs
/// into memory at once. Handles interleaved (ILVU) cells by reading
/// VOBU-by-VOBU and skipping alternate-angle data.
#[allow(unused_variables)] // sector/last_sector only used with dvdread
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

            // Read blocks in a blocking task, send chunks through a channel.
            // Uses VOBU-aware reading: for each VOBU, read its NAV pack first
            // to detect interleaved (ILVU) content. If interleaved, only send
            // VOBUs matching the target angle (determined by the vob_id of the
            // first VOBU). This prevents duplicate frames from alternate angles
            // (e.g. "Follow the White Rabbit" on The Matrix).
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);

            tokio::task::spawn_blocking(move || {
                let mut offset = start_block;
                // Target vob_id for ILVU filtering — set from the first
                // VOBU in each interleaved region.
                let mut target_vob_id: Option<u16> = None;
                let mut in_ilvu_region = false;
                let mut skipped_blocks: u64 = 0;

                while offset < end_block {
                    // Read the first sector (NAV pack) of this VOBU
                    let nav_data = match dvd_file.read_blocks(offset as u32, 1) {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::error!("DVDReadBlocks NAV error at block {offset}: {e}");
                            break;
                        }
                    };

                    let (vobu_ea, vob_id, ilvu_flag, _ilvu_ea) =
                        match parse_nav_pack(&nav_data) {
                            Some(v) => v,
                            None => {
                                // Not a valid NAV pack — read as bulk data
                                // (shouldn't happen in well-formed VOBs)
                                if tx.blocking_send(nav_data).is_err() { break; }
                                offset += 1;
                                continue;
                            }
                        };

                    let vobu_size = vobu_ea as u64 + 1; // vobu_ea is inclusive end offset
                    let vobu_end = (offset + vobu_size).min(end_block);

                    if ilvu_flag {
                        if !in_ilvu_region {
                            // Entering a new interleaved region — the first
                            // ILVU belongs to our angle. Set target vob_id.
                            target_vob_id = Some(vob_id);
                            in_ilvu_region = true;
                        }
                        // Skip VOBUs from the alternate angle
                        if Some(vob_id) != target_vob_id {
                            skipped_blocks += vobu_size;
                            offset = vobu_end;
                            continue;
                        }
                    } else {
                        // Non-ILVU VOBU — reset so we re-detect target
                        // if we enter another interleaved region later.
                        in_ilvu_region = false;
                    }

                    // Send the NAV pack we already read
                    if tx.blocking_send(nav_data).is_err() { break; }

                    // Read and send the rest of the VOBU (sectors after NAV pack)
                    if vobu_size > 1 {
                        let rest_count = (vobu_end - offset - 1) as u32;
                        if rest_count > 0 {
                            match dvd_file.read_blocks((offset + 1) as u32, rest_count) {
                                Ok(data) => {
                                    if tx.blocking_send(data).is_err() { break; }
                                }
                                Err(e) => {
                                    tracing::error!("DVDReadBlocks error at block {}: {e}", offset + 1);
                                    break;
                                }
                            }
                        }
                    }

                    offset = vobu_end;
                }

                if skipped_blocks > 0 {
                    tracing::info!(
                        "ILVU filtering: skipped {} blocks ({} MB) of alternate-angle data (target vob_id={:?})",
                        skipped_blocks,
                        skipped_blocks * 2048 / (1024 * 1024),
                        target_vob_id
                    );
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
        if let Some(max) = max_bytes
            && bytes_written >= max { break; }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic 2048-byte NAV pack sector with the given DSI fields.
    fn make_nav_sector(vobu_ea: u32, vob_id: u16, category: u16, ilvu_ea: u32) -> Vec<u8> {
        let mut sector = vec![0u8; 2048];
        let dsi = 0x407;
        // vobu_ea at dsi+8
        sector[dsi + 8..dsi + 12].copy_from_slice(&vobu_ea.to_be_bytes());
        // vob_id at dsi+24
        sector[dsi + 24..dsi + 26].copy_from_slice(&vob_id.to_be_bytes());
        // sml_pbi.category at dsi+32
        let sml = dsi + 32;
        sector[sml..sml + 2].copy_from_slice(&category.to_be_bytes());
        // sml_pbi.ilvu_ea at dsi+34
        sector[sml + 2..sml + 6].copy_from_slice(&ilvu_ea.to_be_bytes());
        sector
    }

    #[test]
    fn parse_nav_pack_non_ilvu() {
        let sector = make_nav_sector(157, 3, 0x0000, 0);
        let (vobu_ea, vob_id, ilvu_flag, ilvu_ea) = parse_nav_pack(&sector).unwrap();
        assert_eq!(vobu_ea, 157);
        assert_eq!(vob_id, 3);
        assert!(!ilvu_flag);
        assert_eq!(ilvu_ea, 0);
    }

    #[test]
    fn parse_nav_pack_ilvu_angle1() {
        // category 0x6000: ilvu_flag=1, first VOBU of ILVU
        let sector = make_nav_sector(171, 4, 0x6000, 489);
        let (vobu_ea, vob_id, ilvu_flag, ilvu_ea) = parse_nav_pack(&sector).unwrap();
        assert_eq!(vobu_ea, 171);
        assert_eq!(vob_id, 4);
        assert!(ilvu_flag);
        assert_eq!(ilvu_ea, 489);
    }

    #[test]
    fn parse_nav_pack_ilvu_angle2() {
        let sector = make_nav_sector(171, 5, 0x6000, 491);
        let (vobu_ea, vob_id, ilvu_flag, ilvu_ea) = parse_nav_pack(&sector).unwrap();
        assert_eq!(vobu_ea, 171);
        assert_eq!(vob_id, 5);
        assert!(ilvu_flag);
        assert_eq!(ilvu_ea, 491);
    }

    #[test]
    fn parse_nav_pack_ilvu_middle_and_last() {
        // 0x4000 = middle of ILVU, 0x5000 = last of ILVU — both have ilvu_flag set
        for cat in [0x4000u16, 0x5000] {
            let sector = make_nav_sector(155, 4, cat, 0);
            let (_vobu_ea, _vob_id, ilvu_flag, _ilvu_ea) = parse_nav_pack(&sector).unwrap();
            assert!(ilvu_flag, "category 0x{cat:04x} should have ilvu_flag set");
        }
    }

    #[test]
    fn parse_nav_pack_too_small() {
        let sector = vec![0u8; 1024];
        assert!(parse_nav_pack(&sector).is_none());
    }

    #[test]
    fn parse_nav_pack_real_matrix_values() {
        // Values observed from actual Matrix DVD Title 8 NAV packs
        let sector = make_nav_sector(171, 4, 0x6000, 489);
        let result = parse_nav_pack(&sector).unwrap();
        assert_eq!(result, (171, 4, true, 489));

        let sector2 = make_nav_sector(171, 5, 0x6000, 491);
        let result2 = parse_nav_pack(&sector2).unwrap();
        assert_eq!(result2, (171, 5, true, 491));
    }

    /// Simulate the ILVU filtering logic from pipe_dvdread using synthetic
    /// VOBU data. Verifies that alternate-angle VOBUs are skipped while
    /// non-ILVU and target-angle VOBUs pass through.
    #[test]
    fn ilvu_filtering_skips_alternate_angle() {
        // Simulates The Matrix Title 8 structure:
        //   VOBU 0: non-ILVU, vob_id=3  (Cell 1)
        //   VOBU 1: ILVU, vob_id=4      (Cell 2, angle 1)
        //   VOBU 2: ILVU, vob_id=5      (Cell 2, angle 2 — skip)
        //   VOBU 3: ILVU, vob_id=4      (Cell 2, angle 1)
        //   VOBU 4: ILVU, vob_id=5      (Cell 2, angle 2 — skip)
        //   VOBU 5: non-ILVU, vob_id=4  (Cell 3)
        let vobus: Vec<(u16, bool)> = vec![
            (3, false), (4, true), (5, true), (4, true), (5, true), (4, false),
        ];

        let sent = filter_vobus(&vobus);
        assert_eq!(sent, vec![3, 4, 4, 4]);
    }

    /// Verify that separate interleaved regions with different vob_ids
    /// each get their own target (non-ILVU gap resets target).
    #[test]
    fn ilvu_filtering_handles_region_transitions() {
        let vobus: Vec<(u16, bool)> = vec![
            (4, true), (5, true),   // Region 1: target=4
            (6, false),              // Gap resets
            (7, true), (8, true),   // Region 2: target=7
        ];

        let sent = filter_vobus(&vobus);
        assert_eq!(sent, vec![4, 6, 7]);
    }

    /// All non-ILVU VOBUs should pass through regardless of vob_id.
    #[test]
    fn ilvu_filtering_passes_all_non_ilvu() {
        let vobus: Vec<(u16, bool)> = vec![
            (1, false), (2, false), (3, false),
        ];

        let sent = filter_vobus(&vobus);
        assert_eq!(sent, vec![1, 2, 3]);
    }

    /// Helper: run the same filtering logic as pipe_dvdread on a list of
    /// (vob_id, ilvu_flag) pairs, returning the vob_ids that were sent.
    fn filter_vobus(vobus: &[(u16, bool)]) -> Vec<u16> {
        let mut sent: Vec<u16> = Vec::new();
        let mut target_vob_id: Option<u16> = None;
        let mut in_ilvu_region = false;

        for &(vob_id, ilvu) in vobus {
            if ilvu {
                if !in_ilvu_region {
                    target_vob_id = Some(vob_id);
                    in_ilvu_region = true;
                }
                if Some(vob_id) != target_vob_id {
                    continue;
                }
            } else {
                in_ilvu_region = false;
            }
            sent.push(vob_id);
        }
        sent
    }
}

//! FFI bindings and safe wrapper for libdvdread.
//!
//! Provides transparent CSS decryption when reading from encrypted DVDs.
//! Only compiled when `has_dvdread` cfg is set (libdvdread found by pkg-config).

#![cfg(has_dvdread)]

use std::ffi::CString;
use std::path::Path;
use std::ptr;

const DVD_VIDEO_LB_LEN: usize = 2048;

#[repr(C)]
#[allow(dead_code)]
#[derive(Clone, Copy)]
pub enum DvdReadDomain {
    InfoFile = 0,
    InfoBackupFile = 1,
    MenuVobs = 2,
    TitleVobs = 3,
}

// Opaque types from libdvdread
enum DvdReaderS {}
enum DvdFileS {}

type DvdReaderT = DvdReaderS;
type DvdFileT = DvdFileS;

unsafe extern "C" {
    fn DVDOpen(path: *const std::ffi::c_char) -> *mut DvdReaderT;
    fn DVDClose(dvd: *mut DvdReaderT);
    fn DVDOpenFile(
        dvd: *mut DvdReaderT,
        titlenum: std::ffi::c_int,
        domain: DvdReadDomain,
    ) -> *mut DvdFileT;
    fn DVDCloseFile(file: *mut DvdFileT);
    fn DVDFileSize(file: *mut DvdFileT) -> isize;
    fn DVDReadBytes(
        file: *mut DvdFileT,
        data: *mut std::ffi::c_void,
        bytes: usize,
    ) -> isize;
    fn DVDReadBlocks(
        file: *mut DvdFileT,
        offset: std::ffi::c_int,
        block_count: usize,
        data: *mut u8,
    ) -> isize;
}

/// Safe wrapper around a libdvdread handle.
///
/// Not `Send` — libdvdread is not thread-safe per handle.
/// Wrap in a `Mutex` for shared access.
pub struct DvdReader {
    handle: *mut DvdReaderT,
}

// Safety: DvdReader is not inherently Send, but we protect it with a Mutex
// and only access it from spawn_blocking. The pointer itself doesn't reference
// thread-local state.
unsafe impl Send for DvdReader {}

impl DvdReader {
    /// Open a DVD. `path` should be the disc mount point or the parent
    /// directory containing VIDEO_TS (not the VIDEO_TS directory itself).
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let c_path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| anyhow::anyhow!("Invalid path for DVDOpen"))?;

        let handle = unsafe { DVDOpen(c_path.as_ptr()) };
        if handle.is_null() {
            anyhow::bail!("DVDOpen failed for {}", path.display());
        }

        tracing::info!("Opened DVD via libdvdread: {}", path.display());
        Ok(Self { handle })
    }

    /// Read an entire file from the DVD.
    ///
    /// - `titlenum`: 0 for VIDEO_TS (VMGM), N for VTS_N
    /// - `domain`: which file type to read
    ///
    /// For IFO/BUP files, uses DVDReadBytes (byte-level reads).
    /// For VOB files, uses DVDReadBlocks (block-level reads with CSS decryption).
    pub fn read_file(&self, titlenum: i32, domain: DvdReadDomain) -> anyhow::Result<Vec<u8>> {
        let is_vob = matches!(domain, DvdReadDomain::MenuVobs | DvdReadDomain::TitleVobs);

        let file = unsafe { DVDOpenFile(self.handle, titlenum as _, domain) };
        if file.is_null() {
            anyhow::bail!("DVDOpenFile failed (titlenum={titlenum})");
        }

        let size_blocks = unsafe { DVDFileSize(file) };
        if size_blocks < 0 {
            unsafe { DVDCloseFile(file) };
            anyhow::bail!("DVDFileSize failed (titlenum={titlenum})");
        }

        let total_bytes = size_blocks as usize * DVD_VIDEO_LB_LEN;
        let mut buf = vec![0u8; total_bytes];

        let bytes_read = if is_vob {
            // Block-level read — provides CSS decryption
            let blocks = unsafe {
                DVDReadBlocks(file, 0, size_blocks as usize, buf.as_mut_ptr())
            };
            if blocks < 0 {
                unsafe { DVDCloseFile(file) };
                anyhow::bail!("DVDReadBlocks failed (titlenum={titlenum})");
            }
            blocks as usize * DVD_VIDEO_LB_LEN
        } else {
            // Byte-level read for IFO/BUP files
            let n = unsafe {
                DVDReadBytes(file, buf.as_mut_ptr() as *mut _, total_bytes)
            };
            if n < 0 {
                unsafe { DVDCloseFile(file) };
                anyhow::bail!("DVDReadBytes failed (titlenum={titlenum})");
            }
            n as usize
        };

        unsafe { DVDCloseFile(file) };
        buf.truncate(bytes_read);
        Ok(buf)
    }

    /// Get the size of a DVD file in bytes.
    pub fn file_size(&self, titlenum: i32, domain: DvdReadDomain) -> anyhow::Result<u64> {
        let file = unsafe { DVDOpenFile(self.handle, titlenum as _, domain) };
        if file.is_null() {
            anyhow::bail!("DVDOpenFile failed (titlenum={titlenum})");
        }
        let size_blocks = unsafe { DVDFileSize(file) };
        unsafe { DVDCloseFile(file) };
        if size_blocks < 0 {
            anyhow::bail!("DVDFileSize failed (titlenum={titlenum})");
        }
        Ok(size_blocks as u64 * DVD_VIDEO_LB_LEN as u64)
    }

    /// Read VOB blocks from the DVD with sector-based seeking.
    ///
    /// Reads `block_count` blocks starting at `start_block` offset within
    /// the file. Used for transcoding where we need a specific sector range.
    pub fn read_vob_blocks(
        &self,
        titlenum: i32,
        domain: DvdReadDomain,
        start_block: u32,
        block_count: u32,
    ) -> anyhow::Result<Vec<u8>> {
        let file = unsafe { DVDOpenFile(self.handle, titlenum as _, domain) };
        if file.is_null() {
            anyhow::bail!("DVDOpenFile failed (titlenum={titlenum})");
        }

        let mut buf = vec![0u8; block_count as usize * DVD_VIDEO_LB_LEN];
        let blocks = unsafe {
            DVDReadBlocks(file, start_block as _, block_count as usize, buf.as_mut_ptr())
        };
        unsafe { DVDCloseFile(file) };

        if blocks < 0 {
            anyhow::bail!("DVDReadBlocks failed (titlenum={titlenum}, offset={start_block})");
        }

        buf.truncate(blocks as usize * DVD_VIDEO_LB_LEN);
        Ok(buf)
    }
}

/// Handle to an open DVD file for chunked block reads.
/// Must be used from a single thread (not Send).
pub struct DvdFile {
    file: *mut DvdFileT,
    total_blocks: usize,
}

impl DvdFile {
    pub fn total_blocks(&self) -> usize {
        self.total_blocks
    }

    /// Read `block_count` blocks starting at `offset`. Returns the data read.
    pub fn read_blocks(&self, offset: u32, block_count: u32) -> anyhow::Result<Vec<u8>> {
        let mut buf = vec![0u8; block_count as usize * DVD_VIDEO_LB_LEN];
        let blocks = unsafe {
            DVDReadBlocks(self.file, offset as _, block_count as usize, buf.as_mut_ptr())
        };
        if blocks < 0 {
            anyhow::bail!("DVDReadBlocks failed (offset={offset}, count={block_count})");
        }
        buf.truncate(blocks as usize * DVD_VIDEO_LB_LEN);
        Ok(buf)
    }
}

impl Drop for DvdFile {
    fn drop(&mut self) {
        if !self.file.is_null() {
            unsafe { DVDCloseFile(self.file) };
        }
    }
}

// Safety: same reasoning as DvdReader — protected by Mutex
unsafe impl Send for DvdFile {}

impl DvdReader {
    /// Open a DVD file for chunked reading. Returns a handle that can
    /// read blocks incrementally without loading the entire file.
    pub fn open_file(&self, titlenum: i32, domain: DvdReadDomain) -> anyhow::Result<DvdFile> {
        let file = unsafe { DVDOpenFile(self.handle, titlenum as _, domain) };
        if file.is_null() {
            anyhow::bail!("DVDOpenFile failed (titlenum={titlenum})");
        }
        let size = unsafe { DVDFileSize(file) };
        if size < 0 {
            unsafe { DVDCloseFile(file) };
            anyhow::bail!("DVDFileSize failed (titlenum={titlenum})");
        }
        Ok(DvdFile { file, total_blocks: size as usize })
    }
}

impl Drop for DvdReader {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { DVDClose(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

/// Parse a DVD filename into (titlenum, domain).
///
/// Examples:
/// - "VIDEO_TS.IFO" → (0, InfoFile)
/// - "VIDEO_TS.BUP" → (0, InfoBackupFile)
/// - "VIDEO_TS.VOB" → (0, MenuVobs)
/// - "VTS_02_0.IFO" → (2, InfoFile)
/// - "VTS_02_0.BUP" → (2, InfoBackupFile)
/// - "VTS_02_0.VOB" → (2, MenuVobs)
/// - "VTS_02_1.VOB" → (2, TitleVobs)
pub fn parse_dvd_filename(filename: &str) -> Option<(i32, DvdReadDomain)> {
    let upper = filename.to_uppercase();

    if upper == "VIDEO_TS.IFO" {
        return Some((0, DvdReadDomain::InfoFile));
    }
    if upper == "VIDEO_TS.BUP" {
        return Some((0, DvdReadDomain::InfoBackupFile));
    }
    if upper == "VIDEO_TS.VOB" {
        return Some((0, DvdReadDomain::MenuVobs));
    }

    // VTS_NN_X.EXT
    let parts: Vec<&str> = upper.strip_prefix("VTS_")?.splitn(3, '_').collect();
    if parts.len() < 2 {
        return None;
    }
    let titlenum: i32 = parts[0].parse().ok()?;

    // parts[1] is like "0.IFO", "0.VOB", "1.VOB"
    let (num_str, ext) = parts[1].split_once('.')?;
    let file_num: i32 = num_str.parse().ok()?;

    let domain = match (ext, file_num) {
        ("IFO", _) => DvdReadDomain::InfoFile,
        ("BUP", _) => DvdReadDomain::InfoBackupFile,
        ("VOB", 0) => DvdReadDomain::MenuVobs,
        ("VOB", _) => DvdReadDomain::TitleVobs,
        _ => return None,
    };

    Some((titlenum, domain))
}

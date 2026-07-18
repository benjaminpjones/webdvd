mod api;
mod auth;
mod cache;
mod disc;
#[cfg(has_dvdread)]
mod dvdread;
mod library;
mod transcode;

use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Parser)]
#[command(name = "webdvd", about = "Web-based DVD player server")]
struct Args {
    /// Path to DVD library root (contains folders with VIDEO_TS subdirectories)
    root: PathBuf,

    /// Port to listen on
    #[arg(short, long, default_value = "3000")]
    port: u16,

    /// Directory to store transcoded segments. Defaults to <root>/.cache/.
    #[arg(long)]
    cache_dir: Option<PathBuf>,

    /// Maximum number of ffmpeg processes running concurrently. Requests
    /// beyond this cap wait up to --transcode-queue-timeout-secs then 503.
    /// Cache hits bypass this limit entirely.
    #[arg(long, default_value = "2")]
    max_concurrent_transcodes: usize,

    /// Seconds a transcode request will wait for a semaphore slot before
    /// returning 503 Service Unavailable.
    #[arg(long, default_value = "30")]
    transcode_queue_timeout_secs: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub library: Arc<library::Library>,
    pub cache: Arc<cache::Cache>,
    pub auth: Arc<auth::Auth>,
    pub transcode_limit: Arc<Semaphore>,
    pub transcode_queue_timeout: std::time::Duration,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let lib = library::Library::scan(&args.root)?;
    tracing::info!(
        "Opened library at {} ({} disc(s))",
        args.root.display(),
        lib.discs.len(),
    );
    for (slug, disc) in &lib.discs {
        tracing::info!(
            "  {} — {} VTS, {} VOBs",
            slug,
            disc.vts_count(),
            disc.vob_count(),
        );
    }

    let cache_dir = args.cache_dir.unwrap_or_else(|| args.root.join(".cache"));
    std::fs::create_dir_all(&cache_dir)?;
    tracing::info!("Transcode cache at {}", cache_dir.display());

    let cache = cache::Cache::new(cache_dir);
    // Drop cache dirs from earlier schema versions (e.g. after a codec change
    // bumped SCHEMA_VERSION) so a deploy self-cleans stale, now-unservable
    // transcodes instead of leaving them to waste disk.
    cache.prune_stale_schemas();

    if args.max_concurrent_transcodes == 0 {
        anyhow::bail!("--max-concurrent-transcodes must be at least 1");
    }
    tracing::info!(
        "Concurrent transcode cap: {} (queue timeout: {}s)",
        args.max_concurrent_transcodes,
        args.transcode_queue_timeout_secs,
    );

    let state = AppState {
        library: Arc::new(lib),
        cache: Arc::new(cache),
        auth: Arc::new(auth::Auth::from_env()),
        transcode_limit: Arc::new(Semaphore::new(args.max_concurrent_transcodes)),
        transcode_queue_timeout: std::time::Duration::from_secs(args.transcode_queue_timeout_secs),
    };

    let app = api::router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

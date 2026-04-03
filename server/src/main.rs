mod api;
mod disc;
#[cfg(has_dvdread)]
mod dvdread;
mod transcode;

use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "webdvd", about = "Web-based DVD player server")]
struct Args {
    /// Path to VIDEO_TS directory
    video_ts: PathBuf,

    /// Port to listen on
    #[arg(short, long, default_value = "3000")]
    port: u16,
}

#[derive(Clone)]
pub struct AppState {
    pub disc: Arc<disc::Disc>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let disc = disc::Disc::open(&args.video_ts)?;
    tracing::info!(
        "Opened VIDEO_TS at {} ({} VTS files, {} VOB files)",
        args.video_ts.display(),
        disc.vts_count(),
        disc.vob_count(),
    );

    let state = AppState {
        disc: Arc::new(disc),
    };

    let app = api::router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

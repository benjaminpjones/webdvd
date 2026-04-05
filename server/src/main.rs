mod api;
mod disc;
#[cfg(has_dvdread)]
mod dvdread;
mod library;
mod transcode;

use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "webdvd", about = "Web-based DVD player server")]
struct Args {
    /// Path to DVD library root (contains folders with VIDEO_TS subdirectories)
    root: PathBuf,

    /// Port to listen on
    #[arg(short, long, default_value = "3000")]
    port: u16,
}

#[derive(Clone)]
pub struct AppState {
    pub library: Arc<library::Library>,
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

    let state = AppState {
        library: Arc::new(lib),
    };

    let app = api::router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

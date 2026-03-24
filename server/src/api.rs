use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
};
use tower_http::cors::CorsLayer;

use crate::{AppState, transcode};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/disc", get(disc_info))
        .route("/api/transcode/{titleset}", get(transcode_titleset))
        .route("/api/ifo-list", get(ifo_list))
        .route("/api/ifo/{filename}", get(ifo_file))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn disc_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    let titlesets = state.disc.titlesets();
    Json(serde_json::json!({
        "path": state.disc.path.display().to_string(),
        "titlesets": titlesets,
        "vob_count": state.disc.vob_count(),
    }))
}

async fn ifo_list(State(state): State<AppState>) -> Json<Vec<String>> {
    Json(state.disc.ifo_files())
}

async fn ifo_file(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let path = state
        .disc
        .video_ts_file(&filename)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("File not found: {filename}")))?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    ))
}

async fn transcode_titleset(
    State(state): State<AppState>,
    Path(titleset): Path<u32>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let vobs = state.disc.vobs_for_titleset(titleset);
    if vobs.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("No VOBs found for title set {titleset}"),
        ));
    }

    let mp4_bytes = transcode::transcode_to_mp4(&vobs)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "video/mp4")],
        mp4_bytes,
    ))
}
